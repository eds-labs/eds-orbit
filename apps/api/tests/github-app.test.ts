import { afterEach, describe, expect, it } from "vitest";
import {
  createPrivateKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import {
  getRepository,
  githubAppConnectionProvider,
  githubAppJwt,
  githubFetch,
  GithubSendError,
  installationRepositories,
  installationToken,
  normalizePem,
  parseGithubAppSecret,
  setGithubFetchForTests,
  type GithubAppSecret,
} from "../src/platform/connections/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const app: GithubAppSecret = {
  appId: "123",
  appSlug: "orbit-issues",
  installationId: "456",
  privateKey: pem,
};

type Recorded = { url: string; init: RequestInit };
function transport(
  respond: (call: Recorded, index: number) => Response | Promise<Response>,
) {
  const calls: Recorded[] = [];
  setGithubFetchForTests(async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as GithubSendError;
  }
  throw new Error("expected a failure");
};

afterEach(() => setGithubFetchForTests(null));

describe("GitHub App client", () => {
  it("normalizePem restores a flattened key", () => {
    const flat = pem.trim().replaceAll("\n", " ");
    const literal = pem.trim().replaceAll("\n", "\\n");
    for (const raw of [flat, literal, pem]) {
      const fixed = normalizePem(raw);
      expect(
        createPrivateKey(fixed).export({ type: "pkcs8", format: "pem" }),
      ).toBe(pem);
    }
  });

  it("parseGithubAppSecret refuses missing fields and non-JSON without leaking the key", () => {
    const bad = [
      "not json",
      JSON.stringify({ appId: "1", appSlug: "x", installationId: "2" }),
      JSON.stringify({ ...app, appId: "abc" }),
      JSON.stringify({ ...app, appSlug: "Bad Slug" }),
    ];
    for (const raw of bad) {
      try {
        parseGithubAppSecret(raw);
        throw new Error("should have failed");
      } catch (error: any) {
        expect(error.code).toBe("GITHUB_APP_INVALID");
        expect(error.status).toBe(409);
        expect(error.message).not.toContain("BEGIN");
      }
    }
    const ok = parseGithubAppSecret(
      JSON.stringify({ ...app, privateKey: pem.trim().replaceAll("\n", " ") }),
    );
    expect(ok.privateKey).toBe(pem);
  });

  it("githubAppJwt signs RS256 with iat -60 s and exp +9 min, iss = appId", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    const jwt = githubAppJwt(app, now);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const t = Math.floor(now.getTime() / 1000);
    expect(claims).toEqual({ iat: t - 60, exp: t + 540, iss: "123" });
    const verify = createVerify("RSA-SHA256").update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("installationToken asks for exactly one repository and the given permissions", async () => {
    const calls = transport(() => json({ token: "ghs_x" }, 201));
    const token = await installationToken(app, {
      repositories: ["web"],
      permissions: { issues: "write", metadata: "read" },
    });
    expect(token).toBe("ghs_x");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(
      '{"repositories":["web"],"permissions":{"issues":"write","metadata":"read"}}',
    );
    const auth = (call.init.headers as Record<string, string>).Authorization!;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("githubFetch maps statuses and sets safe request options", async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "GITHUB_RECONNECT_REQUIRED", false],
      [404, "GITHUB_RECONNECT_REQUIRED", false],
      [410, "GITHUB_RECONNECT_REQUIRED", false],
      [403, "GITHUB_ACCESS_OR_RATE_LIMIT", false],
      [429, "GITHUB_ACCESS_OR_RATE_LIMIT", false],
      [422, "GITHUB_VALIDATION_FAILED", false],
      [503, "GITHUB_UNAVAILABLE", true],
    ];
    for (const [status, code, sent] of cases) {
      const calls = transport(() => json({ message: "x" }, status));
      const error = await codeOf(githubFetch("/repos/o/r", "t"));
      expect(error.code).toBe(code);
      expect(error.status).toBe(409);
      expect(error.sent).toBe(sent);
      expect(calls[0]!.init.redirect).toBe("error");
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["X-GitHub-Api-Version"]).toBe("2026-03-10");
      expect(headers.Authorization).toBe("Bearer t");
      expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    }
    transport(() => {
      throw new Error("socket hang up");
    });
    const network = await codeOf(githubFetch("/repos/o/r", "t"));
    expect(network.code).toBe("GITHUB_UNAVAILABLE");
    expect(network.sent).toBe(true);

    transport(() => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    expect((await codeOf(githubFetch("/repos/o/r", "t"))).code).toBe(
      "GITHUB_RESPONSE_TOO_LARGE",
    );
    transport(() => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    expect(await githubFetch("/repos/o/r", "t")).toEqual({ a: 1 });
  });

  it("githubFetch refuses paths that are not API paths before any transport call", async () => {
    const calls = transport(() => json({}));
    for (const path of ["https://evil.example/x", "//evil", "repos/o/r", "/a b"]) {
      const error = await codeOf(githubFetch(path, "t"));
      expect(error.sent).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("getRepository uses a one-repo read token", async () => {
    const calls = transport((_c, i) =>
      i === 0
        ? json({ token: "tok" }, 201)
        : json({ full_name: "o/web", private: true, archived: false }),
    );
    expect(await getRepository(app, "o/web")).toEqual({
      fullName: "o/web",
      private: true,
      archived: false,
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      repositories: ["web"],
      permissions: { issues: "read", metadata: "read" },
    });
    expect(calls[1]!.url).toBe("https://api.github.com/repos/o/web");
    await expect(getRepository(app, "bad")).rejects.toMatchObject({
      code: "GITHUB_VALIDATION_FAILED",
    });
  });

  it("installationRepositories pages with a metadata-only token and caps at 500", async () => {
    const page = (n: number) => ({
      total_count: 900,
      repositories: Array.from({ length: 100 }, (_, i) => ({
        full_name: `o/r${n}-${i}`,
        private: false,
        archived: false,
      })),
    });
    const calls = transport((call, i) => {
      if (i === 0) return json({ token: "tok" }, 201);
      const n = Number(new URL(call.url).searchParams.get("page"));
      return json(page(n));
    });
    const repos = await installationRepositories(app);
    expect(repos).toHaveLength(500);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      permissions: { metadata: "read" },
    });
    expect(calls).toHaveLength(6);
    expect(calls[1]!.url).toContain("/installation/repositories?per_page=100&page=1");
  });

  it("check reports read_verified with the account login", async () => {
    const calls = transport(() => json({ account: { login: "acme" } }));
    const result = await githubAppConnectionProvider.check!(
      { baseUrl: "" },
      JSON.stringify(app),
    );
    expect(result).toEqual({
      status: "read_verified",
      capabilities: ["github_issues"],
      account: "acme",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/456");
    expect(githubAppConnectionProvider.purposes).toEqual(["issues"]);
    expect(githubAppConnectionProvider.scopes).toEqual(["system", "workspace"]);
  });

  it("maps an oversized real-transport answer to GITHUB_RESPONSE_TOO_LARGE", async () => {
    for (const [method, sent] of [["GET", false], ["POST", true]] as const) {
      transport(() => {
        throw new ConnectorError("RESPONSE_TOO_LARGE", method === "GET" ? "not_sent" : "unknown");
      });
      const error = await codeOf(githubFetch("/repos/o/r", "t", { method }));
      expect(error.code).toBe("GITHUB_RESPONSE_TOO_LARGE");
      expect(error.sent).toBe(sent);
    }
  });

  it("installationToken refuses anything but exactly one valid repository", async () => {
    const calls = transport(() => json({ token: "x" }, 201));
    for (const repositories of [[], ["a", "b"], [".."], ["."], ["a/b"], [""]]) {
      await expect(
        installationToken(app, {
          repositories: repositories as unknown as [string],
          permissions: { issues: "read" },
        }),
      ).rejects.toMatchObject({ code: "GITHUB_APP_INVALID" });
    }
    await expect(getRepository(app, "o/..")).rejects.toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

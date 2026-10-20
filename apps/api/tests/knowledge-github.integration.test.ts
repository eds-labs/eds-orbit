import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { knowledgeDraft } from "../../../packages/schemas/src/knowledge-workspace.ts";
import {
  configureGithub,
  beginGithub,
  finishGithub,
  githubStatus,
  githubRepositories,
  readRepository,
  allowedRepositoryPath,
  containsCredentials,
} from "../src/modules/knowledge/github.ts";
import { data, list } from "../src/shared.ts";
const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)("GitHub App knowledge sources", () => {
  let s: Scope;
  let w: string;
  let u: string;
  const fetcher = vi.fn();
  const json = (value: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const commit = "a".repeat(40);
  let privateKey: string;
  const repo = {
    id: 42,
    full_name: "synthetic/familyplan",
    default_branch: "main",
    private: true,
  };
  beforeAll(async () => {
    u = randomUUID();
    await authDb.user.create({
      data: {
        id: u,
        name: "Synthetic GitHub owner",
        email: `${u}@example.invalid`,
      },
    });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic Github",
        members: { create: { userId: u, role: "owner" } },
      },
    });
    w = workspace.id;
    privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  });
  beforeEach(async () => {
    const p = await authDb.project.create({
      data: { workspaceId: w, name: "Synthetic Github" },
    });
    s = { workspaceId: w, projectId: p.id, userId: u, role: "owner" };
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
    await configureGithub(s, {
      appId: "123",
      slug: "synthetic-app",
      clientId: "synthetic-client-id",
      clientSecret: "synthetic-client-secret",
      privateKey,
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: w } });
    await authDb.user.delete({ where: { id: u } });
    await closeDatabase();
  });
  async function connect() {
    const begin = await beginGithub(s);
    fetcher.mockImplementation((url: string) =>
      url.includes("access_token")
        ? json({ access_token: "synthetic-user-token" })
        : json({ installations: [{ id: 7, account: { login: "synthetic" } }] }),
    );
    await finishGithub(
      s,
      new URL(begin.url).searchParams.get("state")!,
      "synthetic-code",
    );
    const status = await githubStatus(s);
    return status.connections[0]!.id;
  }
  it("encrypts app credentials and never returns them in connection status", async () => {
    const c = await scoped(w, s.projectId, (tx) =>
      list(tx, s, "knowledge_github_config"),
    );
    expect(data(c[0]).encryptedCredential).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(await githubStatus(s))).not.toContain(
      "synthetic-client-secret",
    );
  });
  it("rejects a forged state before contacting GitHub", async () => {
    await expect(finishGithub(s, "forged-state", "code")).rejects.toThrow(
      "GITHUB_STATE_INVALID",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("consumes OAuth state once and binds it to the current owner", async () => {
    const b = await beginGithub(s);
    const state = new URL(b.url).searchParams.get("state")!;
    fetcher.mockImplementation((url: string) =>
      url.includes("access_token")
        ? json({ access_token: "synthetic-user-token" })
        : json({ installations: [] }),
    );
    await finishGithub(s, state, "synthetic-code");
    await expect(finishGithub(s, state, "synthetic-code")).rejects.toThrow(
      "GITHUB_STATE_INVALID",
    );
  });
  it("prevents cross-project OAuth state and installation reuse", async () => {
    const b = await beginGithub(s);
    const connectionId = await connect();
    const p = await authDb.project.create({
      data: { workspaceId: w, name: "Other" },
    });
    const other = { ...s, projectId: p.id };
    await configureGithub(other, {
      appId: "123",
      slug: "synthetic-app",
      clientId: "synthetic-client-id",
      clientSecret: "synthetic-client-secret",
      privateKey,
    });
    await expect(
      finishGithub(other, new URL(b.url).searchParams.get("state")!, "code"),
    ).rejects.toThrow("GITHUB_STATE_INVALID");
    await expect(githubRepositories(other, connectionId)).rejects.toThrow(
      "NOT_FOUND",
    );
  });
  it("rechecks user repository access and scopes the installation token to one repository", async () => {
    const connectionId = await connect();
    fetcher.mockClear();
    fetcher.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/user/installations/"))
        return json({ repositories: [repo] });
      if (url.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [42],
          permissions: { contents: "read", metadata: "read" },
        });
        return json({ token: "synthetic-install-token" });
      }
      if (url.includes("/commits/")) return json({ sha: commit });
      if (url.includes("/git/trees/"))
        return json({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", sha: "blob1", size: 30 },
            { path: ".env", type: "blob", sha: "secret", size: 20 },
            {
              path: "node_modules/x.md",
              type: "blob",
              sha: "dependency",
              size: 10,
            },
          ],
        });
      if (url.endsWith("/git/blobs/blob1"))
        return json({
          content: Buffer.from("Shared family calendars.").toString("base64"),
          encoding: "base64",
        });
      throw new Error("Unexpected synthetic request");
    });
    const result = await readRepository(
      s,
      knowledgeDraft.parse({
        name: "Family",
        kind: "github",
        connectionId,
        repositoryId: 42,
        repository: repo.full_name,
        paths: ["README.md", "node_modules/", ".env"],
      }),
    );
    expect(result.commit).toBe(commit);
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes(`/git/trees/${commit}`),
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).endsWith("/git/blobs/secret"),
      ),
    ).toBe(false);
  });
  it("does not accept a repository id or name missing from the authenticated user's installation", async () => {
    const connectionId = await connect();
    fetcher.mockImplementation(() => json({ repositories: [] }));
    await expect(
      readRepository(
        s,
        knowledgeDraft.parse({
          name: "Family",
          kind: "github",
          connectionId,
          repositoryId: 42,
          repository: repo.full_name,
        }),
      ),
    ).rejects.toThrow("GITHUB_REPOSITORY_FORBIDDEN");
  });
  it("returns an explicit partial scan and excludes credentials from file bodies", async () => {
    const connectionId = await connect();
    fetcher.mockImplementation((url: string) => {
      if (url.includes("/user/installations/"))
        return json({ repositories: [repo] });
      if (url.endsWith("/access_tokens"))
        return json({ token: "synthetic-install-token" });
      if (url.includes("/commits/")) return json({ sha: commit });
      if (url.includes("/git/trees/"))
        return json({
          truncated: true,
          tree: [
            { path: "docs/settings.md", type: "blob", sha: "bad", size: 100 },
            { path: "docs/large.md", type: "blob", sha: "large", size: 200000 },
          ],
        });
      return json({
        content: Buffer.from('password = "synthetic-password"').toString(
          "base64",
        ),
        encoding: "base64",
      });
    });
    const result = await readRepository(
      s,
      knowledgeDraft.parse({
        name: "Family",
        kind: "github",
        connectionId,
        repositoryId: 42,
        repository: repo.full_name,
      }),
    );
    expect(result.partial).toBe(true);
    expect(result.skipped).toBe(2);
    expect(result.files).toHaveLength(0);
  });
  it("reports revoked access and rate limits without provider response contents", async () => {
    const id = await connect();
    fetcher.mockImplementation(() =>
      json({ message: "sensitive remote text" }, 401),
    );
    await expect(githubRepositories(s, id)).rejects.toThrow(
      "GITHUB_RECONNECT_REQUIRED",
    );
    fetcher.mockImplementation(() => json({}, 429));
    await expect(githubRepositories(s, id)).rejects.toThrow(
      "GITHUB_ACCESS_OR_RATE_LIMIT",
    );
  });
});
describe("repository selection safety", () => {
  it.each([
    ".env",
    "apps/web/.env.local",
    "node_modules/README.md",
    "dist/main.ts",
    "private-key.pem",
    "docs/../README.md",
    "docs/credentials.json",
  ])("excludes %s", (path) =>
    expect(
      allowedRepositoryPath(path, [
        "docs/",
        "apps/",
        "node_modules/",
        "dist/",
        path,
      ]),
    ).toBe(false),
  );
  it("includes selected documentation and code only", () => {
    expect(allowedRepositoryPath("README.md", ["README.md"])).toBe(true);
    expect(allowedRepositoryPath("apps/ios/Main.swift", ["apps/ios/"])).toBe(
      true,
    );
    expect(allowedRepositoryPath("apps/android/Main.kt", ["apps/ios/"])).toBe(
      false,
    );
    expect(containsCredentials('client_secret = "synthetic-secret"')).toBe(
      true,
    );
  });
});

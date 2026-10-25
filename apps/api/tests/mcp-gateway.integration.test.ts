import { spawn } from "node:child_process";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { registeredRegistry } from "../src/platform/modules/contributions.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../src/platform/mcp-auth/plugins.ts";
import type { McpCallRecord } from "../src/platform/mcp/adapter.ts";
import { withToolTimeout } from "../src/platform/mcp/adapter.ts";
import {
  nativeTools,
  orbitProjects,
  type NativeTool,
  type NativeToolContext,
} from "../src/platform/mcp/native-tools.ts";
import { buildMcpServer, mcpClientIp } from "../src/platform/mcp/server.ts";
import { mcpToolsNeedActivationRows } from "../src/platform/mcp/visibility.ts";
import {
  suggestTask,
  taskDigest,
  tasksFixture,
} from "./fixtures/modules/tasks/contributions.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  jwtPayload,
  metadata,
  origin,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M2, Task 3: the MCP gateway process (platform/mcp/server.ts)
// with real WP-M1 access tokens. The API app runs the OAuth flow (inject)
// and serves the JWKS on a loopback port; the gateway verifies tokens with
// requireMcpAuth against it. Only the fixture tools (tasks module) are
// exposed; no production tool opts into MCP.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const META = "io.modelcontextprotocol/";
const ISSUER = `${origin}/api/auth`;
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
const CHALLENGE = `Bearer resource_metadata="${new URL(origin).origin}${PRM_PATH}"`;

const clientUrl = (name: string) => `https://client.test/gateway-${name}.json`;
const names = [
  "editor-one",
  "editor-two",
  "viewer",
  "revoke",
  "legacy",
] as const;
const CLIENT = Object.fromEntries(
  names.map((n) => [n, clientUrl(n)]),
) as Record<(typeof names)[number], string>;
const cimdFetch = cimdFetchFor(
  Object.fromEntries(Object.values(CLIENT).map((id) => [id, metadata(id)])),
);

const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;
type FlagKey =
  | keyof typeof FLAGS
  | "ORBIT_MCP_ALLOWED_ORIGINS"
  | "MCP_JWKS_URL"
  | "MCP_RESOURCE";

/** Sets env keys for `run`, then restores them. */
async function withEnv<T>(
  values: Partial<Record<FlagKey, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(values) as FlagKey[];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

/** Reads a JSON body or the single `data:` frame of a request-scoped SSE body. */
function rpcBody(response: {
  body: string;
  headers: Record<string, unknown>;
}): Json {
  if (response.body === "") return {};
  if (
    String(response.headers["content-type"]).startsWith("text/event-stream")
  ) {
    const frames = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Json);
    expect(frames).toHaveLength(1);
    return frames[0]!;
  }
  return JSON.parse(response.body) as Json;
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });

describe.skipIf(!enabled)("MCP gateway: flag off", () => {
  it("buildMcpServer throws while ORBIT_MCP_GATEWAY is off", async () => {
    await withEnv(
      { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_GATEWAY: "false" },
      async () => {
        await expect(buildMcpServer()).rejects.toThrow(
          /MCP gateway disabled: set ORBIT_MCP_GATEWAY/,
        );
      },
    );
    await withEnv(
      { ORBIT_MCP_OAUTH: "false", ORBIT_MCP_GATEWAY: "true" },
      async () => {
        await expect(buildMcpServer()).rejects.toThrow(/ORBIT_MCP_OAUTH/);
      },
    );
  });
  // mcp-main.ts with a flag off serves a health-only app (D-M5-1); see
  // mcp-gateway-disabled.unit.test.ts.
});

describe.skipIf(!enabled)("MCP gateway", () => {
  let api: Awaited<ReturnType<typeof buildServer>>;
  let gateway: FastifyInstance;
  let auth: ReturnType<typeof makeAuth>;
  let config: ReturnType<typeof loadConfig>;
  let jwksUrl = "";
  let cookie = "";
  let selection: { workspaceId: string; projectIds: string[] } = {
    workspaceId: "",
    projectIds: [],
  };
  const cookies = {} as Record<"editor" | "viewer", string>;
  const ids = {} as Record<"owner" | "editor" | "viewer", string>;
  const users: string[] = [];
  let workspaceId = "";
  let projectA = "";
  let projectB = "";
  const tokens = {} as Record<(typeof names)[number], string>;

  const driver = createFlowDriver({
    app: () => api,
    config: () => config,
    cookie: () => cookie,
    selection: () => selection,
    defaultClientId: CLIENT["editor-one"],
  });

  /** Connects `who` as `clientId` for the given projects; returns the access token. */
  async function tokenFor(
    who: "editor" | "viewer",
    clientId: string,
    projectIds: string[],
  ) {
    cookie = cookies[who];
    selection = { workspaceId, projectIds };
    const flow = await driver.connect({ clientId });
    const response = await driver.exchange(flow, { client_id: clientId });
    expect(response.statusCode).toBe(200);
    return (response.json() as Json).access_token as string;
  }

  type McpOptions = {
    token?: string | null;
    headers?: Record<string, string>;
    id?: number;
    app?: FastifyInstance;
    /** Request path; default "/mcp" (the endpoint is also served at "/"). */
    url?: string;
  };
  /** A 2026-07-28 request to the gateway. */
  function mcp(method: string, params: Json = {}, opts: McpOptions = {}) {
    const token = opts.token === undefined ? tokens["editor-one"] : opts.token;
    return (opts.app ?? gateway).inject({
      method: "POST",
      url: opts.url ?? "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: opts.id ?? 1,
        method,
        params: {
          ...params,
          _meta: {
            [`${META}protocolVersion`]: MODERN,
            [`${META}clientInfo`]: { name: "gateway-test", version: "1" },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
    });
  }
  /** A 2025-era request (no envelope, SSE answers). */
  function legacy(method: string, params: Json, token: string) {
    return gateway.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(method === "initialize" ? {} : { "mcp-protocol-version": LEGACY }),
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 3, method, params }),
    });
  }
  const call = (name: string, args: Json, opts: McpOptions = {}) =>
    mcp("tools/call", { name, arguments: args }, opts);
  const toolNames = async (token: string) =>
    (
      rpcBody(await mcp("tools/list", {}, { token })).result.tools as Json[]
    ).map((tool) => tool.name as string);

  let savedProposals: string | undefined;
  beforeAll(async () => {
    // The central proposal switch (WP-M4) is off by default; these tests use proposal tools.
    savedProposals = process.env.ORBIT_MCP_PROPOSALS;
    process.env.ORBIT_MCP_PROPOSALS = "true";
    await withEnv(FLAGS, async () => {
      config = loadConfig();
      api = await buildServer(undefined, { cimdFetch });
      auth = makeAuth({ cimdFetch });
      await api.listen({ port: 0, host: "127.0.0.1" });
      jwksUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`;
      gateway = await buildMcpServer({ cimdFetch, jwksUrl });
    });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });

    const password = randomBytes(24).toString("base64url");
    const emails = {} as Record<keyof typeof ids, string>;
    for (const who of ["owner", "editor", "viewer"] as const) {
      emails[who] = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: {
          email: emails[who],
          name: `Synthetic gateway ${who}`,
          password,
        },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic gateway workspace",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "editor" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
        projects: {
          create: [
            {
              name: "Alpha",
              members: {
                create: [
                  { userId: ids.editor, role: "editor" },
                  { userId: ids.viewer, role: "viewer" },
                ],
              },
            },
            {
              name: "Beta",
              members: { create: [{ userId: ids.editor, role: "viewer" }] },
            },
          ],
        },
      },
      include: { projects: true },
    });
    workspaceId = workspace.id;
    projectA = workspace.projects.find((p) => p.name === "Alpha")!.id;
    projectB = workspace.projects.find((p) => p.name === "Beta")!.id;

    // Proposals need an active policy in the project (ActionRequests).
    await scoped(workspaceId, projectA, (tx) =>
      create(
        tx,
        { workspaceId, projectId: projectA, userId: ids.owner, role: "owner" },
        "policies",
        {
          mode: "observe",
          channels: ["x-test"],
          contentTypes: ["social"],
          allowedOrigins: ["https://example.invalid"],
          startAt: new Date(Date.now() - 3600000).toISOString(),
          endAt: new Date(Date.now() + 86400000).toISOString(),
          maxPerDay: 0,
          minIntervalMinutes: 1,
          dailyBudgetMicros: 0,
          monthlyBudgetMicros: 0,
          perRunBudgetMicros: 0,
          approvedPaidTests: false,
          active: true,
        },
      ),
    );

    for (const who of ["editor", "viewer"] as const) {
      const r = await driver.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email: emails[who], password },
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set!])
        .map((v) => v.split(";")[0])
        .join("; ");
    }

    tokens["editor-one"] = await tokenFor("editor", CLIENT["editor-one"], [
      projectA,
    ]);
    tokens["editor-two"] = await tokenFor("editor", CLIENT["editor-two"], [
      projectA,
      projectB,
    ]);
    tokens.viewer = await tokenFor("viewer", CLIENT.viewer, [projectA]);
    tokens.revoke = await tokenFor("editor", CLIENT.revoke, [projectA]);
    tokens.legacy = await tokenFor("editor", CLIENT.legacy, [projectA]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (savedProposals === undefined) delete process.env.ORBIT_MCP_PROPOSALS;
    else process.env.ORBIT_MCP_PROPOSALS = savedProposals;
    await gateway?.close();
    await api?.close();
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  describe("transport and discovery", () => {
    it("answers an unauthenticated request with 401 and the PRM challenge", async () => {
      for (const headers of [
        {} as Record<string, string>,
        { authorization: "Bearer not-a-jwt" },
        // A browser session is not a credential here: cookies are ignored.
        { cookie: cookies.editor },
      ]) {
        const response = await mcp("tools/list", {}, { token: null, headers });
        expect(response.statusCode).toBe(401);
        expect(response.headers["www-authenticate"]).toBe(CHALLENGE);
        expect(rpcBody(response)).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32000 },
          id: null,
        });
      }
    });

    it("serves the protected resource metadata at both well-known paths", async () => {
      for (const url of [PRM_PATH, "/.well-known/oauth-protected-resource"]) {
        const response = await gateway.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^application\/json/);
        expect(response.json()).toEqual({
          resource: config.MCP_RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: [
            "orbit:read",
            "orbit:propose",
            "orbit:write",
            "orbit:support",
            "orbit:finance.read",
            "orbit:finance.extract",
            "orbit:work",
            "orbit:work.pm",
            "orbit:work.coding",
          ],
          bearer_methods_supported: ["header"],
          // WP-M5: DPoP-bound tokens are verified (mcp-gateway-audit).
          dpop_signing_alg_values_supported: [
            "EdDSA",
            "ES256",
            "ES512",
            "PS256",
            "RS256",
          ],
        });
      }
    });

    it("answers GET and DELETE /mcp with 405 and has a health check", async () => {
      for (const method of ["GET", "DELETE"] as const) {
        const response = await gateway.inject({
          method,
          url: "/mcp",
          headers: {
            authorization: `Bearer ${tokens["editor-one"]}`,
            accept: "text/event-stream",
          },
        });
        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("POST");
      }
      const health = await gateway.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
    });

    it("serves the endpoint at / exactly like /mcp (D-M5-3)", async () => {
      // A proxy that strips the /mcp prefix delivers the request at "/".
      const viaRoot = await mcp("tools/list", {}, { url: "/" });
      const viaMcp = await mcp("tools/list");
      expect(viaRoot.statusCode).toBe(200);
      expect(rpcBody(viaRoot)).toEqual(rpcBody(viaMcp));
      expect(
        (rpcBody(viaRoot).result.tools as Json[]).map((t) => t.name),
      ).toContain("orbit_projects");
      // The same 401 challenge, with the unchanged resource metadata URL.
      for (const headers of [
        {} as Record<string, string>,
        { authorization: "Bearer not-a-jwt" },
      ]) {
        const denied = await mcp(
          "tools/list",
          {},
          { url: "/", token: null, headers },
        );
        expect(denied.statusCode).toBe(401);
        expect(denied.headers["www-authenticate"]).toBe(CHALLENGE);
      }
      // The Origin policy and the stateless method policy apply too.
      const foreign = await mcp(
        "tools/list",
        {},
        { url: "/", headers: { origin: "https://evil.test" } },
      );
      expect(foreign.statusCode).toBe(403);
      for (const method of ["GET", "DELETE"] as const) {
        const response = await gateway.inject({
          method,
          url: "/",
          headers: { authorization: `Bearer ${tokens["editor-one"]}` },
        });
        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("POST");
      }
    });

    it("MCP_JWKS_URL (D-M5-5) is where the gateway fetches signing keys", async () => {
      // The configured internal URL works without any option ...
      const internal = await withEnv({ ...FLAGS, MCP_JWKS_URL: jwksUrl }, () =>
        buildMcpServer({ cimdFetch }),
      );
      try {
        expect(
          (await mcp("tools/list", {}, { app: internal })).statusCode,
        ).toBe(200);
      } finally {
        await internal.close();
      }
      // ... and an unreachable one is really used: the token cannot be verified.
      const dead = await withEnv(
        { ...FLAGS, MCP_JWKS_URL: "http://127.0.0.1:1/api/auth/jwks" },
        () => buildMcpServer({ cimdFetch }),
      );
      try {
        expect(
          (await mcp("tools/list", {}, { app: dead })).statusCode,
        ).not.toBe(200);
      } finally {
        await dead.close();
      }
      // The option wins over the environment.
      const optioned = await withEnv(
        { ...FLAGS, MCP_JWKS_URL: "http://127.0.0.1:1/api/auth/jwks" },
        () => buildMcpServer({ cimdFetch, jwksUrl }),
      );
      try {
        expect(
          (await mcp("tools/list", {}, { app: optioned })).statusCode,
        ).toBe(200);
      } finally {
        await optioned.close();
      }
    });

    it("MCP_RESOURCE in another spelling is served and checked in its canonical form (WP-M5)", async () => {
      const canonical = new URL(config.MCP_RESOURCE);
      const variant = `${canonical.protocol}//${canonical.host.toUpperCase()}${canonical.pathname}/`;
      expect(variant).not.toBe(config.MCP_RESOURCE);
      const spelled = await withEnv({ ...FLAGS, MCP_RESOURCE: variant }, () =>
        buildMcpServer({ cimdFetch, jwksUrl }),
      );
      try {
        const prm = await spelled.inject({ method: "GET", url: PRM_PATH });
        expect(prm.json().resource).toBe(config.MCP_RESOURCE);
        // Tokens carry the canonical audience; the gateway accepts them.
        expect((await mcp("tools/list", {}, { app: spelled })).statusCode).toBe(
          200,
        );
        const anonymous = await mcp(
          "tools/list",
          {},
          { app: spelled, token: null },
        );
        expect(anonymous.headers["www-authenticate"]).toBe(CHALLENGE);
      } finally {
        await spelled.close();
      }
    });

    it("server/discover (2026-07-28) names the gateway and its tool capability", async () => {
      const response = await mcp("server/discover");
      expect(response.statusCode).toBe(200);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
      const body = rpcBody(response);
      expect(body.result).toMatchObject({
        supportedVersions: [MODERN],
        capabilities: { tools: { listChanged: false } },
      });
      expect(body.result._meta[`${META}serverInfo`]).toMatchObject({
        name: "orbit-mcp-gateway",
      });
    });

    it("enforces the 256 KB body limit before anything runs", async () => {
      const spy = vi.spyOn(suggestTask, "execute");
      const response = await call("tasks_suggest_task", {
        title: "x".repeat(1024 * 1024),
      });
      expect(response.statusCode).toBe(413);
      expect(response.body).not.toContain("xxxx");
      expect(spy).not.toHaveBeenCalled();
    });

    it("foreign Origin is refused", async () => {
      const spy = vi.spyOn(suggestTask, "execute");
      for (const value of ["https://evil.test", "null", origin]) {
        const response = await call(
          "tasks_suggest_task",
          { title: "From a browser" },
          { headers: { origin: value } },
        );
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toContain("From a browser");
      }
      // Refused before token use: no challenge, even without a token.
      const anonymous = await mcp(
        "tools/list",
        {},
        {
          token: null,
          headers: { origin: "https://evil.test" },
        },
      );
      expect(anonymous.statusCode).toBe(403);
      expect(anonymous.headers["www-authenticate"]).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();

      // An origin on ORBIT_MCP_ALLOWED_ORIGINS passes.
      const allowed = await withEnv(
        { ...FLAGS, ORBIT_MCP_ALLOWED_ORIGINS: "https://allowed.test" },
        () => buildMcpServer({ cimdFetch, jwksUrl }),
      );
      try {
        const ok = await mcp(
          "tools/list",
          {},
          {
            app: allowed,
            headers: { origin: "https://allowed.test" },
          },
        );
        expect(ok.statusCode).toBe(200);
        const refused = await mcp(
          "tools/list",
          {},
          {
            app: allowed,
            headers: { origin: "https://evil.test" },
          },
        );
        expect(refused.statusCode).toBe(403);
      } finally {
        await allowed.close();
      }
    });
  });

  describe("tokens", () => {
    const claimsFor = async (token: string) => {
      const claims = jwtPayload(token) as Json;
      return {
        sub: claims.sub,
        azp: claims.azp,
        scope: claims.scope,
        [ORBIT_WORKSPACE_CLAIM]: claims[ORBIT_WORKSPACE_CLAIM],
      };
    };
    const signed = async (payload: Json) =>
      (
        (await (auth.api as any).signJWT({ body: { payload } })) as {
          token: string;
        }
      ).token;
    /** A JWT signed by a key Orbit never issued, under Orbit's `kid`. */
    const foreignSigned = (payload: Json, kid: string) => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const part = (value: Json) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${part({ alg: "EdDSA", kid, typ: "JWT" })}.${part(payload)}`;
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    };

    it("foreign aud and issuer are refused", async () => {
      const spy = vi.spyOn(suggestTask, "execute");
      const base = await claimsFor(tokens["editor-one"]);
      const now = Math.floor(Date.now() / 1000);
      const kid = JSON.parse(
        Buffer.from(
          tokens["editor-one"].split(".")[0]!,
          "base64url",
        ).toString(),
      ).kid as string;

      // Control: the same claims, signed by Orbit for the right audience and
      // issuer, are accepted, so each refusal below is about aud, iss or key.
      const control = await signed({
        ...base,
        iss: ISSUER,
        aud: [config.MCP_RESOURCE],
      });
      expect((await mcp("tools/list", {}, { token: control })).statusCode).toBe(
        200,
      );

      const refused = [
        // A token minted for another resource.
        await signed({
          ...base,
          iss: ISSUER,
          aud: ["https://elsewhere.test/mcp"],
        }),
        // A token for the userinfo endpoint only.
        await signed({
          ...base,
          iss: ISSUER,
          aud: [`${ISSUER}/oauth2/userinfo`],
        }),
        // Another issuer.
        await signed({
          ...base,
          iss: "https://issuer.invalid/api/auth",
          aud: [config.MCP_RESOURCE],
        }),
        // A foreign key.
        foreignSigned(
          {
            ...base,
            iss: ISSUER,
            aud: [config.MCP_RESOURCE],
            iat: now,
            exp: now + 600,
          },
          kid,
        ),
        // Expired.
        await signed({
          ...base,
          iss: ISSUER,
          aud: [config.MCP_RESOURCE],
          iat: now - 1200,
          exp: now - 600,
        }),
      ];
      for (const token of refused) {
        for (const response of [
          await mcp("tools/list", {}, { token }),
          await call(
            "tasks_suggest_task",
            { title: "Should never run" },
            { token },
          ),
        ]) {
          expect(response.statusCode).toBe(401);
          expect(response.headers["www-authenticate"]).toBe(CHALLENGE);
        }
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it("revoked grant refuses a call listed a moment ago", async () => {
      const spy = vi.spyOn(suggestTask, "execute");
      expect(await toolNames(tokens.revoke)).toContain("tasks_suggest_task");
      const grant = await authDb.mcpGrant.findFirstOrThrow({
        where: {
          userId: ids.editor,
          clientId: CLIENT.revoke,
          status: "active",
        },
      });
      cookie = cookies.editor;
      const revoked = await driver.inject({
        method: "DELETE",
        url: `/api/mcp-grants/${grant.id}`,
      });
      expect(revoked.statusCode).toBeLessThan(300);

      // The access token still verifies (JWKS), but the grant is gone: the
      // call is an isError result with the challenge ChatGPT links from.
      const response = await call(
        "tasks_suggest_task",
        { title: "After revocation" },
        { token: tokens.revoke },
      );
      expect(response.statusCode).toBe(200);
      const result = rpcBody(response).result;
      expect(result.isError).toBe(true);
      expect(result._meta["mcp/www_authenticate"]).toEqual([
        expect.stringContaining(
          `resource_metadata="${new URL(origin).origin}${PRM_PATH}"`,
        ),
      ]);
      expect(result.structuredContent).toEqual({
        code: "UNAUTHENTICATED",
        message: "UNAUTHENTICATED",
        retryable: false,
      });
      expect(spy).not.toHaveBeenCalled();

      // Everything else answers with the transport-level challenge.
      const list = await mcp("tools/list", {}, { token: tokens.revoke });
      expect(list.statusCode).toBe(401);
      expect(list.headers["www-authenticate"]).toBe(CHALLENGE);
    });
  });

  describe("tools/list", () => {
    it("lists orbit_projects and only the fixture tools the principal may use", async () => {
      const response = await mcp("tools/list");
      expect(response.statusCode).toBe(200);
      const tools = rpcBody(response).result.tools as Json[];
      expect(tools.map((t) => t.name)).toEqual([
        "fetch",
        "marketing_project_status",
        "orbit_action_status",
        "orbit_profile",
        "orbit_projects",
        "search",
        "tasks_suggest_task",
        "tasks_task_digest",
      ]);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.tasks_task_digest).toMatchObject({
        description: taskDigest.description,
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["orbit:read"] }],
        },
        outputSchema: {
          type: "object",
          properties: { total: { type: "integer" } },
        },
      });
      expect(byName.tasks_suggest_task).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["orbit:propose"] }],
        },
      });
      // One granted project: projectId is optional and strict.
      expect(byName.tasks_suggest_task.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          projectId: { type: "string", format: "uuid" },
        },
        required: ["title"],
      });
      expect(byName.orbit_projects).toMatchObject({
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["orbit:read"] }],
        },
      });
    });

    it("requires projectId when the grant holds more than one project", async () => {
      const tools = rpcBody(
        await mcp("tools/list", {}, { token: tokens["editor-two"] }),
      ).result.tools as Json[];
      const digest = tools.find((t) => t.name === "tasks_task_digest")!;
      expect(digest.inputSchema.required).toEqual(["projectId"]);
    });

    it("follows the user's role: a viewer gets no proposal tool", async () => {
      expect(await toolNames(tokens.viewer)).toEqual([
        "fetch",
        "marketing_project_status",
        "orbit_action_status",
        "orbit_profile",
        "orbit_projects",
        "search",
        "tasks_task_digest",
      ]);
    });

    it("never lists tools without MCP exposure", async () => {
      const listed = await toolNames(tokens["editor-two"]);
      for (const hidden of [
        "propose_tasks",
        "tasks_propose_tasks",
        "knowledge_search",
      ])
        expect(listed).not.toContain(hidden);
    });
  });

  describe("tools/call", () => {
    it("runs a read tool with structuredContent and a JSON text copy", async () => {
      const spy = vi.spyOn(taskDigest, "execute");
      const response = await call("tasks_task_digest", {});
      expect(response.statusCode).toBe(200);
      const result = rpcBody(response).result;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ total: 0 });
      expect(result.content).toEqual([{ type: "text", text: '{"total":0}' }]);
      // Ruling 2: the module's scope, the request as run, the MCP channel.
      const [context, args] = spy.mock.calls[0]!;
      expect(args).toEqual({});
      expect(context.scope).toMatchObject({
        workspaceId,
        projectId: projectA,
        userId: ids.editor,
        role: "editor",
      });
      expect(context.callIndex).toBe(0);
      // The run id is the AgentRun's (WP-M3); the request id stays in the channel.
      expect(context.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(context.channel).toEqual({
        kind: "mcp",
        clientId: CLIENT["editor-one"],
        grantId: expect.any(String),
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(context.conversationId).toBe(
        `mcp:${(context.channel as { requestId: string }).requestId}`,
      );
    });

    it("runs a proposal tool as a pending ActionRequest", async () => {
      const response = await call("tasks_suggest_task", {
        title: "Follow up",
        projectId: projectA,
      });
      const result = rpcBody(response).result;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        id: expect.any(String),
        actionRequestId: result.structuredContent.id,
        status: "pending",
        deduplicated: false,
      });
      expect(JSON.parse(result.content[0].text)).toEqual(
        result.structuredContent,
      );
    });

    it("orbit_projects lists the granted workspace and projects with modules", async () => {
      const result = rpcBody(
        await call("orbit_projects", {}, { token: tokens["editor-two"] }),
      ).result;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        workspace: { id: workspaceId, name: "Synthetic gateway workspace" },
        projects: [
          {
            id: projectA,
            name: "Alpha",
            modules: expect.arrayContaining(["tasks"]),
          },
          {
            id: projectB,
            name: "Beta",
            modules: expect.arrayContaining(["tasks"]),
          },
        ],
      });
    });

    it("maps a DomainError to an isError result with code, message and retryable", async () => {
      // A project outside the grant: never says whether it exists.
      const outside = rpcBody(
        await call("tasks_task_digest", { projectId: randomUUID() }),
      ).result;
      expect(outside.isError).toBe(true);
      expect(outside.structuredContent).toEqual({
        code: "NOT_FOUND",
        message: "NOT FOUND",
        retryable: false,
      });
      expect(JSON.parse(outside.content[0].text)).toEqual(
        outside.structuredContent,
      );
      // Listed for project A (editor), refused in project B (viewer).
      const spy = vi.spyOn(suggestTask, "execute");
      const refused = rpcBody(
        await call(
          "tasks_suggest_task",
          { title: "Not here", projectId: projectB },
          { token: tokens["editor-two"] },
        ),
      ).result;
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toEqual({
        code: "MCP_TOOL_NOT_ALLOWED",
        message: "MCP TOOL NOT ALLOWED",
        retryable: false,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("a tool the principal may not list is unknown", async () => {
      const body = rpcBody(
        await call(
          "tasks_suggest_task",
          { title: "x" },
          { token: tokens.viewer },
        ),
      );
      expect(body.error).toMatchObject({ code: -32602 });
    });

    it("never sends an internal error's message", async () => {
      vi.spyOn(taskDigest, "execute").mockRejectedValueOnce(
        new Error("internal-secret-detail"),
      );
      const response = await call("tasks_task_digest", {});
      expect(response.body).not.toContain("internal-secret-detail");
      const result = rpcBody(response).result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "REQUEST_FAILED",
        retryable: false,
      });
      expect(result.structuredContent.message).toMatch(
        /^request failed \(request id [0-9a-f-]{36}\)$/,
      );
    });

    it("validates the output and returns only the parsed value", async () => {
      vi.spyOn(taskDigest, "execute").mockResolvedValueOnce({
        output: { total: 1, secret: "extra-key-value" },
        cards: [],
      });
      const extra = await call("tasks_task_digest", {});
      expect(extra.body).not.toContain("extra-key-value");
      expect(rpcBody(extra).result.structuredContent.code).toBe(
        "REQUEST_FAILED",
      );
      vi.spyOn(taskDigest, "execute").mockResolvedValueOnce({
        output: { total: "many" },
        cards: [{ kind: "x" } as never],
      });
      expect(
        rpcBody(await call("tasks_task_digest", {})).result.structuredContent
          .code,
      ).toBe("REQUEST_FAILED");
    });

    it("caps the output at 64 KB", async () => {
      vi.spyOn(suggestTask, "execute").mockResolvedValueOnce({
        output: {
          id: "y".repeat(70 * 1024),
          actionRequestId: "z",
          status: "pending",
          deduplicated: true,
        },
        cards: [],
      });
      const response = await call("tasks_suggest_task", { title: "Big" });
      expect(response.body).not.toContain("yyyy");
      expect(rpcBody(response).result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "OUTPUT_TOO_LARGE",
          message: "OUTPUT TOO LARGE",
          retryable: false,
        },
      });
    });

    it("invalid arguments name paths, not values", async () => {
      const spy = vi.spyOn(suggestTask, "execute");
      const cases: Json[] = [
        { title: 9876543210 },
        { title: "ok", bogusField: "VALUE-MARKER-ONE" },
        { title: "ok", projectId: "VALUE-MARKER-TWO" },
        { title: ["VALUE-MARKER-THREE"] },
        {},
      ];
      for (const args of cases) {
        const response = await call("tasks_suggest_task", args);
        expect(response.statusCode).toBe(200);
        const result = rpcBody(response).result;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Invalid arguments for tool/);
        for (const marker of [
          "9876543210",
          "VALUE-MARKER-ONE",
          "VALUE-MARKER-TWO",
          "VALUE-MARKER-THREE",
        ])
          expect(response.body).not.toContain(marker);
      }
      expect(spy).not.toHaveBeenCalled();
      // The tool's own validation (title at most 120 characters) also
      // answers with paths only.
      const long = rpcBody(
        await call("tasks_suggest_task", { title: "LONGVALUE".repeat(20) }),
      ).result;
      expect(long.isError).toBe(true);
      expect(JSON.stringify(long)).not.toContain("LONGVALUE");
      expect(long.structuredContent).toEqual({
        code: "VALIDATION_FAILED",
        message: "VALIDATION FAILED: title",
        retryable: false,
      });
    });
  });

  describe("2025-11-25 (D-M2-7, stateless legacy)", () => {
    it("initialize, tools/list and tools/call work per principal without a session", async () => {
      const init = await legacy(
        "initialize",
        {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1" },
        },
        tokens.legacy,
      );
      expect(init.statusCode).toBe(200);
      expect(init.headers["content-type"]).toMatch(/^text\/event-stream/);
      expect(init.headers["mcp-session-id"]).toBeUndefined();
      expect(rpcBody(init).result).toMatchObject({
        protocolVersion: LEGACY,
        serverInfo: { name: "orbit-mcp-gateway" },
      });

      const list = rpcBody(await legacy("tools/list", {}, tokens.legacy));
      expect(list.result.tools.map((t: Json) => t.name)).toEqual([
        "fetch",
        "marketing_project_status",
        "orbit_action_status",
        "orbit_profile",
        "orbit_projects",
        "search",
        "tasks_suggest_task",
        "tasks_task_digest",
      ]);
      const called = rpcBody(
        await legacy(
          "tools/call",
          { name: "tasks_task_digest", arguments: {} },
          tokens.legacy,
        ),
      );
      expect(called.result.structuredContent).toEqual({ total: 0 });
      // The viewer's list differs: still per principal.
      expect(
        rpcBody(await legacy("tools/list", {}, tokens.viewer)).result.tools.map(
          (t: Json) => t.name,
        ),
      ).toEqual([
        "fetch",
        "marketing_project_status",
        "orbit_action_status",
        "orbit_profile",
        "orbit_projects",
        "search",
        "tasks_task_digest",
      ]);
    });
  });

  describe("process", () => {
    it("mcp-main.ts listens on MCP_PORT and stops on SIGTERM", async () => {
      const port = await freePort();
      const child = spawn(
        resolve("node_modules/.bin/tsx"),
        ["apps/api/src/mcp-main.ts"],
        {
          env: {
            ...process.env,
            ...FLAGS,
            MCP_PORT: String(port),
            BIND_HOST: "127.0.0.1",
            LOG_LEVEL: "silent",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        await new Promise<void>((done, fail) => {
          const timer = setTimeout(() => fail(new Error("no start")), 60_000);
          child.stdout!.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("listening")) {
              clearTimeout(timer);
              done();
            }
          });
          child.once("exit", (code) => fail(new Error(`exited ${code}`)));
        });
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        const exited = new Promise<number | null>((done) =>
          child.once("exit", (code) => done(code)),
        );
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }, 90_000);

    it("believes X-Forwarded-For (right-most) only from a trusted peer", () => {
      const req = (remoteAddress: string, forwarded?: string) =>
        ({
          socket: { remoteAddress },
          ip: remoteAddress,
          headers: forwarded ? { "x-forwarded-for": forwarded } : {},
        }) as unknown as FastifyRequest;
      expect(mcpClientIp(req("10.0.0.5", "198.51.100.1, 203.0.113.9"))).toBe(
        "203.0.113.9",
      );
      expect(mcpClientIp(req("::ffff:10.0.0.5", "203.0.113.9"))).toBe(
        "203.0.113.9",
      );
      expect(mcpClientIp(req("10.0.0.5", "not-an-ip"))).toBe("10.0.0.5");
      expect(mcpClientIp(req("203.0.113.50", "198.51.100.1"))).toBe(
        "203.0.113.50",
      );
      expect(mcpClientIp(req("10.0.0.5"))).toBe("10.0.0.5");
    });
  });

  describe("native context, runs before execution, timeout (WP-M3)", () => {
    const runIn = (projectId: string, id: string) =>
      scoped(workspaceId, projectId, (tx) =>
        tx.agentRun.findUnique({ where: { id }, include: { spans: true } }),
      );

    it("passes the arguments and a context to a native tool; the run starts lazily", async () => {
      const seen: {
        args?: unknown;
        ctx?: NativeToolContext;
        before?: string | null;
        started?: string | null;
        status?: string | null;
      } = {};
      const echo: NativeTool = {
        name: "fixture_echo",
        description: "Test-only native tool.",
        risk: "R0_read",
        inputSchema: z
          .object({ projectId: z.uuid(), note: z.string() })
          .strict(),
        outputSchema: z.object({ ok: z.literal(true) }).strict(),
        async run(_principal, args, ctx) {
          seen.args = args;
          seen.ctx = ctx;
          seen.before = ctx.agentRunId;
          seen.started = await ctx.startRun(args.projectId as string);
          seen.status = (await runIn(projectA, seen.started!))?.status ?? null;
          return { ok: true };
        },
      };
      (nativeTools as NativeTool[]).push(echo);
      try {
        const response = await call("fixture_echo", {
          projectId: projectA,
          note: "hello",
        });
        expect(rpcBody(response).result.structuredContent).toEqual({
          ok: true,
        });
      } finally {
        (nativeTools as NativeTool[]).pop();
      }
      expect(seen.args).toEqual({ projectId: projectA, note: "hello" });
      const ctx = seen.ctx!;
      expect(ctx).toMatchObject({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        clientId: CLIENT["editor-one"],
        grantId: expect.any(String),
      });
      expect(typeof ctx.log.warn).toBe("function");
      expect(seen.before).toBeNull();
      expect(seen.started).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx.agentRunId).toBe(seen.started);
      // Running while the tool works, finished by the gateway afterwards.
      expect(seen.status).toBe("running");
      const run = await runIn(projectA, seen.started!);
      expect(run).toMatchObject({
        kind: "mcp",
        taskClass: "fixture_echo",
        status: "succeeded",
      });
      expect(run!.spans).toHaveLength(1);
    });

    it("a native tool can only attribute a call to a project of the grant", async () => {
      const outside = randomUUID();
      const seen: { started?: string | null } = {};
      const probe: NativeTool = {
        name: "fixture_probe",
        description: "Test-only native tool.",
        risk: "R0_read",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ ok: z.literal(true) }).strict(),
        async run(_principal, _args, ctx) {
          ctx.setAuditProject(outside);
          seen.started = await ctx.startRun(outside);
          return { ok: true };
        },
      };
      (nativeTools as NativeTool[]).push(probe);
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          observe: (record) => void records.push(record),
        }),
      );
      try {
        await call("fixture_probe", {}, { app: observed });
      } finally {
        (nativeTools as NativeTool[]).pop();
        await observed.close();
      }
      expect(seen.started).toBeNull();
      expect(records[0]).toMatchObject({ projectId: null, agentRunId: null });
    });

    it("the first attribution wins: later startRun/setAuditProject for another project change nothing", async () => {
      const seen: {
        first?: string | null;
        again?: string | null;
        concurrent?: (string | null)[];
        other?: string | null;
        ctx?: NativeToolContext;
      } = {};
      const twice: NativeTool = {
        name: "fixture_twice",
        description: "Test-only native tool.",
        risk: "R0_read",
        inputSchema: z.object({ first: z.uuid(), second: z.uuid() }).strict(),
        outputSchema: z.object({ ok: z.literal(true) }).strict(),
        async run(_principal, args, ctx) {
          seen.ctx = ctx;
          seen.concurrent = await Promise.all([
            ctx.startRun(args.first as string),
            ctx.startRun(args.first as string),
          ]);
          seen.first = ctx.agentRunId;
          seen.again = await ctx.startRun(args.first as string);
          ctx.setAuditProject(args.second as string);
          seen.other = await ctx.startRun(args.second as string);
          return { ok: true };
        },
      };
      (nativeTools as NativeTool[]).push(twice);
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          observe: (record) => void records.push(record),
        }),
      );
      try {
        const result = rpcBody(
          await call(
            "fixture_twice",
            { first: projectA, second: projectB },
            { app: observed, token: tokens["editor-two"] },
          ),
        ).result;
        expect(result.isError).toBeFalsy();
      } finally {
        (nativeTools as NativeTool[]).pop();
        await observed.close();
      }
      // Same project: one run, the same id every time.
      expect(seen.first).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen.concurrent).toEqual([seen.first, seen.first]);
      expect(seen.again).toBe(seen.first);
      // Another project of the grant: ignored, the attribution is unchanged.
      expect(seen.other).toBeNull();
      expect(seen.ctx!.agentRunId).toBe(seen.first);
      expect(records).toEqual([
        expect.objectContaining({
          projectId: projectA,
          agentRunId: seen.first,
          outcome: "ok",
        }),
      ]);
      // The run is finished under its own project, with its span, and the
      // other project got no run.
      expect(await runIn(projectA, seen.first!)).toMatchObject({
        status: "succeeded",
        spans: [expect.objectContaining({ name: "fixture_twice" })],
      });
      const inB = await scoped(workspaceId, projectB, (tx) =>
        tx.agentRun.count({
          where: {
            workspaceId,
            projectId: projectB,
            taskClass: "fixture_twice",
          },
        }),
      );
      expect(inB).toBe(0);
    });

    it("a native that starts a run after the call timed out gets no attribution", async () => {
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      const seen: { late?: string | null; ctx?: NativeToolContext } = {};
      const slow: NativeTool = {
        name: "fixture_slow",
        description: "Test-only native tool.",
        risk: "R0_read",
        inputSchema: z.object({ projectId: z.uuid() }).strict(),
        outputSchema: z.object({ ok: z.literal(true) }).strict(),
        async run(_principal, args, ctx) {
          seen.ctx = ctx;
          await gate;
          seen.late = await ctx.startRun(args.projectId as string);
          return { ok: true };
        },
      };
      (nativeTools as NativeTool[]).push(slow);
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          toolTimeoutMs: 100,
          observe: (record) => void records.push(record),
        }),
      );
      try {
        const result = rpcBody(
          await call(
            "fixture_slow",
            { projectId: projectA },
            { app: observed },
          ),
        ).result;
        expect(result.structuredContent.code).toBe("TIMEOUT");
        release();
        await vi.waitFor(() => expect(seen.late).toBeNull());
      } finally {
        release();
        (nativeTools as NativeTool[]).pop();
        await observed.close();
      }
      expect(seen.ctx!.agentRunId).toBeNull();
      expect(records).toEqual([
        expect.objectContaining({ outcome: "TIMEOUT", projectId: null }),
      ]);
    });

    it("orbit_projects still runs with (principal, args, ctx)", async () => {
      const spy = vi.spyOn(orbitProjects, "run");
      const result = rpcBody(await call("orbit_projects", {})).result;
      expect(result.isError).toBeFalsy();
      const [principal, args, ctx] = spy.mock.calls[0]!;
      expect(principal.workspaceId).toBe(workspaceId);
      expect(args).toEqual({});
      expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx.agentRunId).toBeNull();
    });

    it("starts the AgentRun before a registry tool executes and passes its id as runId", async () => {
      const seen: { runId?: string; status?: string; kind?: string } = {};
      vi.spyOn(taskDigest, "execute").mockImplementationOnce(
        async (context) => {
          seen.runId = context.runId;
          const run = await runIn(projectA, context.runId);
          seen.status = run?.status;
          seen.kind = run?.kind;
          return { output: { total: 0 }, cards: [] };
        },
      );
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          observe: (record) => void records.push(record),
        }),
      );
      try {
        await call("tasks_task_digest", {}, { app: observed });
      } finally {
        await observed.close();
      }
      expect(seen).toMatchObject({ status: "running", kind: "mcp" });
      expect(records[0]!.agentRunId).toBe(seen.runId);
      expect(await runIn(projectA, seen.runId!)).toMatchObject({
        status: "succeeded",
        taskClass: "tasks_task_digest",
      });
    });

    it("falls back to the request id when the run cannot be created", async () => {
      const telemetry = await import("../src/platform/ai/telemetry.ts");
      vi.spyOn(telemetry, "startRun").mockResolvedValueOnce(null);
      let runId = "";
      vi.spyOn(taskDigest, "execute").mockImplementationOnce(
        async (context) => {
          runId = context.runId;
          expect((context.channel as { requestId: string }).requestId).toBe(
            context.runId,
          );
          return { output: { total: 0 }, cards: [] };
        },
      );
      const result = rpcBody(await call("tasks_task_digest", {})).result;
      expect(result.structuredContent).toEqual({ total: 0 });
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("answers TIMEOUT when a tool does not finish, audited as TIMEOUT", async () => {
      vi.spyOn(taskDigest, "execute").mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          toolTimeoutMs: 150,
          observe: (record) => void records.push(record),
        }),
      );
      try {
        const started = Date.now();
        const response = await call("tasks_task_digest", {}, { app: observed });
        expect(Date.now() - started).toBeLessThan(5000);
        const result = rpcBody(response).result;
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          code: "TIMEOUT",
          message:
            "the tool did not finish in time; its work may still complete",
          retryable: true,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
        expect(records).toEqual([
          expect.objectContaining({
            tool: "tasks_task_digest",
            projectId: projectA,
            outcome: "TIMEOUT",
          }),
        ]);
        const run = await runIn(projectA, records[0]!.agentRunId!);
        expect(run).toMatchObject({ status: "failed", errorCode: "TIMEOUT" });
      } finally {
        await observed.close();
      }
    });
  });

  describe("withToolTimeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the default of 25 seconds in one place", async () => {
      const { MCP_TOOL_TIMEOUT_MS } =
        await import("../src/platform/mcp/adapter.ts");
      expect(MCP_TOOL_TIMEOUT_MS).toBe(25_000);
    });

    it("rejects with TIMEOUT after the limit, and ignores a late result", async () => {
      vi.useFakeTimers();
      let finish!: (value: string) => void;
      const work = new Promise<string>((done) => (finish = done));
      const guarded = withToolTimeout(work, 25_000);
      const settled = guarded.then(
        () => "resolved",
        (error: unknown) => (error as Error).message,
      );
      await vi.advanceTimersByTimeAsync(24_999);
      let early = true;
      void settled.then(() => (early = false));
      await Promise.resolve();
      expect(early).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toBe("MCP_TOOL_TIMEOUT");
      finish("late");
      await Promise.resolve();
    });

    it("passes the result through and clears its timer", async () => {
      vi.useFakeTimers();
      await expect(
        withToolTimeout(Promise.resolve("done"), 25_000),
      ).resolves.toBe("done");
      expect(vi.getTimerCount()).toBe(0);
      await expect(
        withToolTimeout(Promise.reject(new Error("own failure")), 25_000),
      ).rejects.toThrow("own failure");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("call observer (Task 4 hook point)", () => {
    it("receives every finished call, refused ones included", async () => {
      const records: McpCallRecord[] = [];
      const observed = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          observe: async (record) => {
            records.push(record);
            throw new Error("observer failures never change the result");
          },
        }),
      );
      try {
        const ok = rpcBody(
          await call("tasks_task_digest", {}, { app: observed }),
        ).result;
        expect(ok.structuredContent).toEqual({ total: 0 });
        const missing = randomUUID();
        await call(
          "tasks_task_digest",
          { projectId: missing },
          { app: observed },
        );
        // The revoke test above revoked this token's grant.
        await call(
          "tasks_suggest_task",
          { title: "Refused" },
          { app: observed, token: tokens.revoke },
        );
        const grant = await authDb.mcpGrant.findFirstOrThrow({
          where: { userId: ids.editor, clientId: CLIENT["editor-one"] },
        });
        expect(records).toEqual([
          {
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            tool: "tasks_task_digest",
            userId: ids.editor,
            clientId: CLIENT["editor-one"],
            grantId: grant.id,
            workspaceId,
            projectId: projectA,
            agentRunId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            outcome: "ok",
            durationMs: expect.any(Number),
            args: {},
            clientIp: "127.0.0.1",
          },
          expect.objectContaining({
            tool: "tasks_task_digest",
            // Not one of the grant's projects: never attributed to a project.
            projectId: null,
            agentRunId: null,
            outcome: "NOT_FOUND",
          }),
          expect.objectContaining({
            tool: "tasks_suggest_task",
            userId: ids.editor,
            clientId: CLIENT.revoke,
            grantId: null,
            workspaceId: null,
            outcome: "UNAUTHENTICATED",
          }),
        ]);
      } finally {
        await observed.close();
      }
    });
  });

  describe("module activation reads (ruling 6)", () => {
    it("skips the activation read while switching is off and no opt-in module exposes a tool", async () => {
      expect(process.env.ORBIT_MODULES).toBeUndefined();
      expect(mcpToolsNeedActivationRows()).toBe(false);
      process.env.ORBIT_MODULES = "true";
      try {
        expect(mcpToolsNeedActivationRows()).toBe(true);
        // Same list with and without the read.
        expect(await toolNames(tokens["editor-two"])).toEqual([
          "fetch",
          "marketing_project_status",
          "orbit_action_status",
          "orbit_profile",
          "orbit_projects",
          "search",
          "tasks_suggest_task",
          "tasks_task_digest",
        ]);
      } finally {
        delete process.env.ORBIT_MODULES;
      }
      expect(await toolNames(tokens["editor-two"])).toEqual([
        "fetch",
        "marketing_project_status",
        "orbit_action_status",
        "orbit_profile",
        "orbit_projects",
        "search",
        "tasks_suggest_task",
        "tasks_task_digest",
      ]);
    });

    it("reads activation when an opt-in module owns an exposed tool", () => {
      const tasks = registeredRegistry().modules.find((m) => m.id === "tasks")!;
      const saved = tasks.defaultEnabled;
      (tasks as { defaultEnabled: boolean }).defaultEnabled = false;
      try {
        expect(mcpToolsNeedActivationRows()).toBe(true);
      } finally {
        (tasks as { defaultEnabled: boolean }).defaultEnabled = saved;
      }
    });
  });
});

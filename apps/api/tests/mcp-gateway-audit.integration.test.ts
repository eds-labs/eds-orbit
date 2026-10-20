import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
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
import { hashText } from "../src/platform/ai/telemetry.ts";
import { argsHash } from "../src/platform/mcp/audit.ts";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";
import type { McpCallRecord } from "../src/platform/mcp/adapter.ts";
import { McpRateLimiter, MCP_RATE_LIMITS } from "../src/platform/mcp/limits.ts";
import { orbitProfile } from "../src/platform/mcp/native/profile.ts";
import { makeShutdown } from "../src/platform/mcp/shutdown.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  suggestTask,
  taskDigest,
  tasksFixture,
} from "./fixtures/modules/tasks/contributions.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  FORM,
  ISSUER,
  jwtPayload,
  metadata,
  REDIRECT_URI,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M2, Task 4: audit rows, the project-less call log, telemetry,
// lastUsedAt, rate limits and the hardening items of the gateway. Real WP-M1
// tokens, as in mcp-gateway.integration.test.ts.

// A failing audit write must not fail the call: tests switch this on.
const failures = { audit: false, grantEvent: false };
vi.mock("../src/platform/shared.ts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/platform/shared.ts")>();
  return {
    ...real,
    audit: (...args: Parameters<typeof real.audit>) => {
      if (failures.audit) throw new Error("audit store down SECRET-FAIL");
      return real.audit(...args);
    },
  };
});
// Counts principal resolutions: a rate-limited request must not run any.
const principalCalls = { count: 0 };
vi.mock("../src/platform/mcp/principal.ts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/platform/mcp/principal.ts")>();
  return {
    ...real,
    resolvePrincipal: (...args: Parameters<typeof real.resolvePrincipal>) => {
      principalCalls.count++;
      return real.resolvePrincipal(...args);
    },
  };
});
// Counts token verifications (requireMcpAuth runs them): a request refused
// for its address before verification must not run one (WP-M5).
const verifications = { count: 0 };
vi.mock("@better-auth/mcp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@better-auth/mcp")>();
  return {
    ...real,
    requireMcpAuth: (...args: Parameters<typeof real.requireMcpAuth>) => {
      const handler = real.requireMcpAuth(...args);
      return (request: Request) => {
        verifications.count++;
        return handler(request);
      };
    },
  };
});
vi.mock("../src/platform/mcp-auth/events.ts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/platform/mcp-auth/events.ts")>();
  return {
    ...real,
    recordGrantEvent: (...args: Parameters<typeof real.recordGrantEvent>) => {
      if (failures.grantEvent) throw new Error("event store down SECRET-FAIL");
      return real.recordGrantEvent(...args);
    },
  };
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const MARKER = "SECRET-MARKER-9f3a1c-do-not-store";

const names = [
  "audit-a",
  "audit-ab",
  "audit-gone",
  "limit-grant",
  "limit-user-1",
  "limit-user-2",
  "limit-client-editor",
  "limit-client-viewer",
  "limit-window",
  "limit-ip",
  "dpop",
] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/audit-${n}.json`]),
) as Record<Name, string>;
const cimdFetch = cimdFetchFor(
  Object.fromEntries(Object.values(CLIENT).map((id) => [id, metadata(id)])),
);

const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;

async function withFlags<T>(run: () => Promise<T>): Promise<T> {
  const keys = Object.keys(FLAGS) as (keyof typeof FLAGS)[];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, FLAGS);
  try {
    return await run();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

function rpcBody(response: { body: string }): Json {
  return response.body === "" ? {} : (JSON.parse(response.body) as Json);
}

describe("rate limiter", () => {
  it("counts per key inside a fixed window and reports the wait", () => {
    let now = 1_000_000;
    const limiter = new McpRateLimiter(() => now);
    const rule = (key: string, max: number) => ({ key, max });
    expect(limiter.take([rule("a", 2)])).toEqual({ allowed: true });
    expect(limiter.take([rule("a", 2)])).toEqual({ allowed: true });
    now += 20_000;
    expect(limiter.take([rule("a", 2)])).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
    // Another key has its own window.
    expect(limiter.take([rule("b", 2)])).toEqual({ allowed: true });
    now += 40_000;
    expect(limiter.take([rule("a", 2)])).toEqual({ allowed: true });
  });

  it("takes from every bucket or from none", () => {
    const limiter = new McpRateLimiter(() => 5_000);
    expect(limiter.take([{ key: "grant", max: 1 }])).toEqual({ allowed: true });
    // The grant bucket is full: the user bucket must not be charged.
    expect(
      limiter.take([
        { key: "grant", max: 1 },
        { key: "user", max: 2 },
      ]),
    ).toMatchObject({ allowed: false });
    expect(limiter.take([{ key: "user", max: 2 }])).toEqual({ allowed: true });
    expect(limiter.take([{ key: "user", max: 2 }])).toEqual({ allowed: true });
    expect(limiter.take([{ key: "user", max: 2 }])).toMatchObject({
      allowed: false,
    });
  });

  it("drops expired windows so the table stays small", () => {
    let now = 0;
    const limiter = new McpRateLimiter(() => now);
    for (let i = 0; i < 50; i++) limiter.take([{ key: `ip-${i}`, max: 1 }]);
    expect(limiter.size).toBe(50);
    now += 61_000;
    limiter.take([{ key: "late", max: 1 }]);
    expect(limiter.size).toBe(1);
  });

  it("keeps the documented limits in one place", () => {
    expect(MCP_RATE_LIMITS).toEqual({
      perGrant: 120,
      perUser: 240,
      perClient: 600,
      unauthenticatedPerIp: 30,
      searchPerGrant: 30,
      proposalsPerHour: 20,
      proposalsPerDay: 100,
    });
  });
});

describe("shutdown", () => {
  it("runs the steps once, logs the error name only and exits", async () => {
    const exit = vi.fn();
    const logged: unknown[][] = [];
    const calls: string[] = [];
    const shutdown = makeShutdown({
      steps: [
        async () => {
          calls.push("app");
          throw Object.assign(new Error("close failed SECRET-FAIL"), {
            name: "CloseError",
          });
        },
        async () => {
          calls.push("db");
        },
      ],
      exit,
      log: (...args) => logged.push(args),
    });
    await Promise.all([shutdown(), shutdown()]);
    await shutdown();
    expect(calls).toEqual(["app", "db"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logged)).toContain("CloseError");
    expect(JSON.stringify(logged)).not.toContain("SECRET-FAIL");
  });

  it("exits 0 when every step closes", async () => {
    const exit = vi.fn();
    const shutdown = makeShutdown({
      steps: [async () => {}],
      exit,
      log: () => {},
    });
    await shutdown();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe.skipIf(!enabled)("MCP gateway: audit, telemetry and limits", () => {
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
  const tokens = {} as Record<string, string>;
  let clock = Date.now();
  const logLines: string[] = [];
  const logStream = { write: (line: string) => void logLines.push(line) };
  const spawned: FastifyInstance[] = [];

  const driver = createFlowDriver({
    app: () => api,
    config: () => config,
    cookie: () => cookie,
    selection: () => selection,
    defaultClientId: CLIENT["audit-a"],
  });

  async function tokenFor(
    who: "editor" | "viewer",
    name: Name,
    projectIds: string[],
  ) {
    cookie = cookies[who];
    selection = { workspaceId, projectIds };
    const flow = await driver.connect({ clientId: CLIENT[name] });
    const response = await driver.exchange(flow, { client_id: CLIENT[name] });
    expect(response.statusCode).toBe(200);
    return (response.json() as Json).access_token as string;
  }

  const gatewayWith = async (
    options: Parameters<typeof buildMcpServer>[0] = {},
  ) => {
    // The gateway logs into logStream at info level (tests may run silent).
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    const app = await withFlags(() =>
      buildMcpServer({
        cimdFetch,
        jwksUrl,
        logStream,
        clock: () => clock,
        ...options,
      }),
    );
    if (level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = level;
    spawned.push(app);
    return app;
  };

  type RpcOptions = { token?: string | null; ip?: string };
  function rpc(
    app: FastifyInstance,
    method: string,
    params: Json,
    opts: RpcOptions = {},
  ) {
    const token = opts.token === undefined ? tokens["audit-a"] : opts.token;
    return app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [`${META}protocolVersion`]: MODERN,
            [`${META}clientInfo`]: { name: "audit-test", version: "1" },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
    });
  }
  const call = (
    app: FastifyInstance,
    name: string,
    args: Json,
    opts: RpcOptions = {},
  ) => rpc(app, "tools/call", { name, arguments: args }, opts);

  const auditRows = (projectId: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { workspaceId, projectId, action: "mcp.tool_call" },
        orderBy: { createdAt: "asc" },
      }),
    );
  const runsIn = (projectId: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.agentRun.findMany({
        where: { workspaceId, projectId, kind: "mcp" },
        include: { spans: true },
        orderBy: { startedAt: "asc" },
      }),
    );
  const callEvents = (userId = ids.editor) =>
    authDb.mcpGrantEvent.findMany({
      where: { userId, action: "mcp.call" },
      orderBy: { createdAt: "asc" },
    });
  const grantFor = (name: Name, userId = ids.editor) =>
    authDb.mcpGrant.findFirstOrThrow({
      where: { userId, clientId: CLIENT[name] },
    });

  let savedProposals: string | undefined;
  beforeAll(async () => {
    // The central proposal switch (WP-M4) is off by default; these tests use proposal tools.
    savedProposals = process.env.ORBIT_MCP_PROPOSALS;
    process.env.ORBIT_MCP_PROPOSALS = "true";
    await withFlags(async () => {
      config = loadConfig();
      api = await buildServer(undefined, { cimdFetch });
      auth = makeAuth({ cimdFetch });
      await api.listen({ port: 0, host: "127.0.0.1" });
      jwksUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`;
    });
    gateway = await gatewayWith();
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });

    const password = randomBytes(24).toString("base64url");
    const emails = {} as Record<keyof typeof ids, string>;
    for (const who of ["owner", "editor", "viewer"] as const) {
      emails[who] = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: { email: emails[who], name: `Synthetic audit ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic audit workspace",
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

    tokens["audit-a"] = await tokenFor("editor", "audit-a", [projectA]);
    tokens["audit-ab"] = await tokenFor("editor", "audit-ab", [
      projectA,
      projectB,
    ]);
    tokens["audit-gone"] = await tokenFor("editor", "audit-gone", [projectA]);
    for (const name of [
      "limit-grant",
      "limit-user-1",
      "limit-user-2",
      "limit-window",
      "limit-ip",
      "limit-client-editor",
    ] as const)
      tokens[name] = await tokenFor("editor", name, [projectA]);
    tokens["limit-client-viewer"] = await tokenFor(
      "viewer",
      "limit-client-viewer",
      [projectA],
    );
  }, 120_000);
  afterEach(() => {
    vi.restoreAllMocks();
    failures.audit = false;
    failures.grantEvent = false;
  });
  afterAll(async () => {
    if (savedProposals === undefined) delete process.env.ORBIT_MCP_PROPOSALS;
    else process.env.ORBIT_MCP_PROPOSALS = savedProposals;
    for (const app of spawned) await app.close();
    await api?.close();
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.mcpGrantEvent.deleteMany({
      where: { userId: { in: users } },
    });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  describe("audit of project calls", () => {
    it("writes an mcp.tool_call event for a success, without argument values", async () => {
      const args = { title: `Task ${MARKER}` };
      const response = await call(gateway, "tasks_suggest_task", args);
      expect(rpcBody(response).result.isError).toBeFalsy();
      const grant = await grantFor("audit-a");
      const rows = await auditRows(projectA);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        workspaceId,
        projectId: projectA,
        actorId: ids.editor,
        action: "mcp.tool_call",
      });
      expect(row.metadata).toEqual({
        tool: "tasks_suggest_task",
        clientId: CLIENT["audit-a"],
        grantId: grant.id,
        outcome: "ok",
        durationMs: expect.any(Number),
        argsHash: argsHash(args),
      });
      expect((row.metadata as Json).argsHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("writes one for a refusal, in the requested project", async () => {
      // Listed for project A (editor), refused in project B (viewer).
      const spy = vi.spyOn(suggestTask, "execute");
      const args = { title: MARKER, projectId: projectB };
      const result = rpcBody(
        await call(gateway, "tasks_suggest_task", args, {
          token: tokens["audit-ab"],
        }),
      ).result;
      expect(result.structuredContent.code).toBe("MCP_TOOL_NOT_ALLOWED");
      expect(spy).not.toHaveBeenCalled();
      const rows = await auditRows(projectB);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({
        tool: "tasks_suggest_task",
        outcome: "MCP_TOOL_NOT_ALLOWED",
        clientId: CLIENT["audit-ab"],
        argsHash: argsHash(args),
      });
    });

    it("audits a call the SDK refused before the tool ran", async () => {
      // A viewer is not offered the tool: -32602 from the SDK, no handler.
      const args = { title: MARKER };
      const response = await call(gateway, "tasks_suggest_task", args, {
        token: tokens["limit-client-viewer"],
      });
      expect(rpcBody(response).error.code).toBe(-32602);
      const rows = (await auditRows(projectA)).filter(
        (row) => row.actorId === ids.viewer,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({
        tool: "tasks_suggest_task",
        outcome: "INVALID_PARAMS",
        argsHash: argsHash(args),
      });
    });

    it("hashes the same arguments to the same value in any key order", () => {
      expect(argsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
        argsHash({ b: { d: 3, c: 2 }, a: 1 }),
      );
      expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
      expect(argsHash(undefined)).toBe(argsHash({}));
      expect(argsHash({})).toBe(hashText("{}"));
    });
  });

  describe("project-less call log", () => {
    it("orbit_projects goes to McpGrantEvent mcp.call and writes no AuditEvent", async () => {
      const before = (await auditRows(projectA)).length;
      const response = await call(gateway, "orbit_projects", {});
      expect(rpcBody(response).result.isError).toBeFalsy();
      const grant = await grantFor("audit-a");
      const events = (await callEvents()).filter(
        (event) => event.grantId === grant.id,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "mcp.call",
        userId: ids.editor,
        clientId: CLIENT["audit-a"],
        grantId: grant.id,
        workspaceId,
      });
      expect(events[0]!.detail).toEqual({
        tool: "orbit_projects",
        outcome: "ok",
        durationMs: expect.any(Number),
        argsHash: argsHash({}),
      });
      expect((await auditRows(projectA)).length).toBe(before);
    });

    it("a project outside the grant is logged without an audit row in it", async () => {
      const foreign = randomUUID();
      await call(gateway, "tasks_task_digest", { projectId: foreign });
      const grant = await grantFor("audit-a");
      const event = (await callEvents()).find(
        (e) =>
          e.grantId === grant.id &&
          (e.detail as Json).tool === "tasks_task_digest" &&
          (e.detail as Json).outcome === "NOT_FOUND",
      );
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(foreign);
      const rows = await scoped(workspaceId, foreign, (tx) =>
        tx.auditEvent.count({ where: { projectId: foreign } }),
      );
      expect(rows).toBe(0);
    });

    it("a call with a revoked grant is logged without a grant id", async () => {
      await authDb.mcpGrant.updateMany({
        where: { userId: ids.editor, clientId: CLIENT["audit-gone"] },
        data: { status: "revoked", revokedAt: new Date() },
      });
      const args = { title: MARKER };
      const result = rpcBody(
        await call(gateway, "tasks_suggest_task", args, {
          token: tokens["audit-gone"],
        }),
      ).result;
      expect(result.structuredContent.code).toBe("UNAUTHENTICATED");
      const event = (await callEvents()).find(
        (e) => e.clientId === CLIENT["audit-gone"],
      );
      expect(event).toMatchObject({
        action: "mcp.call",
        userId: ids.editor,
        grantId: null,
        workspaceId: null,
      });
      expect(event!.detail).toMatchObject({
        tool: "tasks_suggest_task",
        outcome: "UNAUTHENTICATED",
        argsHash: argsHash(args),
      });
    });
  });

  describe("client-supplied tool names", () => {
    it("an unknown tool is audited as <unknown> and creates no AgentRun", async () => {
      const runsBefore = (await runsIn(projectA)).length;
      const rowsBefore = (await auditRows(projectA)).length;
      const made = [`no_such_tool`, `Evil ${MARKER}<script>`, "x".repeat(300)];
      for (const name of made) {
        const response = await call(gateway, name, { title: MARKER });
        expect(rpcBody(response).error.code).toBe(-32602);
      }
      const rows = (await auditRows(projectA)).slice(rowsBefore);
      expect(rows).toHaveLength(made.length);
      for (const row of rows)
        expect(row.metadata).toMatchObject({
          tool: "<unknown>",
          outcome: "INVALID_PARAMS",
        });
      expect((await runsIn(projectA)).length).toBe(runsBefore);
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(MARKER);
      expect(stored).not.toContain("no_such_tool");
    });

    it("a known tool keeps its name when the SDK refuses the call", async () => {
      // Valid name, invalid arguments: a real tool, so name and run stay.
      const runsBefore = (await runsIn(projectA)).length;
      const response = await call(gateway, "tasks_suggest_task", {
        title: 42,
      });
      expect(rpcBody(response).result.isError).toBe(true);
      const row = (await auditRows(projectA)).at(-1)!;
      expect(row.metadata).toMatchObject({
        tool: "tasks_suggest_task",
        outcome: "INVALID_PARAMS",
      });
      const runs = await runsIn(projectA);
      expect(runs.length).toBe(runsBefore + 1);
      expect(runs.at(-1)!.taskClass).toBe("tasks_suggest_task");
    });

    it("a made-up name with a gone grant is logged as <unknown>", async () => {
      const response = await call(
        gateway,
        `made_up_${randomUUID().slice(0, 8)}`,
        {},
        { token: tokens["audit-gone"] },
      );
      expect(rpcBody(response).result.structuredContent.code).toBe(
        "UNAUTHENTICATED",
      );
      const event = (await callEvents())
        .filter((e) => e.clientId === CLIENT["audit-gone"])
        .at(-1);
      expect(event!.detail).toMatchObject({
        tool: "<unknown>",
        outcome: "UNAUTHENTICATED",
      });
    });
  });

  describe("telemetry", () => {
    it("records an mcp AgentRun with one tool_call span per project call", async () => {
      const args = { title: `Telemetry ${MARKER}` };
      await call(gateway, "tasks_suggest_task", args);
      const grant = await grantFor("audit-a");
      const run = (await runsIn(projectA)).find(
        (r) => r.spans[0]?.inputHash === argsHash(args),
      );
      expect(run).toBeDefined();
      expect(run).toMatchObject({
        status: "succeeded",
        taskClass: "tasks_suggest_task",
        subjectType: "mcp_grant",
        subjectId: grant.id,
      });
      expect(run!.agentName).toContain(CLIENT["audit-a"]);
      expect(run!.spans).toHaveLength(1);
      expect(run!.spans[0]).toMatchObject({
        type: "tool_call",
        name: "tasks_suggest_task",
        status: "succeeded",
        inputHash: argsHash(args),
      });
    });

    it("marks a refused call failed with the outcome code", async () => {
      await call(
        gateway,
        "tasks_suggest_task",
        { title: "No", projectId: projectB },
        { token: tokens["audit-ab"] },
      );
      const runs = await runsIn(projectB);
      const run = runs.at(-1)!;
      expect(run).toMatchObject({
        status: "failed",
        errorCode: "MCP_TOOL_NOT_ALLOWED",
      });
      expect(run.spans[0]).toMatchObject({
        status: "failed",
        errorCode: "MCP_TOOL_NOT_ALLOWED",
      });
    });
  });

  describe("lastUsedAt", () => {
    it("is set by a call and then touched at most once per minute", async () => {
      const app = await gatewayWith();
      const token = tokens["limit-window"];
      const grant = await grantFor("limit-window");
      expect(grant.lastUsedAt).toBeNull();
      await call(app, "orbit_projects", {}, { token });
      expect((await grantFor("limit-window")).lastUsedAt).toBeInstanceOf(Date);

      // Within the minute: untouched, even when the stored value is older.
      const old = new Date(Date.now() - 3_600_000);
      await authDb.mcpGrant.update({
        where: { id: grant.id },
        data: { lastUsedAt: old },
      });
      clock += 30_000;
      await call(app, "orbit_projects", {}, { token });
      expect((await grantFor("limit-window")).lastUsedAt).toEqual(old);

      // After a minute: written again.
      clock += 31_000;
      await call(app, "orbit_projects", {}, { token });
      const later = (await grantFor("limit-window")).lastUsedAt!;
      expect(later.getTime()).toBeGreaterThan(old.getTime());
    });
  });

  describe("failures never fail the call", () => {
    it("a failing project audit write is logged as an error, name only", async () => {
      failures.audit = true;
      logLines.length = 0;
      const response = await call(gateway, "tasks_task_digest", {});
      expect(response.statusCode).toBe(200);
      expect(rpcBody(response).result.structuredContent).toEqual({
        total: expect.any(Number),
      });
      const lines = logLines.map((l) => JSON.parse(l) as Json);
      const failed = lines.find((l) => l.code === "MCP_AUDIT_FAILED");
      expect(failed).toBeDefined();
      expect(failed!.level).toBe(50);
      expect(failed!.errorName).toBe("Error");
      expect(logLines.join("")).not.toContain("SECRET-FAIL");
    });

    it("a failing call-log write is logged and the call still succeeds", async () => {
      failures.grantEvent = true;
      logLines.length = 0;
      const response = await call(gateway, "orbit_projects", {});
      expect(rpcBody(response).result.isError).toBeFalsy();
      const failed = logLines
        .map((l) => JSON.parse(l) as Json)
        .find((l) => l.code === "MCP_CALL_LOG_FAILED");
      expect(failed).toBeDefined();
      expect(logLines.join("")).not.toContain("SECRET-FAIL");
    });
  });

  describe("argument values are stored nowhere", () => {
    it("no audit column, event, span, run or log line carries them", async () => {
      logLines.length = 0;
      const attempts: [string, Json, string][] = [
        ["tasks_suggest_task", { title: MARKER }, tokens["audit-a"]],
        [
          "tasks_suggest_task",
          { title: MARKER, projectId: projectB },
          tokens["audit-ab"],
        ],
        ["tasks_task_digest", { projectId: MARKER }, tokens["audit-a"]],
        [
          "tasks_task_digest",
          { projectId: randomUUID(), extra: MARKER },
          tokens["audit-a"],
        ],
      ];
      for (const [name, args, token] of attempts)
        await call(gateway, name, args, { token });

      const rows = {
        audit: [...(await auditRows(projectA)), ...(await auditRows(projectB))],
        runs: [...(await runsIn(projectA)), ...(await runsIn(projectB))],
        events: await authDb.mcpGrantEvent.findMany({
          where: { userId: { in: users }, action: "mcp.call" },
        }),
      };
      expect(logLines.length).toBeGreaterThan(0);
      expect(rows.audit.length).toBeGreaterThan(0);
      expect(rows.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(MARKER);
      expect(logLines.join("")).not.toContain(MARKER);
    });
  });

  describe("rate limits", () => {
    it("the 121st call of a grant in a minute is a 429 with Retry-After", async () => {
      const app = await gatewayWith();
      const token = tokens["limit-grant"];
      const spy = vi.spyOn(suggestTask, "execute");
      for (let i = 0; i < MCP_RATE_LIMITS.perGrant; i++) {
        const r = await rpc(app, "ping", {}, { token });
        expect(r.statusCode).not.toBe(429);
      }
      const limited = await call(
        app,
        "tasks_suggest_task",
        { title: "Over the limit" },
        { token },
      );
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
      expect(rpcBody(limited).error.message).toBe("Rate limit exceeded");
      expect(spy).not.toHaveBeenCalled();
      // The window ends: calls work again.
      clock += 61_000;
      const again = await call(app, "orbit_projects", {}, { token });
      expect(again.statusCode).toBe(200);
    }, 120_000);

    it("search has its own bucket per grant (30 a minute); other tools still pass", async () => {
      const app = await gatewayWith({
        rateLimits: { searchPerGrant: 2, perGrant: 50 },
      });
      const token = tokens["limit-window"];
      const search = (opts: RpcOptions = { token }) =>
        call(app, "search", { query: "x" }, opts);
      for (let i = 0; i < 2; i++) {
        const passed = await search();
        expect(passed.statusCode).toBe(200);
        expect(rpcBody(passed).result.structuredContent).toEqual({
          results: [],
        });
      }
      const limited = await search();
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(logLines.join("")).toContain('"bucket":"search"');
      // Other tools, and the grant bucket, were not used up by the refusal.
      expect(
        (await call(app, "orbit_projects", {}, { token })).statusCode,
      ).toBe(200);
      // Another grant has its own search bucket.
      const other = await call(
        app,
        "search",
        { query: "x" },
        { token: tokens["limit-user-2"] },
      );
      expect(other.statusCode).toBe(200);
      expect(rpcBody(other).result.isError).toBeFalsy();
      // Only a tools/call of search is counted in it.
      for (let i = 0; i < 3; i++)
        expect((await rpc(app, "ping", {}, { token })).statusCode).not.toBe(
          429,
        );
    });

    it("a rate-limited request resolves no principal (no grant or membership query)", async () => {
      const app = await gatewayWith({
        rateLimits: { perGrant: 2, perUser: 50, perClient: 50 },
      });
      const token = tokens["limit-window"];
      const before = principalCalls.count;
      for (let i = 0; i < 2; i++)
        expect(
          (await call(app, "orbit_projects", {}, { token })).statusCode,
        ).toBe(200);
      expect(principalCalls.count).toBe(before + 2);
      const spy = vi.spyOn(suggestTask, "execute");
      const limited = await call(
        app,
        "tasks_suggest_task",
        { title: "Over the limit" },
        { token },
      );
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(principalCalls.count).toBe(before + 2);
      expect(spy).not.toHaveBeenCalled();
      expect(logLines.join("")).toContain('"bucket":"grant"');
    });

    it("the grant bucket is per grant: another grant of the same user still runs", async () => {
      const app = await gatewayWith({
        rateLimits: { perGrant: 1, perUser: 50, perClient: 50 },
      });
      const status = async (token: string) =>
        (await call(app, "orbit_projects", {}, { token })).statusCode;
      expect(await status(tokens["limit-user-1"])).toBe(200);
      expect(await status(tokens["limit-user-1"])).toBe(429);
      expect(await status(tokens["limit-user-2"])).toBe(200);
    });

    it("a user is limited across its grants", async () => {
      const app = await gatewayWith({
        rateLimits: { perGrant: 50, perUser: 3, perClient: 50 },
      });
      const a = tokens["limit-user-1"];
      const b = tokens["limit-user-2"];
      const status = async (token: string) =>
        (await call(app, "orbit_projects", {}, { token })).statusCode;
      expect(await status(a)).toBe(200);
      expect(await status(a)).toBe(200);
      expect(await status(b)).toBe(200);
      const limited = await call(app, "orbit_projects", {}, { token: b });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    });

    it("a client is limited across its grants, other clients are not", async () => {
      const app = await gatewayWith({
        rateLimits: { perGrant: 50, perUser: 50, perClient: 2 },
      });
      const status = async (token: string) =>
        (await call(app, "orbit_projects", {}, { token })).statusCode;
      const a = tokens["limit-client-editor"];
      expect(await status(a)).toBe(200);
      expect(await status(a)).toBe(200);
      expect(await status(a)).toBe(429);
      expect(await status(tokens["limit-client-viewer"])).toBe(200);
    });

    it("unauthenticated requests are limited per client IP, not for others", async () => {
      const app = await gatewayWith();
      const burst = MCP_RATE_LIMITS.unauthenticatedPerIp;
      const anonymous = (ip: string) =>
        rpc(app, "tools/list", {}, { token: null, ip });
      // The valid token is verified once, from elsewhere.
      expect(
        (
          await rpc(
            app,
            "tools/list",
            {},
            { token: tokens["limit-ip"], ip: "203.0.113.200" },
          )
        ).statusCode,
      ).toBe(200);
      for (let i = 0; i < burst; i++) {
        const r = await anonymous("203.0.113.7");
        expect(r.statusCode).toBe(401);
        expect(r.headers["www-authenticate"]).toBeDefined();
      }
      const limited = await anonymous("203.0.113.7");
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(limited.headers["www-authenticate"]).toBeUndefined();
      // Another address, and a token this gateway already verified sent from
      // the same one, are unaffected (WP-M5: a token it has not seen yet is
      // counted per address before verification, see "hardening").
      expect((await anonymous("203.0.113.8")).statusCode).toBe(401);
      expect(
        (
          await rpc(
            app,
            "tools/list",
            {},
            { token: tokens["limit-ip"], ip: "203.0.113.7" },
          )
        ).statusCode,
      ).toBe(200);
    });

    it("bad tokens count against the address as well", async () => {
      const app = await gatewayWith();
      const bad = () =>
        rpc(
          app,
          "tools/list",
          {},
          { token: "not-a-token", ip: "198.51.100.9" },
        );
      for (let i = 0; i < MCP_RATE_LIMITS.unauthenticatedPerIp; i++)
        expect((await bad()).statusCode).toBe(401);
      expect((await bad()).statusCode).toBe(429);
    });
  });

  describe("subscriptions/listen", () => {
    it("is refused before the SDK holds a stream open", async () => {
      const response = await rpc(gateway, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(rpcBody(response)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
    });

    it("still needs a valid token first", async () => {
      const response = await rpc(
        gateway,
        "subscriptions/listen",
        {},
        { token: null },
      );
      expect(response.statusCode).toBe(401);
    });

    it("is refused inside a batch too", async () => {
      const response = await gateway.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          authorization: `Bearer ${tokens["audit-a"]}`,
        },
        payload: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          { jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {} },
        ]),
      });
      // The gateway refuses every batch whole (fix round 1 of WP-M3 Task 3).
      expect(response.statusCode).toBe(400);
      expect(rpcBody(response).error).toEqual({
        code: -32600,
        message: "Batch requests are not supported",
      });
    });
  });

  describe("hardening (WP-M5, D-M5-6)", () => {
    // A JWT-shaped token signed by nobody: verification would fetch keys for
    // its unknown key id.
    const forged = () =>
      [
        Buffer.from(
          JSON.stringify({ alg: "RS256", kid: `forged-${randomUUID()}` }),
        ).toString("base64url"),
        Buffer.from(JSON.stringify({ sub: "nobody" })).toString("base64url"),
        "c2lnbmF0dXJl",
      ].join(".");

    describe("unauthenticated requests are counted before verification", () => {
      it("a burst of bad tokens is refused after the limit without verifying them", async () => {
        const app = await gatewayWith({
          rateLimits: { unauthenticatedPerIp: 3 },
        });
        const ip = "198.51.100.20";
        const bad = () => rpc(app, "tools/list", {}, { token: forged(), ip });
        const before = verifications.count;
        for (let i = 0; i < 3; i++) expect((await bad()).statusCode).toBe(401);
        expect(verifications.count).toBe(before + 3);
        for (let i = 0; i < 5; i++) {
          const limited = await bad();
          expect(limited.statusCode).toBe(429);
          expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
        }
        // None of the refused ones reached token verification.
        expect(verifications.count).toBe(before + 3);
        expect(logLines.join("")).toContain('"bucket":"ip"');
      });

      it("a token this gateway verified passes from a full address; a new one waits for the window", async () => {
        const app = await gatewayWith({
          rateLimits: { unauthenticatedPerIp: 2 },
        });
        const ip = "198.51.100.30";
        const list = (token: string | null) =>
          rpc(app, "tools/list", {}, { token, ip });
        // Verified once from another address.
        expect(
          (
            await rpc(
              app,
              "tools/list",
              {},
              { token: tokens["limit-ip"], ip: "198.51.100.31" },
            )
          ).statusCode,
        ).toBe(200);
        expect((await list(null)).statusCode).toBe(401);
        expect((await list(forged())).statusCode).toBe(401);
        expect((await list(null)).statusCode).toBe(429);
        // Known token: not counted per address, verified as always.
        const before = verifications.count;
        expect((await list(tokens["limit-ip"])).statusCode).toBe(200);
        expect(verifications.count).toBe(before + 1);
        // A valid token the gateway has not verified yet is counted like
        // any unverified request (shared egress addresses: NAT trade-off).
        expect((await list(tokens["limit-window"])).statusCode).toBe(429);
        clock += 61_000;
        // Its first request in the new window is counted (one of two)...
        expect((await list(tokens["limit-window"])).statusCode).toBe(200);
        expect((await list(null)).statusCode).toBe(401);
        expect((await list(null)).statusCode).toBe(429);
        // ...then it is known: not counted, still served.
        for (let i = 0; i < 3; i++)
          expect((await list(tokens["limit-window"])).statusCode).toBe(200);
      });

      it("a full address limiter never refuses an authenticated request (separate caps)", async () => {
        const app = await gatewayWith({ ipLimiterMaxKeys: 2 });
        const anonymous = (ip: string) =>
          rpc(app, "tools/list", {}, { token: null, ip });
        const authed = (token: string, ip: string) =>
          rpc(app, "tools/list", {}, { token, ip });
        // A token verified while there was room.
        expect(
          (await authed(tokens["limit-ip"], "2001:db8:77:1::1")).statusCode,
        ).toBe(200);
        expect((await anonymous("2001:db8:77:2::1")).statusCode).toBe(401);
        // The address limiter is full: a third /64 is refused for capacity.
        const flooded = await anonymous("2001:db8:77:3::1");
        expect(flooded.statusCode).toBe(429);
        expect(logLines.join("")).toContain('"bucket":"capacity"');
        // Authenticated traffic is unaffected: a known token, and a valid
        // token this gateway never saw, from yet another address.
        expect(
          (await authed(tokens["limit-ip"], "2001:db8:77:4::1")).statusCode,
        ).toBe(200);
        expect(
          (await authed(tokens["limit-user-1"], "2001:db8:77:5::1")).statusCode,
        ).toBe(200);
        expect(
          (await authed(tokens["limit-user-2"], "2001:db8:77:6::1")).statusCode,
        ).toBe(200);
        // A bad token still gets no answer but a refusal.
        expect([401, 429]).toContain(
          (await authed(forged(), "2001:db8:77:7::1")).statusCode,
        );
        expect((await anonymous("2001:db8:77:8::1")).statusCode).toBe(429);
      });

      it("keys IPv6 clients by their /64, so rotating addresses inside it does not evade the limit", async () => {
        const app = await gatewayWith({
          rateLimits: { unauthenticatedPerIp: 3 },
        });
        const anonymous = (ip: string) =>
          rpc(app, "tools/list", {}, { token: null, ip });
        for (let i = 1; i <= 3; i++)
          expect((await anonymous(`2001:db8:5:6::${i}`)).statusCode).toBe(401);
        expect((await anonymous("2001:db8:5:6:ffff:1:2:3")).statusCode).toBe(
          429,
        );
        // Another /64 has its own bucket; IPv4-mapped is the IPv4 address.
        expect((await anonymous("2001:db8:5:7::1")).statusCode).toBe(401);
        for (let i = 0; i < 3; i++)
          expect((await anonymous("198.51.100.41")).statusCode).toBe(401);
        expect((await anonymous("::ffff:198.51.100.41")).statusCode).toBe(429);
      });
    });

    describe("DPoP-bound tokens", () => {
      type DpopKey = { privateKey: KeyObject; jwk: Record<string, unknown> };
      const dpopKey = (): DpopKey => {
        const { privateKey, publicKey } = generateKeyPairSync("ec", {
          namedCurve: "P-256",
        });
        const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
        return { privateKey, jwk: { kty, crv, x, y } };
      };
      const b64 = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      /** An RFC 9449 proof (ES256), signed with node:crypto. */
      const proof = (
        key: DpopKey,
        claims: { htu: string; ath?: string; jti?: string },
      ) => {
        const input = `${b64({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk })}.${b64(
          {
            jti: claims.jti ?? randomUUID(),
            htm: "POST",
            htu: claims.htu,
            iat: Math.floor(Date.now() / 1000),
            ...(claims.ath ? { ath: claims.ath } : {}),
          },
        )}`;
        const signature = sign("sha256", Buffer.from(input), {
          key: key.privateKey,
          dsaEncoding: "ieee-p1363",
        });
        return `${input}.${signature.toString("base64url")}`;
      };
      const ath = (token: string) =>
        createHash("sha256").update(token).digest("base64url");

      let key: DpopKey;
      let bound = "";
      beforeAll(async () => {
        key = dpopKey();
        cookie = cookies.editor;
        selection = { workspaceId, projectIds: [projectA] };
        const flow = await driver.connect({ clientId: CLIENT.dpop });
        const response = await driver.inject({
          method: "POST",
          url: "/api/auth/oauth2/token",
          session: false,
          noOrigin: true,
          headers: {
            ...FORM,
            dpop: proof(key, { htu: `${ISSUER}/oauth2/token` }),
          },
          payload: new URLSearchParams({
            grant_type: "authorization_code",
            code: flow.final.searchParams.get("code")!,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT.dpop,
            code_verifier: flow.verifier,
            resource: config.MCP_RESOURCE,
          }).toString(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as Json;
        expect(body.token_type).toBe("DPoP");
        bound = body.access_token as string;
        expect(jwtPayload(bound).cnf?.jkt).toEqual(expect.any(String));
      });

      const list = (headers: Record<string, string>) =>
        gateway.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": MODERN,
            "mcp-method": "tools/list",
            "x-forwarded-for": "198.51.100.50",
            ...headers,
          },
          payload: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                [`${META}protocolVersion`]: MODERN,
                [`${META}clientInfo`]: { name: "audit-test", version: "1" },
                [`${META}clientCapabilities`]: {},
              },
            },
          }),
        });

      it("accepts the bound token with a valid proof", async () => {
        const response = await list({
          authorization: `DPoP ${bound}`,
          dpop: proof(key, { htu: config.MCP_RESOURCE, ath: ath(bound) }),
        });
        expect(response.statusCode).toBe(200);
        expect(
          (rpcBody(response).result.tools as Json[]).map((t) => t.name),
        ).toContain("orbit_projects");
      });

      it("refuses it without a proof, as a bearer token, with a foreign key or a replayed proof", async () => {
        const refusals: Record<string, string>[] = [
          { authorization: `DPoP ${bound}` },
          { authorization: `Bearer ${bound}` },
          {
            authorization: `Bearer ${bound}`,
            dpop: proof(key, { htu: config.MCP_RESOURCE, ath: ath(bound) }),
          },
          {
            authorization: `DPoP ${bound}`,
            dpop: proof(dpopKey(), {
              htu: config.MCP_RESOURCE,
              ath: ath(bound),
            }),
          },
          {
            authorization: `DPoP ${bound}`,
            dpop: proof(key, { htu: config.MCP_RESOURCE, ath: ath("other") }),
          },
          {
            authorization: `DPoP ${bound}`,
            dpop: proof(key, {
              htu: "https://elsewhere.example/mcp",
              ath: ath(bound),
            }),
          },
        ];
        for (const headers of refusals) {
          const response = await list(headers);
          expect(response.statusCode).toBe(401);
          expect(response.headers["www-authenticate"]).toBeDefined();
        }
        const once = proof(key, {
          htu: config.MCP_RESOURCE,
          ath: ath(bound),
          jti: randomUUID(),
        });
        const headers = { authorization: `DPoP ${bound}`, dpop: once };
        expect((await list(headers)).statusCode).toBe(200);
        expect((await list(headers)).statusCode).toBe(401);
      });

      it("the protected resource metadata advertises the DPoP algorithms Better Auth supports", async () => {
        const own = await auth.handler(
          new Request(
            `${new URL(config.APP_ORIGIN).origin}/.well-known/oauth-protected-resource${new URL(config.MCP_RESOURCE).pathname}`,
          ),
        );
        expect(own.status).toBe(200);
        const expected = ((await own.json()) as Json)
          .dpop_signing_alg_values_supported;
        expect(expected).toEqual([...DPOP_SIGNING_ALGORITHMS]);
        for (const url of [
          `/.well-known/oauth-protected-resource${new URL(config.MCP_RESOURCE).pathname}`,
          "/.well-known/oauth-protected-resource",
        ]) {
          const response = await gateway.inject({ method: "GET", url });
          expect(response.json().dpop_signing_alg_values_supported).toEqual(
            expected,
          );
        }
      });
    });

    describe("per-project concurrency (R-10)", () => {
      it("a third call in one project waits, then answers BUSY; retryable for reads only", async () => {
        const records: McpCallRecord[] = [];
        const app = await gatewayWith({
          projectConcurrency: { waitMs: 150 },
          observe: (record) => void records.push(record),
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const digest = vi
          .spyOn(taskDigest, "execute")
          .mockImplementation(async () => {
            await gate;
            return { output: { total: 0 }, cards: [] };
          });
        const proposal = vi.spyOn(suggestTask, "execute");
        // Two grants of one project hold both slots.
        const running = [
          call(app, "tasks_task_digest", {}, { token: tokens["limit-user-1"] }),
          call(app, "tasks_task_digest", {}, { token: tokens["limit-user-2"] }),
        ];
        await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
        const started = Date.now();
        const busyRead = await call(
          app,
          "tasks_task_digest",
          {},
          { token: tokens["limit-window"] },
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(140);
        expect(busyRead.statusCode).toBe(200);
        expect(rpcBody(busyRead).result).toMatchObject({
          isError: true,
          structuredContent: {
            code: "BUSY",
            message:
              "too many tool calls are running in this project; try again shortly",
            retryable: true,
          },
        });
        const busyProposal = await call(
          app,
          "tasks_suggest_task",
          { title: "Busy project" },
          { token: tokens["limit-grant"] },
        );
        expect(rpcBody(busyProposal).result.structuredContent).toMatchObject({
          code: "BUSY",
          retryable: false,
        });
        expect(proposal).not.toHaveBeenCalled();
        expect(digest).toHaveBeenCalledTimes(2);
        release();
        for (const response of await Promise.all(running))
          expect(rpcBody(response).result.isError).toBeFalsy();
        expect(
          records.filter((r) => r.outcome === "BUSY").map((r) => r.projectId),
        ).toEqual([projectA, projectA]);
        // The project is free again.
        const after = await call(
          app,
          "tasks_task_digest",
          {},
          { token: tokens["limit-window"] },
        );
        expect(rpcBody(after).result.isError).toBeFalsy();
      });
    });

    describe("pre-validation matches the SDK", () => {
      it("a call the SDK refuses for the element cap is audited as INVALID_PARAMS", async () => {
        const records: McpCallRecord[] = [];
        const app = await gatewayWith({
          observe: (record) => void records.push(record),
        });
        const saved = taskDigest.parameters;
        taskDigest.parameters = z
          .object({ items: z.array(z.number()).optional() })
          .strict();
        try {
          const response = await call(
            app,
            "tasks_task_digest",
            { items: Array.from({ length: 1000 }, () => 1) },
            { token: tokens["limit-user-1"] },
          );
          expect(rpcBody(response).result.isError).toBe(true);
          expect(JSON.stringify(rpcBody(response))).toContain(
            "more than the maximum",
          );
        } finally {
          taskDigest.parameters = saved;
        }
        expect(records.map((r) => [r.tool, r.outcome])).toEqual([
          ["tasks_task_digest", "INVALID_PARAMS"],
        ]);
      });

      it("a native input schema with an async refinement is checked, not thrown on", async () => {
        const records: McpCallRecord[] = [];
        const app = await gatewayWith({
          observe: (record) => void records.push(record),
        });
        const saved = orbitProfile.inputSchema;
        orbitProfile.inputSchema = z
          .object({ name: z.string().optional() })
          .strict()
          .refine(async (value) => value.name !== "refused");
        try {
          const ok = await call(
            app,
            "orbit_profile",
            {},
            {
              token: tokens["limit-user-1"],
            },
          );
          expect(ok.statusCode).toBe(200);
          expect(rpcBody(ok).result.structuredContent).toMatchObject({
            id: ids.editor,
            effectiveScopes: expect.arrayContaining(["orbit:read"]),
          });
          const refused = await call(
            app,
            "orbit_profile",
            { name: "refused" },
            {
              token: tokens["limit-user-1"],
            },
          );
          expect(refused.statusCode).toBe(200);
          expect(rpcBody(refused).result.isError).toBe(true);
        } finally {
          orbitProfile.inputSchema = saved;
        }
        expect(records.map((r) => r.outcome)).toEqual(["ok", "INVALID_PARAMS"]);
      });

      it("registry parameters with an async refinement run instead of failing", async () => {
        const app = await gatewayWith();
        const saved = taskDigest.parameters;
        taskDigest.parameters = z
          .object({})
          .strict()
          .refine(async () => true);
        try {
          const response = await call(
            app,
            "tasks_task_digest",
            {},
            {
              token: tokens["limit-user-1"],
            },
          );
          expect(rpcBody(response).result).toMatchObject({
            structuredContent: { total: expect.any(Number) },
          });
          expect(rpcBody(response).result.isError).toBeFalsy();
        } finally {
          taskDigest.parameters = saved;
        }
      });
    });
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, DomainError } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { cancelActionRequest } from "../src/modules/action-requests.ts";
import { assignmentTools } from "../src/modules/marketing/tools/assignment-tools.ts";
import { actionStatusTool } from "../src/platform/mcp/native/action-status.ts";
import { timeoutResult, toolFailure } from "../src/platform/mcp/errors.ts";
import {
  McpRateLimiter,
  MCP_PROPOSAL_WINDOW_MS,
} from "../src/platform/mcp/limits.ts";
import type { McpCallRecord } from "../src/platform/mcp/adapter.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  authorizeMcpCall,
  visibleMcpTools,
} from "../src/platform/mcp/visibility.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";
import { createPackageProject, X } from "./support/package-project.ts";

// Track M WP-M4, Task 3: the central proposal switch, per-grant quotas,
// non-retryable failures of write tools and the native `orbit_action_status`,
// through the gateway with real WP-M1 tokens.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const TOOL = "marketing_assignment_propose";
const STATUS = "orbit_action_status";
const HOUR = 3_600_000;

const names = [
  "editor",
  "other",
  "viewer",
  "hour",
  "hour-other",
  "dedupe",
  "day",
  "timeout",
  "reselect",
  "recorded",
  "concurrent",
  "refund",
  "logged",
] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/proposal-controls-${n}.json`]),
) as Record<Name, string>;
const cimdFetch = cimdFetchFor(
  Object.fromEntries(Object.values(CLIENT).map((id) => [id, metadata(id)])),
);

const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(values);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

const rpcBody = (response: { body: string }): Json =>
  response.body === "" ? {} : (JSON.parse(response.body) as Json);

const proposeArgs = (changes: Json = {}): Json => ({
  name: `MCP controls post ${randomUUID()}`,
  kind: "standing",
  schedule: {
    rhythm: "daily",
    weekdays: [],
    times: ["09:00"],
    date: null,
    leadMinutes: null,
  },
  contentType: "social",
  channels: [X],
  topicFrame: "Short updates about beta access for product teams",
  tone: null,
  image: false,
  styleAssetIds: [],
  vetoMinutes: null,
  monthlyBudgetMicros: 1_000_000,
  delivery: null,
  sharedAcrossChannels: null,
  format: null,
  banner: null,
  ...changes,
});

const startOfUtcDay = (ms: number) => ms - (ms % 86_400_000);

/**
 * Two clock skews an hour apart that both stay inside today's UTC day, so a
 * test that waits out the hourly window never moves the gateway into the
 * next day (review M6): from an hour back to now, or, in the first hour of
 * the day, from now to an hour ahead.
 */
function hourApart(): [number, number] {
  const sinceMidnight = Date.now() - startOfUtcDay(Date.now());
  return sinceMidnight > HOUR + 60_000 ? [-(HOUR + 1000), 0] : [0, HOUR + 1000];
}

/**
 * A clock skew that keeps the gateway at least ten minutes before the next
 * UTC midnight, so a test that seeds "today" and then lets the gateway count
 * from `startOfUtcDay(now)` never sees the day change in between: no skew,
 * or, in the last ten minutes of the day, an hour back.
 */
function sameUtcDaySkew(): number {
  const untilMidnight = startOfUtcDay(Date.now()) + 86_400_000 - Date.now();
  return untilMidnight > 10 * 60_000 ? 0 : -HOUR;
}

describe("proposal quota windows (limiter)", () => {
  it("counts a rule in its own window and leaves the 60 s rules alone", () => {
    let now = 1_000_000;
    const limiter = new McpRateLimiter(() => now);
    const hourly = {
      key: "proposal:g",
      max: 2,
      label: "proposal",
      windowMs: MCP_PROPOSAL_WINDOW_MS,
    };
    const minute = { key: "grant:g", max: 1 };
    expect(MCP_PROPOSAL_WINDOW_MS).toBe(HOUR);
    expect(limiter.take([minute]).allowed).toBe(true);
    expect(limiter.check([hourly]).allowed).toBe(true);
    limiter.charge([hourly]);
    limiter.charge([hourly]);
    // check never counts; the hourly bucket is full, the minute one is not.
    expect(limiter.check([hourly])).toMatchObject({
      allowed: false,
      label: "proposal",
    });
    now += 61_000;
    // The minute window is over, the hour window is not.
    expect(limiter.take([minute]).allowed).toBe(true);
    expect(limiter.check([hourly]).allowed).toBe(false);
    const wait = limiter.check([hourly]);
    expect(wait.allowed === false && wait.retryAfterSeconds).toBeGreaterThan(
      3000,
    );
    now += HOUR;
    expect(limiter.check([hourly]).allowed).toBe(true);
    // Sweeping drops expired windows of either length.
    limiter.take([{ key: "other", max: 5 }]);
    now += 61_000;
    limiter.take([{ key: "other", max: 5 }]);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});

describe("failure retryability by tool risk (errors)", () => {
  it("never hints a retry for proposals and internal writes", () => {
    const unavailable = new DomainError("UPSTREAM_DOWN", 503);
    const limited = new DomainError("SLOW_DOWN", 429);
    for (const risk of ["P_proposal", "W0_internal"] as const) {
      expect(
        toolFailure(unavailable, "r", risk).result.structuredContent,
      ).toMatchObject({ code: "UPSTREAM_DOWN", retryable: false });
      expect(
        toolFailure(limited, "r", risk).result.structuredContent,
      ).toMatchObject({ retryable: false });
    }
    expect(
      toolFailure(unavailable, "r", "R0_read").result.structuredContent,
    ).toMatchObject({ retryable: true });
  });

  it("answers a timeout with a retry hint for reads only", () => {
    for (const risk of ["P_proposal", "W0_internal"] as const)
      expect(timeoutResult(risk).structuredContent).toMatchObject({
        code: "TIMEOUT",
        retryable: false,
      });
    expect(timeoutResult("R0_read").structuredContent).toMatchObject({
      retryable: true,
    });
  });
});

describe.skipIf(!enabled)("MCP proposal controls", () => {
  let api: Awaited<ReturnType<typeof buildServer>>;
  let gateway: FastifyInstance;
  let quotaGateway: FastifyInstance;
  let timeoutGateway: FastifyInstance;
  let observedGateway: FastifyInstance;
  let auth: ReturnType<typeof makeAuth>;
  let config: ReturnType<typeof loadConfig>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let foreign: Awaited<ReturnType<typeof createPackageProject>>;
  let jwksUrl = "";
  let cookie = "";
  const cookies = {} as Record<"owner" | "editor" | "viewer", string>;
  const ids = {} as Record<"owner" | "editor" | "viewer", string>;
  const users: string[] = [];
  const tokens = {} as Record<Name, string>;
  const records: McpCallRecord[] = [];
  // The quota gateway's clock: tests move it, never the wall clock.
  let skew = 0;
  let savedAgents: string | undefined;
  let savedProposals: string | undefined;

  const driver = createFlowDriver({
    app: () => api,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({
      workspaceId: project.owner.workspaceId,
      projectIds: [project.owner.projectId],
    }),
    defaultClientId: CLIENT.editor,
  });
  const projectId = () => project.owner.projectId;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);

  async function tokenFor(name: Name, who: "editor" | "viewer") {
    cookie = cookies[who];
    const flow = await driver.connect({ clientId: CLIENT[name] });
    const response = await driver.exchange(flow, { client_id: CLIENT[name] });
    expect(response.statusCode).toBe(200);
    return (response.json() as Json).access_token as string;
  }

  function rpc(
    method: string,
    params: Json,
    token: string,
    app: FastifyInstance = gateway,
  ) {
    return app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [`${META}protocolVersion`]: MODERN,
            [`${META}clientInfo`]: { name: "proposal-controls", version: "1" },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
    });
  }
  async function callBody(
    name: string,
    args: Json,
    who: Name = "editor",
    app: FastifyInstance = gateway,
  ) {
    const response = await rpc(
      "tools/call",
      { name, arguments: args },
      tokens[who],
      app,
    );
    expect(response.statusCode).toBe(200);
    return rpcBody(response);
  }
  const propose = async (
    args: Json,
    who: Name = "editor",
    app: FastifyInstance = gateway,
  ) => (await callBody(TOOL, args, who, app)).result as Json;
  const status = async (
    actionRequestId: string,
    who: Name = "editor",
    pid: string = projectId(),
    app: FastifyInstance = gateway,
  ) =>
    (await callBody(STATUS, { projectId: pid, actionRequestId }, who, app))
      .result as Json;
  const listTools = async (who: Name, app: FastifyInstance = gateway) =>
    (
      rpcBody(await rpc("tools/list", {}, tokens[who], app)).result
        .tools as Json[]
    ).map((tool) => tool.name as string);

  const grantOf = (name: Name) =>
    authDb.mcpGrant.findFirstOrThrow({
      where: { clientId: CLIENT[name], revokedAt: null },
    });
  const proposalEvents = async (name: Name) =>
    authDb.mcpGrantEvent.findMany({
      where: { grantId: (await grantOf(name)).id, action: "mcp.proposal" },
    });
  const requestCount = () =>
    run((tx) => tx.entity.count({ where: { kind: "action_requests" } }));
  const principalOf = async (name: Name): Promise<McpPrincipal> => ({
    userId: ids.editor,
    clientId: CLIENT[name],
    grantId: (await grantOf(name)).id,
    workspaceId: project.owner.workspaceId,
    scopes: new Set(["orbit:read", "orbit:propose"]),
    projectIds: [projectId()],
    modules: [],
  });

  /** A stored request row as the module would write it. */
  const seedRequest = (
    requestedBy: Json,
    over: Json = {},
    scope = project.owner,
  ) =>
    scoped(scope.workspaceId, scope.projectId, (tx) =>
      create(tx, scope, "action_requests", {
        actionType: "assignment.confirm",
        riskClass: "W0_internal",
        approvalMode: "approval_required",
        policy: { id: randomUUID(), version: 1 },
        requestedBy,
        payload: { secretPayloadMarker: "must-not-leak" },
        packageHash: "a".repeat(64),
        costCeilingMicros: 0,
        status: "pending",
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
        ...over,
      }),
    );
  const mcpRequester = async (name: Name, over: Json = {}) => ({
    kind: "mcp",
    userId: ids.editor,
    clientId: CLIENT[name],
    grantId: (await grantOf(name)).id,
    agentRunId: null,
    argsHash: "b".repeat(64),
    ...over,
  });

  beforeAll(async () => {
    savedAgents = process.env.ORBIT_AGENTS;
    savedProposals = process.env.ORBIT_MCP_PROPOSALS;
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_MCP_PROPOSALS = "true";
    await withEnv(FLAGS, async () => {
      config = loadConfig();
      api = await buildServer(undefined, { cimdFetch });
      auth = makeAuth({ cimdFetch });
      await api.listen({ port: 0, host: "127.0.0.1" });
      jwksUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`;
      gateway = await buildMcpServer({ cimdFetch, jwksUrl });
      quotaGateway = await buildMcpServer({
        cimdFetch,
        jwksUrl,
        rateLimits: { proposalsPerHour: 2, proposalsPerDay: 3 },
        clock: () => Date.now() + skew,
      });
      timeoutGateway = await buildMcpServer({
        cimdFetch,
        jwksUrl,
        toolTimeoutMs: 150,
        observe: (record) => void records.push(record),
      });
      observedGateway = await buildMcpServer({
        cimdFetch,
        jwksUrl,
        observe: (record) => void records.push(record),
      });
    });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });
    project = await createPackageProject({ name: "Synthetic MCP controls" });
    foreign = await createPackageProject({ name: "Synthetic MCP foreign" });

    const password = randomBytes(24).toString("base64url");
    const emails = {} as Record<"owner" | "editor" | "viewer", string>;
    for (const who of ["owner", "editor", "viewer"] as const) {
      emails[who] = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: {
          email: emails[who],
          name: `Synthetic controls ${who}`,
          password,
        },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
    }
    const { workspaceId, projectId: pid } = project.owner;
    await authDb.workspaceMember.create({
      data: { workspaceId, userId: ids.owner, role: "owner" },
    });
    for (const who of ["editor", "viewer"] as const) {
      await authDb.workspaceMember.create({
        data: { workspaceId, userId: ids[who], role: "viewer" },
      });
      await authDb.projectMember.create({
        data: { workspaceId, projectId: pid, userId: ids[who], role: who },
      });
    }
    for (const who of ["owner", "editor", "viewer"] as const) {
      const signIn = await driver.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email: emails[who], password },
      });
      expect(signIn.statusCode).toBe(200);
      const set = signIn.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set!])
        .map((v) => v.split(";")[0])
        .join("; ");
    }
    for (const name of names)
      tokens[name] = await tokenFor(
        name,
        name === "viewer" ? "viewer" : "editor",
      );
  }, 240_000);

  afterEach(() => {
    vi.restoreAllMocks();
    skew = 0;
    process.env.ORBIT_MCP_PROPOSALS = "true";
    records.length = 0;
  });

  afterAll(async () => {
    if (savedAgents === undefined) delete process.env.ORBIT_AGENTS;
    else process.env.ORBIT_AGENTS = savedAgents;
    if (savedProposals === undefined) delete process.env.ORBIT_MCP_PROPOSALS;
    else process.env.ORBIT_MCP_PROPOSALS = savedProposals;
    for (const app of [gateway, quotaGateway, timeoutGateway, observedGateway])
      await app?.close();
    await api?.close();
    await project?.cleanup();
    await foreign?.cleanup();
    await authDb.mcpGrantEvent.deleteMany({
      where: { userId: { in: users } },
    });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  describe("central switch ORBIT_MCP_PROPOSALS", () => {
    it("is off by default and compose-safe", async () => {
      await withEnv({ ORBIT_MCP_PROPOSALS: undefined }, async () => {
        expect(loadConfig().ORBIT_MCP_PROPOSALS).toBe("false");
      });
      await withEnv({ ORBIT_MCP_PROPOSALS: "" }, async () => {
        expect(loadConfig().ORBIT_MCP_PROPOSALS).toBe("false");
      });
      await withEnv({ ORBIT_MCP_PROPOSALS: "true" }, async () => {
        expect(loadConfig().ORBIT_MCP_PROPOSALS).toBe("true");
      });
    });

    it("hides and refuses the proposal tool while off; read tools stay", async () => {
      expect(await listTools("editor")).toContain(TOOL);
      const before = await requestCount();
      await withEnv({ ORBIT_MCP_PROPOSALS: "false" }, async () => {
        const tools = await listTools("editor");
        expect(tools).not.toContain(TOOL);
        expect(tools).toContain("orbit_projects");
        expect(tools).toContain(STATUS);
        expect(tools).toContain("marketing_project_status");
        // The call is refused like any unlisted tool (JSON-RPC, no result).
        const body = await callBody(TOOL, proposeArgs());
        expect(body.error?.code).toBe(-32602);
        expect(body.result).toBeUndefined();
        // The central gate sits in the shared visibility check.
        const principal = await principalOf("editor");
        expect(
          (await visibleMcpTools(principal, projectId())).map((t) => t.name),
        ).not.toContain("assignment_propose");
        await expect(
          authorizeMcpCall(principal, "assignment_propose", projectId()),
        ).rejects.toMatchObject({ code: "MCP_TOOL_NOT_ALLOWED", status: 403 });
        const read = await callBody("orbit_projects", {});
        expect(read.result.isError).toBeFalsy();
      });
      expect(await requestCount()).toBe(before);
      // Switched on again: listed and callable.
      expect(await listTools("editor")).toContain(TOOL);
      const principal = await principalOf("editor");
      await expect(
        authorizeMcpCall(principal, "assignment_propose", projectId()),
      ).resolves.toMatchObject({ tool: { name: "assignment_propose" } });
    });
  });

  describe("quotas", () => {
    it("refuses the call after the hourly quota of a grant, per grant, and frees it after the window", async () => {
      const [start, later] = hourApart();
      skew = start;
      const first = await propose(proposeArgs(), "hour", quotaGateway);
      const second = await propose(proposeArgs(), "hour", quotaGateway);
      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      const before = await requestCount();
      const eventsBefore = (await proposalEvents("hour")).length;

      const refused = await propose(proposeArgs(), "hour", quotaGateway);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toEqual({
        code: "PROPOSAL_QUOTA_EXCEEDED",
        message: "the proposal quota of this connection is used up for now",
        retryable: false,
      });
      expect(JSON.parse(refused.content[0].text)).toEqual(
        refused.structuredContent,
      );
      expect(await requestCount()).toBe(before);
      expect((await proposalEvents("hour")).length).toBe(eventsBefore);

      // Another grant has its own bucket; reads are not proposals.
      const other = await propose(proposeArgs(), "hour-other", quotaGateway);
      expect(other.isError).toBeFalsy();
      const read = await callBody("orbit_projects", {}, "hour", quotaGateway);
      expect(read.result.isError).toBeFalsy();

      // After the window the grant may propose again.
      skew = later;
      const again = await propose(proposeArgs(), "hour", quotaGateway);
      expect(again.isError).toBeFalsy();
    });

    it("audits the refusal as PROPOSAL_QUOTA_EXCEEDED", async () => {
      const limited = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          rateLimits: { proposalsPerHour: 1 },
          observe: (record) => void records.push(record),
        }),
      );
      try {
        // "timeout" has made no proposal on the other gateways.
        expect(
          (await propose(proposeArgs(), "timeout", limited)).isError,
        ).toBeFalsy();
        const refused = await propose(proposeArgs(), "timeout", limited);
        expect(refused.structuredContent.code).toBe("PROPOSAL_QUOTA_EXCEEDED");
      } finally {
        await limited.close();
      }
      expect(records.map((r) => [r.tool, r.projectId, r.outcome])).toEqual([
        [TOOL, projectId(), "ok"],
        [TOOL, projectId(), "PROPOSAL_QUOTA_EXCEEDED"],
      ]);
    });

    it("a deduplicated call does not use up the quota", async () => {
      const args = proposeArgs();
      const created = await propose(args, "dedupe", quotaGateway);
      expect(created.structuredContent.deduplicated).toBe(false);
      const again = await propose(args, "dedupe", quotaGateway);
      expect(again.structuredContent).toMatchObject({
        deduplicated: true,
        actionRequestId: created.structuredContent.actionRequestId,
      });
      // Two creations fit the quota of 2 although three calls were made.
      const second = await propose(proposeArgs(), "dedupe", quotaGateway);
      expect(second.isError).toBeFalsy();
      expect(second.structuredContent.deduplicated).toBe(false);
      const third = await propose(proposeArgs(), "dedupe", quotaGateway);
      expect(third.structuredContent.code).toBe("PROPOSAL_QUOTA_EXCEEDED");
    });

    it("counts the daily quota from the mcp.proposal events of the user, client and workspace since the UTC day start", async () => {
      const grant = await grantOf("day");
      skew = sameUtcDaySkew();
      const now = Date.now() + skew;
      const today = new Date(now);
      const yesterday = new Date(startOfUtcDay(now) - HOUR);
      const event = (
        createdAt: Date,
        grantId: string = grant.id,
        clientId: string = CLIENT.day,
      ) => ({
        action: "mcp.proposal",
        userId: ids.editor,
        clientId,
        grantId,
        workspaceId: project.owner.workspaceId,
        detail: { tool: TOOL },
        createdAt,
      });
      await authDb.mcpGrantEvent.createMany({
        data: [
          // Two today count, also one of an earlier grant of the same user
          // and client (a re-selection); older ones, another client's and
          // other actions do not.
          event(today),
          event(today, randomUUID()),
          event(yesterday),
          event(yesterday),
          event(yesterday),
          event(today, (await grantOf("viewer")).id, CLIENT.viewer),
          { ...event(today), action: "mcp.call" },
        ],
      });
      // The daily limit of this gateway is 3: one more fits.
      const third = await propose(proposeArgs(), "day", quotaGateway);
      expect(third.isError).toBeFalsy();
      // Now 3 events today (two seeded, one created): the next is refused.
      const refused = await propose(proposeArgs(), "day", quotaGateway);
      expect(refused.structuredContent).toMatchObject({
        code: "PROPOSAL_QUOTA_EXCEEDED",
        retryable: false,
      });
      expect(
        (await proposalEvents("day")).filter((e) => e.createdAt >= yesterday)
          .length,
      ).toBe(5);
    });

    it("a re-selection (a new grant) does not reset the hourly or the daily quota", async () => {
      const [start, later] = hourApart();
      skew = start;
      const before = (await grantOf("reselect")).id;
      for (let i = 0; i < 2; i += 1)
        expect(
          (await propose(proposeArgs(), "reselect", quotaGateway)).isError,
        ).toBeFalsy();
      expect(
        (await propose(proposeArgs(), "reselect", quotaGateway))
          .structuredContent.code,
      ).toBe("PROPOSAL_QUOTA_EXCEEDED");
      // Reconnect: the same user and client get a new grant.
      tokens.reselect = await tokenFor("reselect", "editor");
      const after = (await grantOf("reselect")).id;
      expect(after).not.toBe(before);
      const hourly = await propose(proposeArgs(), "reselect", quotaGateway);
      expect(hourly.structuredContent.code).toBe("PROPOSAL_QUOTA_EXCEEDED");
      // A new hour: the third creation of the day fits, the fourth not.
      skew = later;
      expect(
        (await propose(proposeArgs(), "reselect", quotaGateway)).isError,
      ).toBeFalsy();
      const daily = await propose(proposeArgs(), "reselect", quotaGateway);
      expect(daily.structuredContent.code).toBe("PROPOSAL_QUOTA_EXCEEDED");
      // Neither does a further reconnect.
      tokens.reselect = await tokenFor("reselect", "editor");
      expect((await grantOf("reselect")).id).not.toBe(after);
      const again = await propose(proposeArgs(), "reselect", quotaGateway);
      expect(again.structuredContent.code).toBe("PROPOSAL_QUOTA_EXCEEDED");
      // The three creations are recorded on the two grants that made them.
      const recorded = await authDb.mcpGrantEvent.findMany({
        where: { clientId: CLIENT.reselect, action: "mcp.proposal" },
      });
      expect(recorded).toHaveLength(3);
      expect(new Set(recorded.map((e) => e.grantId))).toEqual(
        new Set([before, after]),
      );
    });

    it("the gateway records mcp.proposal for every created proposal, never for a deduplicated one", async () => {
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      const output = (actionRequestId: string, deduplicated: boolean) => ({
        output: {
          status: "pending_approval",
          actionRequestId,
          assignmentId: randomUUID(),
          expiresAt: new Date(Date.now() + HOUR).toISOString(),
          approveUrl: "https://orbit.test/p/x/approvals",
          deduplicated,
        },
        cards: [],
      });
      const created = randomUUID();
      const reused = randomUUID();
      // The tool records nothing itself: only the adapter can write these.
      vi.spyOn(tool, "execute")
        .mockResolvedValueOnce(output(created, false))
        .mockResolvedValueOnce(output(reused, true));
      expect((await propose(proposeArgs(), "recorded")).isError).toBeFalsy();
      expect((await propose(proposeArgs(), "recorded")).isError).toBeFalsy();
      const grant = await grantOf("recorded");
      const recorded = await authDb.mcpGrantEvent.findMany({
        where: { clientId: CLIENT.recorded, action: "mcp.proposal" },
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        userId: ids.editor,
        clientId: CLIENT.recorded,
        grantId: grant.id,
        workspaceId: project.owner.workspaceId,
        detail: { tool: TOOL, actionRequestId: created },
      });
    });

    it("a failed mcp.proposal write is logged and leaves the created proposal's result alone", async () => {
      const lines: string[] = [];
      const level = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "info";
      const logged = await withEnv(FLAGS, () =>
        buildMcpServer({
          cimdFetch,
          jwksUrl,
          logStream: { write: (line: string) => void lines.push(line) },
        }),
      );
      if (level === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = level;
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      const actionRequestId = randomUUID();
      vi.spyOn(tool, "execute").mockResolvedValueOnce({
        output: {
          status: "pending_approval",
          actionRequestId,
          assignmentId: randomUUID(),
          expiresAt: new Date(Date.now() + HOUR).toISOString(),
          approveUrl: "https://orbit.test/p/x/approvals",
          deduplicated: false,
        },
        cards: [],
      });
      vi.spyOn(authDb.mcpGrantEvent, "create").mockRejectedValueOnce(
        new Error("synthetic event write failure"),
      );
      try {
        const result = await propose(proposeArgs(), "logged", logged);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ actionRequestId });
      } finally {
        await logged.close();
      }
      expect(
        await authDb.mcpGrantEvent.count({
          where: {
            clientId: CLIENT.logged,
            action: "mcp.proposal",
            detail: { path: ["actionRequestId"], equals: actionRequestId },
          },
        }),
      ).toBe(0);
      // Logged with what reconciles the short daily count, never the message.
      const failures = lines
        .map((line) => JSON.parse(line) as Json)
        .filter((entry) => entry.code === "MCP_PROPOSAL_RECORD_FAILED");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        level: 50,
        tool: TOOL,
        actionRequestId,
        clientId: CLIENT.logged,
        workspaceId: project.owner.workspaceId,
        errorName: "Error",
        msg: "mcp proposal event not recorded",
      });
      expect(lines.join("\n")).not.toContain("synthetic event write failure");
    });

    it("concurrent proposals of one key cannot pass the hourly quota together", async () => {
      // One of two used; three at once: only one more may be created.
      expect(
        (await propose(proposeArgs(), "concurrent", quotaGateway)).isError,
      ).toBeFalsy();
      const results = await Promise.all(
        [0, 1, 2].map(() => propose(proposeArgs(), "concurrent", quotaGateway)),
      );
      expect(results.filter((r) => !r.isError)).toHaveLength(1);
      expect(
        results.filter((r) => r.isError).map((r) => r.structuredContent.code),
      ).toEqual(["PROPOSAL_QUOTA_EXCEEDED", "PROPOSAL_QUOTA_EXCEEDED"]);
    });

    it("a failed proposal call gives its hourly room back", async () => {
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      vi.spyOn(tool, "execute").mockRejectedValueOnce(
        new DomainError("PROVIDER_UNAVAILABLE", 503),
      );
      const failed = await propose(proposeArgs(), "refund", quotaGateway);
      expect(failed.structuredContent.code).toBe("PROVIDER_UNAVAILABLE");
      // The quota of 2 is still whole.
      for (let i = 0; i < 2; i += 1)
        expect(
          (await propose(proposeArgs(), "refund", quotaGateway)).isError,
        ).toBeFalsy();
      expect(
        (await propose(proposeArgs(), "refund", quotaGateway)).structuredContent
          .code,
      ).toBe("PROPOSAL_QUOTA_EXCEEDED");
    });
  });

  describe("failures of proposals are not retryable", () => {
    it("answers TIMEOUT with retryable false for a proposal tool", async () => {
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      vi.spyOn(tool, "execute").mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const result = await propose(proposeArgs(), "timeout", timeoutGateway);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        code: "TIMEOUT",
        message: "the tool did not finish in time; its work may still complete",
        retryable: false,
      });
      expect(JSON.parse(result.content[0].text)).toEqual(
        result.structuredContent,
      );
    });

    it("a transient upstream failure of a proposal tool is not retryable either", async () => {
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      vi.spyOn(tool, "execute").mockRejectedValueOnce(
        new DomainError("PROVIDER_UNAVAILABLE", 503),
      );
      const result = await propose(proposeArgs(), "timeout", timeoutGateway);
      expect(result.structuredContent).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        retryable: false,
      });
    });
  });

  describe("orbit_action_status", () => {
    it("has a fixed definition without internals (snapshot)", async () => {
      const tool = (
        rpcBody(await rpc("tools/list", {}, tokens.editor)).result
          .tools as Json[]
      ).find((t) => t.name === STATUS)!;
      const {
        name,
        description,
        inputSchema,
        outputSchema,
        annotations,
        _meta,
      } = tool;
      expect({
        name,
        description,
        inputSchema,
        outputSchema,
        annotations,
        _meta,
      }).toMatchInlineSnapshot(`
        {
          "_meta": {
            "securitySchemes": [
              {
                "scopes": [
                  "orbit:read",
                ],
                "type": "oauth2",
              },
            ],
          },
          "annotations": {
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Check the state of a proposal this connection made (pending, approved, rejected, consumed, canceled or expired), with the link where the owner decides.",
          "inputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "actionRequestId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string",
              },
              "projectId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string",
              },
            },
            "required": [
              "projectId",
              "actionRequestId",
            ],
            "type": "object",
          },
          "name": "orbit_action_status",
          "outputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "actionRequestId": {
                "type": "string",
              },
              "actionType": {
                "type": "string",
              },
              "approveUrl": {
                "type": "string",
              },
              "createdAt": {
                "type": "string",
              },
              "decidedAt": {
                "type": [
                  "string",
                  "null",
                ],
              },
              "expiresAt": {
                "type": "string",
              },
              "status": {
                "enum": [
                  "pending",
                  "approved",
                  "rejected",
                  "consumed",
                  "canceled",
                  "expired",
                ],
                "type": "string",
              },
            },
            "required": [
              "actionRequestId",
              "actionType",
              "status",
              "createdAt",
              "expiresAt",
              "decidedAt",
              "approveUrl",
            ],
            "type": "object",
          },
        }
      `);
      expect(Object.keys(outputSchema.properties).sort()).toEqual([
        "actionRequestId",
        "actionType",
        "approveUrl",
        "createdAt",
        "decidedAt",
        "expiresAt",
        "status",
      ]);
      expect(outputSchema.additionalProperties).toBe(false);
      expect(inputSchema.additionalProperties).toBe(false);
      const text = JSON.stringify({ inputSchema, outputSchema });
      for (const word of [
        "payload",
        "packageHash",
        "policy",
        "userId",
        "requestedBy",
        "grantId",
        "clientId",
        "argsHash",
      ])
        expect(text).not.toContain(word);
    });

    it("is listed for read-only connections, with and without the proposal switch", async () => {
      expect(await listTools("viewer")).toContain(STATUS);
      await withEnv({ ORBIT_MCP_PROPOSALS: "false" }, async () => {
        expect(await listTools("editor")).toContain(STATUS);
      });
    });

    it("reports a pending proposal of the grant and nothing else", async () => {
      const proposal = (await propose(proposeArgs())).structuredContent;
      const result = await status(proposal.actionRequestId);
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent;
      expect(out).toEqual({
        actionRequestId: proposal.actionRequestId,
        actionType: "assignment.confirm",
        status: "pending",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        expiresAt: proposal.expiresAt,
        decidedAt: null,
        approveUrl: proposal.approveUrl,
      });
      expect(JSON.parse(result.content[0].text)).toEqual(out);
      const text = JSON.stringify(out);
      for (const word of ["payload", "packageHash", "policy", ids.editor])
        expect(text).not.toContain(word);
      expect(Object.keys(out).sort()).toEqual([
        "actionRequestId",
        "actionType",
        "approveUrl",
        "createdAt",
        "decidedAt",
        "expiresAt",
        "status",
      ]);
    });

    it("reports every status, with expiry derived for pending requests only", async () => {
      const requester = await mcpRequester("editor");
      const past = new Date(Date.now() - HOUR).toISOString();
      const decidedAt = new Date(Date.now() - 1000).toISOString();
      const decision = (kind: string) => ({
        userId: ids.owner,
        decision: kind,
        decidedAt,
        channel: "web",
      });
      const approved = await seedRequest(requester, {
        status: "approved",
        decision: decision("approve"),
      });
      const rejected = await seedRequest(requester, {
        status: "rejected",
        decision: decision("reject"),
      });
      const consumed = await seedRequest(requester, {
        status: "consumed",
        decision: decision("approve"),
        consumedBy: { executionId: "e", consumedAt: decidedAt },
      });
      const expiredPending = await seedRequest(requester, { expiresAt: past });
      // An approved request stays approved: assignments run on approval.
      const approvedLong = await seedRequest(requester, {
        status: "approved",
        decision: decision("approve"),
        expiresAt: past,
      });
      const canceled = await seedRequest(requester);
      await run((tx) => cancelActionRequest(tx, project.owner, canceled.id));

      const read = async (id: string) =>
        (await status(id)).structuredContent as Json;
      expect(await read(approved.id)).toMatchObject({
        status: "approved",
        decidedAt,
      });
      expect(await read(rejected.id)).toMatchObject({
        status: "rejected",
        decidedAt,
      });
      expect(await read(consumed.id)).toMatchObject({
        status: "consumed",
        decidedAt,
      });
      expect(await read(expiredPending.id)).toMatchObject({
        status: "expired",
        decidedAt: null,
        expiresAt: past,
      });
      expect(await read(approvedLong.id)).toMatchObject({
        status: "approved",
      });
      expect(await read(canceled.id)).toMatchObject({
        status: "canceled",
        decidedAt: null,
      });
    });

    it("follows the owner's decision of a real proposal", async () => {
      const proposal = (await propose(proposeArgs())).structuredContent;
      const row = await run((tx) =>
        tx.entity.findFirstOrThrow({
          where: { id: proposal.actionRequestId, kind: "action_requests" },
        }),
      );
      cookie = cookies.owner;
      const decided = await driver.inject({
        method: "POST",
        url: `/api/projects/${projectId()}/action-requests/${proposal.actionRequestId}/decide`,
        payload: {
          version: row.version,
          packageHash: data(row).packageHash,
          decision: "approve",
        },
      });
      expect(decided.statusCode).toBe(200);
      const out = (await status(proposal.actionRequestId)).structuredContent;
      expect(out).toMatchObject({ status: "approved" });
      expect(Date.parse(out.decidedAt)).not.toBeNaN();
    });

    it("answers one identical NOT_FOUND for everything that is not this user's through this client", async () => {
      const mine = await seedRequest(await mcpRequester("editor"));
      const otherGrants = await seedRequest(await mcpRequester("other"));
      const human = await seedRequest({ kind: "user", userId: ids.editor });
      const agent = await seedRequest({
        kind: "agent",
        userId: ids.editor,
        agentRunId: null,
      });
      // The grant's user, a different client of the same user: not this grant.
      const sameUserOtherClient = await seedRequest(
        await mcpRequester("editor", {
          clientId: CLIENT.other,
          grantId: (await grantOf("other")).id,
        }),
      );
      // The same client, another user of the workspace.
      const sameClientOtherUser = await seedRequest(
        await mcpRequester("editor", { userId: ids.viewer }),
      );
      const foreignRow = await seedRequest(
        {
          kind: "mcp",
          userId: ids.editor,
          clientId: CLIENT.editor,
          grantId: (await grantOf("editor")).id,
          agentRunId: null,
          argsHash: "c".repeat(64),
        },
        {},
        foreign.owner,
      );
      expect((await status(mine.id)).isError).toBeFalsy();

      const refusals = [
        await status(otherGrants.id),
        await status(human.id),
        await status(agent.id),
        await status(sameUserOtherClient.id),
        await status(sameClientOtherUser.id),
        // A request of another project, asked with a granted project.
        await status(foreignRow.id),
        // An unknown request.
        await status(randomUUID()),
        // A project outside the grant (the request exists there).
        await status(foreignRow.id, "editor", foreign.owner.projectId),
        await status(mine.id, "editor", randomUUID()),
      ];
      for (const refusal of refusals) {
        expect(refusal.isError).toBe(true);
        expect(refusal.structuredContent).toEqual({
          code: "NOT_FOUND",
          message: "NOT FOUND",
          retryable: false,
        });
        expect(refusal.content).toEqual(refusals[0]!.content);
      }
    });

    it("answers for the same user and client across grants, e.g. after a re-selection replaced the grant", async () => {
      // A proposal of an earlier grant of this user and client.
      const earlier = await seedRequest(
        await mcpRequester("editor", { grantId: randomUUID() }),
      );
      const out = await status(earlier.id);
      expect(out.isError).toBeFalsy();
      expect(out.structuredContent).toMatchObject({
        actionRequestId: earlier.id,
        status: "pending",
      });
    });

    it("refuses a malformed id at the input schema, before the tool runs", async () => {
      // The strict input schema (two uuids) is the SDK's to enforce: the
      // answer names the path and the rule, never a lookup result.
      const run = vi.spyOn(actionStatusTool, "run");
      for (const args of [
        { projectId: projectId(), actionRequestId: "not-a-uuid" },
        { projectId: "nope", actionRequestId: randomUUID() },
        { projectId: projectId() },
        { projectId: projectId(), actionRequestId: randomUUID(), extra: 1 },
      ]) {
        const result = (await callBody(STATUS, args)).result as Json;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/^Input validation error/);
        expect(result.structuredContent).toBeUndefined();
      }
      expect(run).not.toHaveBeenCalled();
    });

    it("still answers after the proposal switch is turned off", async () => {
      const proposal = (await propose(proposeArgs())).structuredContent;
      await withEnv({ ORBIT_MCP_PROPOSALS: "false" }, async () => {
        const out = await status(proposal.actionRequestId);
        expect(out.structuredContent).toMatchObject({
          status: "pending",
          actionRequestId: proposal.actionRequestId,
        });
      });
    });

    it("is audited in the polled project when it is the grant's, otherwise without a project", async () => {
      const mine = await seedRequest(await mcpRequester("editor"));
      await status(mine.id, "editor", projectId(), observedGateway);
      await status(
        randomUUID(),
        "editor",
        foreign.owner.projectId,
        observedGateway,
      );
      expect(records).toEqual([
        expect.objectContaining({
          tool: STATUS,
          projectId: projectId(),
          outcome: "ok",
        }),
        expect.objectContaining({
          tool: STATUS,
          projectId: null,
          outcome: "NOT_FOUND",
        }),
      ]);
    });
  });
});

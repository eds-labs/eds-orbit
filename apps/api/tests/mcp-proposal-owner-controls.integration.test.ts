import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { data } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  revokeClientGrants,
  revokeGrant,
} from "../src/platform/mcp-auth/grants.ts";
import { proposeAssignmentFromMcp } from "../src/modules/marketing/agents/assignments.ts";
import { dropNullFields } from "../src/modules/agents/tools/registry.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";
import { createPackageProject, X } from "./support/package-project.ts";

// Track M WP-M4, Task 4: owners stop proposals per grant, and revoking or
// stopping cancels the grant's pending MCP proposals. Real WP-M1 tokens
// through the gateway; the owner decides in Orbit.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const TOOL = "marketing_assignment_propose";
const STATUS = "orbit_action_status";

const names = [
  "stop",
  "sibling",
  "revoke",
  "ownerRevoke",
  "ended",
  "replaced",
  "ownerStop",
  "ownerGrant",
  "reconsent",
  "clientChanged",
  "coverage",
  "race",
  "cancelFail",
] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/owner-controls-${n}.json`]),
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

type Who = "owner" | "editor" | "viewer" | "outsider";

describe.skipIf(!enabled)("MCP owner controls over proposals", () => {
  let api: Awaited<ReturnType<typeof buildServer>>;
  let gateway: FastifyInstance;
  let auth: ReturnType<typeof makeAuth>;
  let config: ReturnType<typeof loadConfig>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let jwksUrl = "";
  let cookie = "";
  const cookies = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  const users: string[] = [];
  const tokens = {} as Record<Name, string>;
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
    defaultClientId: CLIENT.stop,
  });
  const projectId = () => project.owner.projectId;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);

  async function connectFlow(name: Name, who: Who) {
    cookie = cookies[who];
    const flow = await driver.connect({ clientId: CLIENT[name] });
    const response = await driver.exchange(flow, { client_id: CLIENT[name] });
    expect(response.statusCode).toBe(200);
    return {
      steps: flow.steps,
      token: (response.json() as Json).access_token as string,
    };
  }
  const connect = async (name: Name, who: Who) =>
    (await connectFlow(name, who)).token;

  function rpc(method: string, params: Json, token: string) {
    return gateway.inject({
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
            [`${META}clientInfo`]: {
              name: "owner-controls-test",
              version: "1",
            },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
    });
  }
  const call = async (name: Name, tool: string, args: Json) =>
    rpcBody(
      await rpc("tools/call", { name: tool, arguments: args }, tokens[name]),
    );
  const propose = async (name: Name, changes: Json = {}) => {
    const body = await call(name, TOOL, proposeArgs(changes));
    expect(body.result?.isError).toBeFalsy();
    return body.result.structuredContent as Json;
  };
  const status = async (name: Name, actionRequestId: string) =>
    (await call(name, STATUS, { projectId: projectId(), actionRequestId }))
      .result as Json;
  const listTools = async (name: Name) =>
    (
      rpcBody(await rpc("tools/list", {}, tokens[name])).result.tools as Json[]
    ).map((tool) => tool.name as string);

  function asUser(
    who: Who,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Json,
  ) {
    cookie = cookies[who];
    return driver.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
  }
  const decide = (id: string, decision: "approve" | "reject") =>
    requestRow(id).then((row) =>
      asUser(
        "owner",
        "POST",
        `/api/projects/${projectId()}/action-requests/${id}/decide`,
        {
          version: row.version,
          packageHash: data(row).packageHash,
          decision,
        },
      ),
    );
  const requestRow = (id: string) =>
    run((tx) =>
      tx.entity.findFirstOrThrow({ where: { id, kind: "action_requests" } }),
    );
  const requestData = async (id: string) => data(await requestRow(id));
  const grantOf = (name: Name) =>
    authDb.mcpGrant.findFirstOrThrow({
      where: { clientId: CLIENT[name], status: "active" },
    });
  const events = (action: string, name: Name) =>
    authDb.mcpGrantEvent.findMany({
      where: { action, clientId: CLIENT[name] },
    });
  const auditOf = (action: string, entityId: string) =>
    run((tx) =>
      tx.auditEvent.findMany({
        where: {
          workspaceId: project.owner.workspaceId,
          projectId: projectId(),
          action,
          resourceId: entityId,
        },
      }),
    );

  beforeAll(async () => {
    savedAgents = process.env.ORBIT_AGENTS;
    savedProposals = process.env.ORBIT_MCP_PROPOSALS;
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_MCP_PROPOSALS = "true";
    await withFlags(async () => {
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
    project = await createPackageProject({ name: "Synthetic MCP controls" });

    const password = randomBytes(24).toString("base64url");
    const emails = {} as Record<Who, string>;
    for (const who of ["owner", "editor", "viewer", "outsider"] as const) {
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
    for (const who of ["owner", "editor", "viewer", "outsider"] as const) {
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
      tokens[name] = await connect(
        name,
        name === "ownerGrant" ? "owner" : "editor",
      );
  }, 240_000);

  afterAll(async () => {
    if (savedAgents === undefined) delete process.env.ORBIT_AGENTS;
    else process.env.ORBIT_AGENTS = savedAgents;
    if (savedProposals === undefined) delete process.env.ORBIT_MCP_PROPOSALS;
    else process.env.ORBIT_MCP_PROPOSALS = savedProposals;
    await gateway?.close();
    await api?.close();
    await project?.cleanup();
    await authDb.mcpGrantEvent.deleteMany({
      where: { userId: { in: users } },
    });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: Object.values(CLIENT) } },
    });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("stopping proposals hides the proposal tools on the next request and cancels the grant's pending ones", async () => {
    expect(await listTools("stop")).toContain(TOOL);
    const first = await propose("stop");
    const second = await propose("stop", { topicFrame: "Another frame" });
    const sibling = await propose("sibling");
    const grant = await grantOf("stop");
    expect(grant.scopes).toContain("orbit:propose");

    const stopped = await asUser(
      "editor",
      "PATCH",
      `/api/mcp-grants/${grant.id}`,
      { proposals: false },
    );
    expect(stopped.statusCode).toBe(204);

    // The very next request: no proposal tool listed, calling it is unknown;
    // reading and the status tool stay.
    const tools = await listTools("stop");
    expect(tools).not.toContain(TOOL);
    expect(tools).toContain(STATUS);
    const refused = await call("stop", TOOL, proposeArgs());
    expect(refused.result).toBeUndefined();
    expect(refused.error).toMatchObject({ code: -32602 });
    const after = await grantOf("stop");
    expect(after.scopes).not.toContain("orbit:propose");
    expect(after.scopes).toContain("orbit:read");
    expect(after.status).toBe("active");

    // Its pending proposals are canceled with a reason; the same user's other
    // client keeps its proposal and its tool.
    for (const out of [first, second]) {
      // The platform withdraws them (D-M5-8), naming who stopped the grant.
      expect(await requestData(out.actionRequestId as string)).toMatchObject({
        status: "canceled",
        canceledBy: "system",
        canceledReason: "mcp_proposals_stopped",
        canceledInitiatedBy: ids.editor,
      });
      expect(
        (
          await auditOf(
            "action_request.canceled",
            out.actionRequestId as string,
          )
        ).map((row) => row.metadata),
      ).toEqual([
        {
          actionType: "assignment.confirm",
          reason: "mcp_proposals_stopped",
          initiatedBy: ids.editor,
        },
      ]);
      expect(
        (
          await auditOf(
            "action_request.canceled",
            out.actionRequestId as string,
          )
        ).map((row) => row.actorId),
      ).toEqual(["system"]);
      expect(
        (await status("stop", out.actionRequestId as string)).structuredContent,
      ).toMatchObject({ status: "canceled" });
      // A decision afterwards is refused: nothing runs.
      const late = await decide(out.actionRequestId as string, "approve");
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({
        error: { code: "ACTION_REQUEST_NOT_PENDING" },
      });
    }
    expect(await requestData(sibling.actionRequestId as string)).toMatchObject({
      status: "pending",
    });
    expect(await listTools("sibling")).toContain(TOOL);
    for (const out of [first, second])
      expect(
        data(
          await run((tx) =>
            tx.entity.findFirstOrThrow({
              where: { id: out.assignmentId as string, kind: "assignments" },
            }),
          ),
        ).status,
      ).toBe("draft");

    const recorded = await events("grant.proposals_disabled", "stop");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      grantId: grant.id,
      userId: ids.editor,
      workspaceId: project.owner.workspaceId,
      detail: { by: "user" },
    });

    // Idempotent: again is 204 without a second event; the list shows scopes.
    const again = await asUser(
      "editor",
      "PATCH",
      `/api/mcp-grants/${grant.id}`,
      { proposals: false },
    );
    expect(again.statusCode).toBe(204);
    expect(await events("grant.proposals_disabled", "stop")).toHaveLength(1);
    const listed = await asUser("editor", "GET", "/api/mcp-grants");
    const row = (listed.json().grants as Json[]).find(
      (g) => g.id === grant.id,
    )!;
    expect(row.scopes).not.toContain("orbit:propose");
  });

  it("revoking a grant cancels its pending proposals, and a decision afterwards is refused", async () => {
    const pending = await propose("revoke");
    const grant = await grantOf("revoke");
    const revoked = await asUser(
      "editor",
      "DELETE",
      `/api/mcp-grants/${grant.id}`,
    );
    expect(revoked.statusCode).toBe(204);
    expect(await requestData(pending.actionRequestId as string)).toMatchObject({
      status: "canceled",
      canceledBy: "system",
      canceledReason: "mcp_grant_ended",
      canceledInitiatedBy: ids.editor,
    });
    const late = await decide(pending.actionRequestId as string, "approve");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      error: { code: "ACTION_REQUEST_NOT_PENDING" },
    });
    expect(
      data(
        await run((tx) =>
          tx.entity.findFirstOrThrow({
            where: { id: pending.assignmentId as string, kind: "assignments" },
          }),
        ),
      ),
    ).toMatchObject({ status: "draft", confirmation: null });
  });

  it("an owner revoking another user's grant cancels its proposals too", async () => {
    const pending = await propose("ownerRevoke");
    const grant = await grantOf("ownerRevoke");
    const revoked = await asUser(
      "owner",
      "DELETE",
      `/api/mcp-grants/${grant.id}`,
    );
    expect(revoked.statusCode).toBe(204);
    expect(await requestData(pending.actionRequestId as string)).toMatchObject({
      status: "canceled",
      canceledBy: "system",
      canceledReason: "mcp_grant_ended",
      canceledInitiatedBy: ids.owner,
    });
  });

  it("refuses an approval of a proposal whose grant ended even when it was never canceled", async () => {
    const one = await propose("ended");
    const two = await propose("ended", { topicFrame: "A second frame" });
    const three = await propose("ended", { topicFrame: "A third frame" });
    const grant = await grantOf("ended");
    const approveRefused = async (out: Json) => {
      const refused = await decide(out.actionRequestId as string, "approve");
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { code: "MCP_GRANT_ENDED" },
      });
      expect(
        data(
          await run((tx) =>
            tx.entity.findFirstOrThrow({
              where: { id: out.assignmentId as string, kind: "assignments" },
            }),
          ),
        ).status,
      ).toBe("draft");
      expect(await requestData(out.actionRequestId as string)).toMatchObject({
        status: "pending",
      });
    };
    // Proposals stopped by the database alone: the cancellation did not run.
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { scopes: grant.scopes.filter((s) => s !== "orbit:propose") },
    });
    await approveRefused(one);
    // The grant revoked by the database alone.
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { status: "revoked", revokedAt: new Date(), revokedBy: ids.owner },
    });
    await approveRefused(two);
    // Rejecting stays possible, so the owner can clear the inbox.
    const rejected = await decide(three.actionRequestId as string, "reject");
    expect(rejected.statusCode).toBe(200);
  });

  it("proposals survive a re-consent that replaces the grant", async () => {
    const args = { name: `Before replace ${randomUUID()}` };
    const pending = await propose("replaced", args);
    const before = await grantOf("replaced");
    tokens.replaced = await connect("replaced", "editor");
    const after = await grantOf("replaced");
    expect(after.id).not.toBe(before.id);
    expect(await requestData(pending.actionRequestId as string)).toMatchObject({
      status: "pending",
    });
    // The client still sees its own proposal through the new grant, and a
    // retry with the same arguments returns it instead of a duplicate.
    expect(
      (await status("replaced", pending.actionRequestId as string))
        .structuredContent,
    ).toMatchObject({
      status: "pending",
      actionRequestId: pending.actionRequestId,
    });
    const retried = await propose("replaced", args);
    expect(retried).toMatchObject({
      actionRequestId: pending.actionRequestId,
      deduplicated: true,
    });
    const approved = await decide(pending.actionRequestId as string, "approve");
    expect(approved.statusCode).toBe(200);
    // Stopping proposals on the new grant also cancels the earlier grant's.
    const another = await propose("replaced", { topicFrame: "After replace" });
    const stopped = await asUser(
      "editor",
      "PATCH",
      `/api/mcp-grants/${after.id}`,
      { proposals: false },
    );
    expect(stopped.statusCode).toBe(204);
    expect(await requestData(another.actionRequestId as string)).toMatchObject({
      status: "canceled",
    });
  });

  it("only the grant's user or a workspace owner may stop proposals", async () => {
    const grant = await grantOf("ownerGrant");
    const body = { proposals: false };
    const url = `/api/mcp-grants/${grant.id}`;
    // A member who is neither the grant's user nor an owner: 403.
    expect((await asUser("editor", "PATCH", url, body)).statusCode).toBe(403);
    expect((await asUser("viewer", "PATCH", url, body)).statusCode).toBe(403);
    // A non-member, and an id that does not exist: the same 404.
    const outsider = await asUser("outsider", "PATCH", url, body);
    expect(outsider.statusCode).toBe(404);
    const unknown = await asUser(
      "outsider",
      "PATCH",
      `/api/mcp-grants/${randomUUID()}`,
      body,
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(outsider.json());
    expect((await grantOf("ownerGrant")).scopes).toContain("orbit:propose");
    // Only { proposals: false } is accepted.
    for (const bad of [
      { proposals: true },
      {},
      { proposals: false, extra: 1 },
      { proposals: "no" },
    ])
      expect((await asUser("owner", "PATCH", url, bad)).statusCode).toBe(400);
    expect((await grantOf("ownerGrant")).scopes).toContain("orbit:propose");
    expect(await events("grant.proposals_disabled", "ownerGrant")).toHaveLength(
      0,
    );

    // An owner stops a grant of another user, and its pending proposals go.
    const pending = await propose("ownerStop");
    const editorsGrant = await grantOf("ownerStop");
    const byOwner = await asUser(
      "owner",
      "PATCH",
      `/api/mcp-grants/${editorsGrant.id}`,
      body,
    );
    expect(byOwner.statusCode).toBe(204);
    expect(await events("grant.proposals_disabled", "ownerStop")).toMatchObject(
      [{ userId: ids.editor, detail: { by: "owner" } }],
    );
    expect(await requestData(pending.actionRequestId as string)).toMatchObject({
      status: "canceled",
      canceledBy: "system",
      canceledInitiatedBy: ids.owner,
    });
    const ownGrant = await asUser("owner", "PATCH", url, body);
    expect(ownGrant.statusCode).toBe(204);
    expect(
      await events("grant.proposals_disabled", "ownerGrant"),
    ).toMatchObject([{ detail: { by: "user" } }]);
  });

  it("a reconnect after stopping proposals shows the consent step, and accepting orbit:propose restores proposing", async () => {
    const before = await propose("reconsent");
    const grant = await grantOf("reconsent");
    const reference = {
      clientId: CLIENT.reconsent,
      userId: ids.editor,
      referenceId: project.owner.workspaceId,
    };
    expect(
      (await authDb.oauthConsent.findFirstOrThrow({ where: reference })).scopes,
    ).toContain("orbit:propose");
    const stopped = await asUser(
      "editor",
      "PATCH",
      `/api/mcp-grants/${grant.id}`,
      { proposals: false },
    );
    expect(stopped.statusCode).toBe(204);
    // The stored consent no longer covers proposing; other scopes stay.
    const consent = await authDb.oauthConsent.findFirstOrThrow({
      where: reference,
    });
    expect(consent.scopes).not.toContain("orbit:propose");
    expect(consent.scopes).toContain("orbit:read");
    expect(await listTools("reconsent")).not.toContain(TOOL);
    // Simulate a cancellation sweep that failed: the old proposal is pending.
    await run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({
        where: { id: before.actionRequestId as string },
      });
      await tx.entity.update({
        where: { id: row.id },
        data: { data: { ...data(row), status: "pending" } },
      });
    });

    const again = await connectFlow("reconsent", "editor");
    expect(again.steps).toEqual(["select", "consent", "redirect_uri"]);
    tokens.reconsent = again.token;
    const restored = await grantOf("reconsent");
    expect(restored.id).not.toBe(grant.id);
    expect(restored.scopes).toContain("orbit:propose");
    expect(
      (await authDb.oauthConsent.findFirstOrThrow({ where: reference })).scopes,
    ).toContain("orbit:propose");
    expect(await listTools("reconsent")).toContain(TOOL);
    const fresh = await propose("reconsent", { topicFrame: "After reconsent" });
    expect(fresh.deduplicated).toBe(false);
    // The proposal from before the stop never comes back: proposals were
    // stopped after it was made, whatever the successor grant allows.
    const late = await decide(before.actionRequestId as string, "approve");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: "MCP_GRANT_ENDED" } });
    expect(
      (await decide(fresh.actionRequestId as string, "approve")).statusCode,
    ).toBe(200);
  });

  it("a client change revokes the successor grant, cancels the proposals, and a later grant never revives them", async () => {
    const pending = await propose("clientChanged");
    const unswept = await propose("clientChanged", {
      topicFrame: "Swept and put back",
    });
    const first = await grantOf("clientChanged");
    // A re-selection: the proposals' grant is replaced by an active one.
    tokens.clientChanged = await connect("clientChanged", "editor");
    const successor = await grantOf("clientChanged");
    expect(successor.id).not.toBe(first.id);

    expect(
      await revokeClientGrants(CLIENT.clientChanged, "client_changed"),
    ).toBe(1);
    for (const out of [pending, unswept])
      expect(await requestData(out.actionRequestId as string)).toMatchObject({
        status: "canceled",
        canceledBy: "system",
        canceledReason: "mcp_client_changed",
      });
    expect(
      Object.keys(await requestData(pending.actionRequestId as string)),
    ).not.toContain("canceledInitiatedBy");
    // Simulate a sweep that failed for one of them.
    await run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({
        where: { id: unswept.actionRequestId as string },
      });
      await tx.entity.update({
        where: { id: row.id },
        data: { data: { ...data(row), status: "pending" } },
      });
    });
    // A new connect: an active grant with orbit:propose again.
    tokens.clientChanged = await connect("clientChanged", "editor");
    expect((await grantOf("clientChanged")).scopes).toContain("orbit:propose");
    const late = await decide(unswept.actionRequestId as string, "approve");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: "MCP_GRANT_ENDED" } });
  });

  it("refuses an approval when the grant no longer covers the project or its user lost the membership", async () => {
    const uncovered = await propose("coverage");
    const unmember = await propose("coverage", { topicFrame: "Membership" });
    const grant = await grantOf("coverage");
    const refused = async (out: Json) => {
      const response = await decide(out.actionRequestId as string, "approve");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "MCP_GRANT_ENDED" },
      });
    };
    // The grant names another project only.
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { projectIds: [randomUUID()], allCurrentProjects: false },
    });
    await refused(uncovered);
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { projectIds: [projectId()] },
    });
    // The proposing user is no longer a member of the project.
    const { workspaceId } = project.owner;
    await authDb.projectMember.delete({
      where: {
        projectId_userId: { projectId: projectId(), userId: ids.editor },
      },
    });
    try {
      await refused(unmember);
    } finally {
      await authDb.projectMember.create({
        data: {
          workspaceId,
          projectId: projectId(),
          userId: ids.editor,
          role: "editor",
        },
      });
    }
    // Nor of the workspace (which also ends the project membership).
    await authDb.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: ids.editor } },
    });
    try {
      await refused(unmember);
    } finally {
      await authDb.workspaceMember.create({
        data: { workspaceId, userId: ids.editor, role: "viewer" },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId,
          projectId: projectId(),
          userId: ids.editor,
          role: "editor",
        },
      });
    }
    // Restored, the same proposal is approved.
    expect(
      (await decide(unmember.actionRequestId as string, "approve")).statusCode,
    ).toBe(200);
  });

  it("refuses to create a proposal when the grant stopped proposing after the gateway resolved it", async () => {
    const grant = await grantOf("race");
    const scope = {
      workspaceId: project.owner.workspaceId,
      projectId: projectId(),
      userId: ids.editor,
      role: "editor" as const,
    };
    const origin = {
      tool: TOOL,
      userId: ids.editor,
      clientId: CLIENT.race,
      grantId: grant.id,
      agentRunId: null,
    };
    const count = () =>
      run((tx) => tx.entity.count({ where: { kind: "action_requests" } }));
    const before = await count();
    // The stop committed between the gateway's grant lookup and the
    // proposal's transaction.
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { scopes: grant.scopes.filter((s) => s !== "orbit:propose") },
    });
    await expect(
      proposeAssignmentFromMcp(
        scope,
        origin,
        dropNullFields(proposeArgs({ topicFrame: "Raced" })),
      ),
    ).rejects.toMatchObject({ code: "MCP_GRANT_ENDED", status: 409 });
    expect(await count()).toBe(before);
    // With the scope back, the same call creates the proposal.
    await authDb.mcpGrant.update({
      where: { id: grant.id },
      data: { scopes: grant.scopes },
    });
    const created = await proposeAssignmentFromMcp(
      scope,
      origin,
      dropNullFields(proposeArgs({ topicFrame: "Raced" })),
    );
    expect(created.deduplicated).toBe(false);
    expect(await count()).toBe(before + 1);
  });
  it("a failed cancellation is logged, the sweep goes on, and the guard still refuses the approval", async () => {
    const broken = await propose("cancelFail");
    const fine = await propose("cancelFail", { topicFrame: "Second" });
    const third = await propose("cancelFail", { topicFrame: "Third" });
    // The next version of `broken` already exists: its cancellation write
    // fails in the database (unique entity version), the others do not.
    const row = await requestRow(broken.actionRequestId as string);
    await run((tx) =>
      tx.entityVersion.create({
        data: {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          entityId: row.id,
          version: row.version + 1,
          data: data(row),
        },
      }),
    );
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    const grant = await grantOf("cancelFail");
    await revokeGrant({ userId: ids.editor }, grant.id, {
      error: (fields, message) => void logged.push({ fields, message }),
    });
    expect(await requestData(broken.actionRequestId as string)).toMatchObject({
      status: "pending",
    });
    for (const out of [fine, third])
      expect(await requestData(out.actionRequestId as string)).toMatchObject({
        status: "canceled",
        canceledBy: "system",
        canceledReason: "mcp_grant_ended",
      });
    expect(logged).toEqual([
      {
        fields: {
          code: "MCP_PROPOSAL_CANCEL_FAILED",
          grantId: grant.id,
          projectId: projectId(),
          actionRequestId: broken.actionRequestId,
          reason: "mcp_grant_ended",
        },
        message: expect.stringMatching(/^mcp proposal cancellation failed: /),
      },
    ]);
    // Identifiers and an error name only: no token, payload or message text.
    expect(JSON.stringify(logged)).not.toContain(tokens.cancelFail);
    expect(JSON.stringify(logged)).not.toContain("Unique constraint");
    // The request stayed pending, but its grant ended: no approval.
    const late = await decide(broken.actionRequestId as string, "approve");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: "MCP_GRANT_ENDED" } });
  });
});

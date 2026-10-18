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

  async function connect(name: Name, who: Who) {
    cookie = cookies[who];
    const flow = await driver.connect({ clientId: CLIENT[name] });
    const response = await driver.exchange(flow, { client_id: CLIENT[name] });
    expect(response.statusCode).toBe(200);
    return (response.json() as Json).access_token as string;
  }

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
      expect(await requestData(out.actionRequestId as string)).toMatchObject({
        status: "canceled",
        canceledBy: ids.editor,
        canceledReason: "proposals_disabled",
      });
      expect(
        (
          await auditOf(
            "action_request.canceled",
            out.actionRequestId as string,
          )
        ).map((row) => row.metadata),
      ).toEqual([
        { actionType: "assignment.confirm", reason: "proposals_disabled" },
      ]);
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
      canceledBy: ids.editor,
      canceledReason: "grant_revoked",
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
      canceledBy: ids.owner,
      canceledReason: "grant_revoked",
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
    const pending = await propose("replaced");
    const before = await grantOf("replaced");
    tokens.replaced = await connect("replaced", "editor");
    const after = await grantOf("replaced");
    expect(after.id).not.toBe(before.id);
    expect(await requestData(pending.actionRequestId as string)).toMatchObject({
      status: "pending",
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
      canceledBy: ids.owner,
    });
    const ownGrant = await asUser("owner", "PATCH", url, body);
    expect(ownGrant.statusCode).toBe(204);
    expect(
      await events("grant.proposals_disabled", "ownerGrant"),
    ).toMatchObject([{ detail: { by: "user" } }]);
  });
});

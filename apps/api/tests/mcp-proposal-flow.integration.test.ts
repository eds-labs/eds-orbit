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
import { data, hash, list } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  assignmentInput,
  proposeAssignment,
} from "../src/modules/marketing/agents/assignments.ts";
import { createConversation } from "../src/modules/chat.ts";
import { dropNullFields } from "../src/modules/agents/tools/registry.ts";
import { assignmentTools } from "../src/modules/marketing/tools/assignment-tools.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";
import {
  createPackageProject,
  LINKEDIN,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

// Track M WP-M4, Task 2: `marketing_assignment_propose` through the gateway
// with real WP-M1 tokens. An MCP proposal is a draft assignment plus a
// pending `assignment.confirm` request in the owner's inbox; only the owner's
// decision in Orbit activates it, through the existing executor.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const TOOL = "marketing_assignment_propose";

const names = ["editor", "editor-two", "viewer"] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/proposal-flow-${n}.json`]),
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

/** Every field of the model-facing schema; nullable ones as null. */
const proposeArgs = (changes: Json = {}): Json => ({
  name: `MCP daily post ${randomUUID()}`,
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

describe.skipIf(!enabled)(
  "MCP proposal flow: marketing_assignment_propose",
  () => {
    let api: Awaited<ReturnType<typeof buildServer>>;
    let gateway: FastifyInstance;
    let auth: ReturnType<typeof makeAuth>;
    let config: ReturnType<typeof loadConfig>;
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let jwksUrl = "";
    let cookie = "";
    const cookies = {} as Record<"owner" | "editor" | "viewer", string>;
    const ids = {} as Record<"owner" | "editor" | "viewer", string>;
    const users: string[] = [];
    const tokens = {} as Record<Name, string>;
    let savedAgents: string | undefined;

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
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);

    async function tokenFor(name: Name, who: "editor" | "viewer") {
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
          ...(method === "tools/call"
            ? { "mcp-name": String(params.name) }
            : {}),
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
                name: "proposal-flow-test",
                version: "1",
              },
              [`${META}clientCapabilities`]: {},
            },
          },
        }),
      });
    }
    async function proposeBody(args: Json, who: Name = "editor") {
      const response = await rpc(
        "tools/call",
        { name: TOOL, arguments: args },
        tokens[who],
      );
      expect(response.statusCode).toBe(200);
      return rpcBody(response);
    }
    const propose = async (args: Json, who: Name = "editor") =>
      (await proposeBody(args, who)).result as Json;
    const listTools = async (who: Name) =>
      (
        rpcBody(await rpc("tools/list", {}, tokens[who])).result.tools as Json[]
      ).map((tool) => tool.name as string);

    /** An Orbit API request as the owner, editor or viewer (browser session). */
    function asUser(
      who: "owner" | "editor" | "viewer",
      method: "GET" | "POST",
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
    const inbox = (who: "owner" | "editor" = "owner") =>
      asUser(who, "GET", `/api/projects/${projectId()}/action-requests`);
    const decide = (who: "owner" | "editor", id: string, body: Json) =>
      asUser(
        who,
        "POST",
        `/api/projects/${projectId()}/action-requests/${id}/decide`,
        body,
      );
    const requestRow = (id: string) =>
      run((tx) =>
        tx.entity.findFirstOrThrow({ where: { id, kind: "action_requests" } }),
      );
    const assignmentRow = (id: string) =>
      run((tx) =>
        tx.entity.findFirstOrThrow({ where: { id, kind: "assignments" } }),
      );
    const assignments = () =>
      run((tx) => list(tx, project.owner, "assignments"));
    const grantOf = (name: Name) =>
      authDb.mcpGrant.findFirstOrThrow({
        where: { clientId: CLIENT[name], revokedAt: null },
      });
    const proposalEvents = async (name: Name) =>
      authDb.mcpGrantEvent.findMany({
        where: { grantId: (await grantOf(name)).id, action: "mcp.proposal" },
        orderBy: { createdAt: "asc" },
      });
    const auditOf = (action: string, entityId?: string) =>
      run((tx) =>
        tx.auditEvent.findMany({
          where: {
            workspaceId: project.owner.workspaceId,
            projectId: projectId(),
            action,
            ...(entityId ? { resourceId: entityId } : {}),
          },
        }),
      );

    beforeAll(async () => {
      savedAgents = process.env.ORBIT_AGENTS;
      process.env.ORBIT_AGENTS = "true";
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
      // The spend mandate (autopilot policy for X and Telegram), connector and
      // profile; its own synthetic owner, editor and viewer stay unused.
      project = await createPackageProject({ name: "Synthetic MCP proposals" });

      const password = randomBytes(24).toString("base64url");
      const emails = {} as Record<"owner" | "editor" | "viewer", string>;
      for (const who of ["owner", "editor", "viewer"] as const) {
        emails[who] = `${randomUUID()}@example.invalid`;
        const created = await auth.api.signUpEmail({
          body: {
            email: emails[who],
            name: `Synthetic proposal ${who}`,
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
      tokens.editor = await tokenFor("editor", "editor");
      tokens["editor-two"] = await tokenFor("editor-two", "editor");
      tokens.viewer = await tokenFor("viewer", "viewer");
    }, 180_000);

    afterAll(async () => {
      if (savedAgents === undefined) delete process.env.ORBIT_AGENTS;
      else process.env.ORBIT_AGENTS = savedAgents;
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

    it("exposes only assignment_propose, with parameters a second parse cannot change", () => {
      const tool = assignmentTools.find(
        (t) => t.name === "assignment_propose",
      )!;
      expect(tool.exposure).toEqual({ assistant: true, mcp: true });
      expect(tool.risk).toBe("P_proposal");
      // The SDK parses the arguments, then the adapter parses them again.
      const args = proposeArgs();
      const once = tool.parameters.parse(args);
      expect(once).toEqual(args);
      expect(tool.parameters.parse(once)).toEqual(once);
      for (const other of assignmentTools.filter((t) => t !== tool))
        expect(other.exposure?.mcp).not.toBe(true);
    });

    it("lists the proposal tool for editors with its output schema, never for viewers", async () => {
      const response = rpcBody(await rpc("tools/list", {}, tokens.editor));
      const tool = (response.result.tools as Json[]).find(
        (t) => t.name === TOOL,
      )!;
      expect(tool).toBeDefined();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tool._meta.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["orbit:propose"] },
      ]);
      expect(Object.keys(tool.outputSchema.properties).sort()).toEqual([
        "actionRequestId",
        "approveUrl",
        "assignmentId",
        "deduplicated",
        "expiresAt",
        "status",
      ]);
      expect(await listTools("viewer")).not.toContain(TOOL);
    });

    it("an MCP proposal waits in the owner's inbox; only the owner's approval confirms it", async () => {
      const args = proposeArgs();
      const result = await propose(args);
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent;
      expect(out).toEqual({
        status: "pending_approval",
        actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        assignmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expiresAt: expect.any(String),
        approveUrl: `${new URL(config.APP_ORIGIN).origin}/p/${projectId()}/approvals`,
        deduplicated: false,
      });
      expect(JSON.parse(result.content[0].text)).toEqual(out);

      // No side effect before the decision: a draft without a conversation,
      // no confirmation, no runs.
      const draft = await assignmentRow(out.assignmentId);
      expect(data(draft)).toMatchObject({
        status: "draft",
        confirmation: null,
        conversationId: null,
        actionRequestId: out.actionRequestId,
        name: args.name,
      });
      expect(
        await run((tx) =>
          tx.entity.count({
            where: {
              kind: "assignment_runs",
              data: { path: ["assignmentId"], equals: out.assignmentId },
            },
          }),
        ),
      ).toBe(0);

      // The request names the MCP client and grant, the arguments only by hash.
      const request = await requestRow(out.actionRequestId);
      const grant = await grantOf("editor");
      const normalized = assignmentInput.parse(dropNullFields(args));
      expect(data(request)).toMatchObject({
        actionType: "assignment.confirm",
        status: "pending",
        expiresAt: out.expiresAt,
        requestedBy: {
          kind: "mcp",
          userId: ids.editor,
          clientId: CLIENT.editor,
          grantId: grant.id,
          argsHash: hash({
            tool: TOOL,
            projectId: projectId(),
            args: normalized,
          }),
        },
      });
      // The AgentRun of the call, never the request-id fallback.
      const agentRunId = data(request).requestedBy.agentRunId as string;
      expect(
        await run((tx) =>
          tx.agentRun.findFirst({ where: { id: agentRunId, kind: "mcp" } }),
        ),
      ).not.toBeNull();
      // Audit: the proposal in the project, the creation on the grant.
      expect(
        (await auditOf("action_request.proposed", out.actionRequestId)).map(
          (row) => row.metadata,
        ),
      ).toEqual([
        {
          actionType: "assignment.confirm",
          packageHash: data(request).packageHash,
          clientId: CLIENT.editor,
          grantId: grant.id,
        },
      ]);
      const events = (await proposalEvents("editor")).filter(
        (event) =>
          (event.detail as Json).actionRequestId === out.actionRequestId,
      );
      expect(events.map((event) => event.detail)).toEqual([
        {
          actionType: "assignment.confirm",
          actionRequestId: out.actionRequestId,
        },
      ]);
      expect(events[0]).toMatchObject({
        userId: ids.editor,
        clientId: CLIENT.editor,
        workspaceId: project.owner.workspaceId,
      });

      // The owner's inbox lists it as an MCP proposal; an editor has no inbox.
      const listed = await inbox();
      expect(listed.statusCode).toBe(200);
      const item = (listed.json().items as Json[]).find(
        (i) => i.id === out.actionRequestId,
      )!;
      expect(item).toMatchObject({
        actionType: "assignment.confirm",
        requestedBy: { kind: "mcp", clientId: CLIENT.editor },
        summary: { assignment: { id: out.assignmentId, name: args.name } },
      });
      expect((await inbox("editor")).statusCode).toBe(403);

      const approved = await decide("owner", item.id, {
        version: item.version,
        packageHash: item.packageHash,
        decision: "approve",
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ status: "approved" });
      const confirmed = data(await assignmentRow(out.assignmentId));
      expect(confirmed).toMatchObject({
        status: "active",
        confirmation: { userId: ids.owner },
      });
      expect(
        await auditOf("assignment.confirmed", out.assignmentId),
      ).toHaveLength(1);
    });

    it("mcp proposal: decide, replay and hash mismatch", async () => {
      const out = (await propose(proposeArgs())).structuredContent;
      const request = await requestRow(out.actionRequestId);
      const fresh = {
        version: request.version,
        packageHash: data(request).packageHash as string,
        decision: "approve",
      };
      // An editor cannot decide an owner type.
      const byEditor = await decide("editor", request.id, fresh);
      expect(byEditor.statusCode).toBe(403);
      expect(byEditor.json()).toMatchObject({
        error: { code: "OWNER_REQUIRED" },
      });
      // A stale version or another package hash never executes.
      for (const forged of [
        { ...fresh, version: fresh.version + 1 },
        { ...fresh, packageHash: "0".repeat(64) },
      ]) {
        const stale = await decide("owner", request.id, forged);
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toMatchObject({
          error: { code: "ACTION_REQUEST_STALE" },
        });
      }
      expect(data(await assignmentRow(out.assignmentId)).status).toBe("draft");

      const first = await decide("owner", request.id, fresh);
      expect(first.statusCode).toBe(200);
      const after = await assignmentRow(out.assignmentId);
      // The same approval again returns the recorded result and runs nothing.
      const again = await decide("owner", request.id, fresh);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect((await assignmentRow(out.assignmentId)).version).toBe(
        after.version,
      );
      expect(
        await auditOf("assignment.confirmed", out.assignmentId),
      ).toHaveLength(1);
      // A different decision on a decided request is refused.
      const flipped = await decide("owner", request.id, {
        ...fresh,
        decision: "reject",
      });
      expect(flipped.statusCode).toBe(409);
      expect(flipped.json()).toMatchObject({
        error: { code: "ACTION_REQUEST_NOT_PENDING" },
      });
    });

    it("mcp proposals are deduplicated per grant and arguments", async () => {
      const args = proposeArgs();
      const before = (await assignments()).length;
      const eventsBefore = (await proposalEvents("editor")).length;
      const first = (await propose(args)).structuredContent;
      expect(first.deduplicated).toBe(false);
      // A retry, here with a default spelled out (normalized arguments match).
      const retry = (await propose({ ...args, vetoMinutes: 180 }))
        .structuredContent;
      expect(retry).toEqual({ ...first, deduplicated: true });
      expect((await assignments()).length).toBe(before + 1);
      // Deduplicated calls are not recorded as proposals.
      expect((await proposalEvents("editor")).length).toBe(eventsBefore + 1);

      // Other arguments, or the same arguments from another grant, propose anew.
      const other = (await propose({ ...args, topicFrame: "Another frame" }))
        .structuredContent;
      expect(other.deduplicated).toBe(false);
      expect(other.actionRequestId).not.toBe(first.actionRequestId);
      const otherGrant = (await propose(args, "editor-two")).structuredContent;
      expect(otherGrant.deduplicated).toBe(false);
      expect(otherGrant.assignmentId).not.toBe(first.assignmentId);
      expect((await assignments()).length).toBe(before + 3);

      // Once decided, the same arguments are a new proposal.
      const request = await requestRow(first.actionRequestId);
      const rejected = await decide("owner", request.id, {
        version: request.version,
        packageHash: data(request).packageHash,
        decision: "reject",
      });
      expect(rejected.statusCode).toBe(200);
      const anew = (await propose(args)).structuredContent;
      expect(anew.deduplicated).toBe(false);
      expect(anew.actionRequestId).not.toBe(first.actionRequestId);
    });

    it("maps domain refusals to isError results and creates nothing", async () => {
      const before = (await assignments()).length;
      const eventsBefore = (await proposalEvents("editor")).length;
      for (const [changes, code] of [
        // Outside the mandate's channels.
        [{ channels: [LINKEDIN] }, "SCOPE_NOT_ALLOWED"],
        // Above the project's monthly budget.
        [
          { channels: [X, TELEGRAM], monthlyBudgetMicros: 500_000_000 },
          "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT",
        ],
      ] as const) {
        const result = await propose(proposeArgs(changes));
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          code,
          retryable: false,
        });
      }
      // Invalid server-side input (no channel) is a validation failure.
      const invalid = await propose(proposeArgs({ channels: [] }));
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect((await assignments()).length).toBe(before);
      expect((await proposalEvents("editor")).length).toBe(eventsBefore);

      // A viewer may not use the tool at all: unlisted, so unknown (as WP-M2).
      const viewer = await proposeBody(proposeArgs(), "viewer");
      expect(viewer.result).toBeUndefined();
      expect(viewer.error).toMatchObject({ code: -32602 });
      expect((await assignments()).length).toBe(before);
    });

    it("the assistant path keeps its conversation check and agent requester", async () => {
      const changes = dropNullFields(proposeArgs()) as Json;
      await expect(
        proposeAssignment(project.editor, randomUUID(), changes),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const thread = await createConversation(project.editor);
      const { assignment, actionRequest } = await proposeAssignment(
        project.editor,
        thread.id,
        changes,
      );
      expect(data(assignment).conversationId).toBe(thread.id);
      expect(data(actionRequest).requestedBy).toEqual({
        kind: "agent",
        userId: project.editor.userId,
        agentRunId: null,
      });
    });

    it("is neither listed nor callable while Orbit Agents are off", async () => {
      process.env.ORBIT_AGENTS = "false";
      try {
        expect(await listTools("editor")).not.toContain(TOOL);
        const before = (await assignments()).length;
        const body = await proposeBody(proposeArgs());
        expect(body.result).toBeUndefined();
        expect(body.error).toMatchObject({ code: -32602 });
        expect((await assignments()).length).toBe(before);
      } finally {
        process.env.ORBIT_AGENTS = "true";
      }
    });
  },
);

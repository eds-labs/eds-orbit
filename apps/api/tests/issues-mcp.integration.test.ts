import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { authorizeMcpCall, visibleMcpTools } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { MCP_RESOURCE_SCOPES } from "../src/platform/mcp/server.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { registeredActionType, registeredTools } from "../src/platform/modules/contributions.ts";
import { userActor } from "../src/modules/issues/common.ts";
import { reportManually } from "../src/modules/issues/sources/manual.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createIssuesProject } from "./support/issues-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const ENV = { ORBIT_ISSUES: "true", ORBIT_SUPPORT: "true", ORBIT_WORK: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true", ORBIT_MCP_TASKS: "true" };
const READS = ["issues_duplicates", "issues_get", "issues_search", "issues_stats"];
const PROPOSALS = ["issues_propose_merge", "issues_propose_report", "issues_propose_task", "issues_propose_update"];

describe("issue tool contracts (ADR 0018)", () => {
  // Module tools count only while their module is switched on.
  beforeAll(() => {
    process.env.ORBIT_ISSUES = "true";
    process.env.ORBIT_SUPPORT = "true";
  });
  afterAll(() => {
    delete process.env.ORBIT_ISSUES;
    delete process.env.ORBIT_SUPPORT;
  });
  it("registers four reads and four editor-decided proposals with the issues scope", () => {
    const tools = registeredTools().filter((t) => t.namespace === "issues");
    expect(tools.map((t) => t.name).sort()).toEqual([...READS, ...PROPOSALS].sort());
    for (const tool of tools) {
      expect(tool.mcpScopes).toEqual(tool.name === "issues_propose_task" ? ["orbit:issues", "orbit:work"] : ["orbit:issues"]);
      expect(tool.feature).toBe("issues");
      expect(tool.risk).toBe(PROPOSALS.includes(tool.name) ? "P_proposal" : "R0_read");
    }
    for (const name of PROPOSALS) expect(registeredActionType(`issues.mcp.${name}`)!.deciderRole).toBe("editor");
    const handIn = registeredTools().find((t) => t.name === "support_report_issue")!;
    expect(handIn.mcpScopes).toEqual(["orbit:support", "orbit:issues"]);
    expect(MCP_SCOPES).toContain("orbit:issues");
    expect(MCP_RESOURCE_SCOPES).toContain("orbit:issues");
  });
});

describe.skipIf(!enabled)("issue MCP tools (SQL, no model call)", () => {
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let inboxId = "";
  const previous: Record<string, string | undefined> = {};
  const run = <T>(fn: (tx: DbTx) => Promise<T>) => scoped(p.owner.workspaceId, p.owner.projectId, fn);
  const names = async (principal: McpPrincipal, prefix = "issues_") =>
    (await visibleMcpTools(principal, p.owner.projectId)).map((t) => t.name).filter((n) => n.startsWith(prefix)).sort();
  const context = (scope: Scope, principal: McpPrincipal, module = "issues") => ({
    scope: moduleScope(scope, module),
    runId: "synthetic-issues-mcp",
    conversationId: "synthetic-issues-mcp",
    callIndex: 0,
    channel: { kind: "mcp" as const, clientId: principal.clientId, grantId: principal.grantId, requestId: "synthetic-issues-mcp" },
  });
  async function op(principal: McpPrincipal, name: string, args: unknown, module = "issues"): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(principal, name, p.owner.projectId);
    const result = await tool.execute(context(scope, principal, module), args);
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result.output;
  }
  const decide = (who: Scope, id: string) =>
    run(async (tx) => {
      const row = await entity(tx, who, "action_requests", id);
      return decideActionRequest(tx, who, id, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
  async function grantFor(scope: Scope, scopes: string[]): Promise<McpPrincipal> {
    const grant = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://client.test/issues-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes,
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return { workspaceId: scope.workspaceId, userId: scope.userId, clientId: grant.clientId, grantId: grant.id, projectIds: [scope.projectId], scopes: new Set(grant.scopes), modules: [] };
  }

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    p = await createIssuesProject({ modules: ["issues", "support", "work"] });
    inboxId = await run(async (tx) => (await createMailInbox(tx, p.owner, { name: "Mail", channels: ["email"], emailAddress: "mcp@example.invalid" })).inbox.id);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await p?.cleanup();
    await closeDatabase();
  });

  it("lists the tools by scope set and role", async () => {
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose", "orbit:issues", "orbit:work"]))).toEqual([...READS, ...PROPOSALS].sort());
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose"]))).toEqual([]);
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:issues"]))).toEqual(READS);
    // The task proposal also needs orbit:work.
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose", "orbit:issues"]))).toEqual(
      [...READS, ...PROPOSALS.filter((n) => n !== "issues_propose_task")].sort(),
    );
    expect(await names(await grantFor(p.viewer, ["orbit:read", "orbit:propose", "orbit:issues"]))).toEqual(READS);
  });

  it("reads redacted issues without diagnostics", async () => {
    const created = await run((tx) =>
      reportManually(tx, p.editor, { title: "Checkout fails for jan@example.org", symptoms: "Error from 203.0.113.5" }, userActor(p.editor)),
    );
    await run((tx) => tx.issueReport.updateMany({ where: { issueId: created.issueId }, data: { diagnostics: { route: "/checkout", code: 500 } } }));
    const principal = await grantFor(p.owner, ["orbit:read", "orbit:issues"]);
    const issue = await run((tx) => tx.issue.findUniqueOrThrow({ where: { id: created.issueId } }));
    const detail = await op(principal, "issues_get", { number: issue.number });
    const text = JSON.stringify(detail);
    expect(text).not.toContain("jan@example.org");
    expect(text).not.toContain("203.0.113.5");
    expect(text).not.toContain("/checkout");
    expect(text).not.toContain("diagnostics");
    const found = await op(principal, "issues_search", { query: "checkout" });
    expect(found.result.items[0]).toMatchObject({ number: issue.number, version: issue.version });
  });

  it("proposes an update that an editor approves once, refused when stale", async () => {
    const created = await run((tx) => reportManually(tx, p.editor, { title: "Export button broken" }, userActor(p.editor)));
    const issue = await run((tx) => tx.issue.findUniqueOrThrow({ where: { id: created.issueId } }));
    const principal = await grantFor(p.editor, ["orbit:read", "orbit:propose", "orbit:issues"]);
    const proposal = await op(principal, "issues_propose_update", {
      idempotencyKey: "update-1",
      number: issue.number,
      expectedVersion: issue.version,
      changes: { status: "confirmed", severity: "s2_major" },
    });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    expect((await run((tx) => tx.issue.findUniqueOrThrow({ where: { id: issue.id } }))).status).toBe("new");
    await expect(decide(p.viewer, proposal.actionRequestId)).rejects.toThrow();
    await decide(p.editor, proposal.actionRequestId);
    expect(await run((tx) => tx.issue.findUniqueOrThrow({ where: { id: issue.id } }))).toMatchObject({ status: "confirmed", severity: "s2_major" });
    // An invalid move is refused before anyone is asked.
    const fresh = await run((tx) => tx.issue.findUniqueOrThrow({ where: { id: issue.id } }));
    await expect(
      op(principal, "issues_propose_update", { idempotencyKey: "update-2", number: issue.number, expectedVersion: fresh.version, changes: { status: "released" } }),
    ).rejects.toThrow(/ISSUES_TRANSITION_INVALID/);
  });

  it("hands a ticket in over MCP only with both scopes and the owner's approval", async () => {
    const ticket = await run((tx) =>
      createTicket(tx, p.owner, {
        inboxId,
        channel: "email",
        inbound: { externalId: `<${randomUUID()}@mail.example.invalid>`, contact: { email: "x@example.invalid", name: "Xaver" }, subject: "Login", bodyText: "Login fails.", attachments: [] },
      }),
    );
    expect(await names(await grantFor(p.owner, ["orbit:read", "orbit:propose", "orbit:support"]), "support_report")).toEqual([]);
    const principal = await grantFor(p.owner, ["orbit:read", "orbit:propose", "orbit:support", "orbit:issues"]);
    expect(await names(principal, "support_report")).toEqual(["support_report_issue"]);
    const proposal = await op(principal, "support_report_issue", { idempotencyKey: "hand-in-1", ticketId: ticket.ticketId, title: "Login fails" }, "support");
    expect(await run((tx) => tx.issueReport.count({ where: { projectId: p.owner.projectId, sourceKind: "support" } }))).toBe(0);
    await decide(p.owner, proposal.actionRequestId);
    expect(await run((tx) => tx.issueReport.count({ where: { projectId: p.owner.projectId, sourceKind: "support" } }))).toBe(1);
  });
});

import { generateKeyPairSync, randomUUID } from "node:crypto";
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
import { REQUEST_KIND } from "../src/modules/issues/github.ts";
import { createIssue, setIssueStatus, setShareReview, updateIssue } from "../src/modules/issues/issues.ts";
import { readIssuesSettings, saveIssuesSettings } from "../src/modules/issues/settings.ts";
import { createConnection, grantConnection } from "../src/platform/administration/connections.ts";
import { setGithubFetchForTests } from "../src/platform/connections/github-app.ts";
import { reportManually } from "../src/modules/issues/sources/manual.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createIssuesProject } from "./support/issues-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const ENV = { ORBIT_ISSUES: "true", ORBIT_SUPPORT: "true", ORBIT_WORK: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true", ORBIT_MCP_TASKS: "true" };
const READS = ["issues_duplicates", "issues_get", "issues_search", "issues_stats"];
const PROPOSALS = ["issues_propose_github_issue", "issues_propose_merge", "issues_propose_report", "issues_propose_task", "issues_propose_update"];

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
  it("registers four reads and five proposals (four editor-decided, GitHub owner-decided) with the issues scope", () => {
    const tools = registeredTools().filter((t) => t.namespace === "issues");
    expect(tools.map((t) => t.name).sort()).toEqual([...READS, ...PROPOSALS].sort());
    for (const tool of tools) {
      expect(tool.mcpScopes).toEqual(tool.name === "issues_propose_task" ? ["orbit:issues", "orbit:work"] : ["orbit:issues"]);
      expect(tool.feature).toBe("issues");
      expect(tool.risk).toBe(PROPOSALS.includes(tool.name) ? "P_proposal" : "R0_read");
    }
    for (const name of PROPOSALS)
      expect(registeredActionType(`issues.mcp.${name}`)!.deciderRole).toBe(name === "issues_propose_github_issue" ? "owner" : "editor");
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
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose", "orbit:issues", "orbit:work"]))).toEqual(
      [...READS, ...PROPOSALS.filter((n) => n !== "issues_propose_github_issue")].sort(),
    );
    expect(await names(await grantFor(p.owner, ["orbit:read", "orbit:propose", "orbit:issues", "orbit:work"]))).toEqual([...READS, ...PROPOSALS].sort());
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose"]))).toEqual([]);
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:issues"]))).toEqual(READS);
    // The task proposal also needs orbit:work.
    expect(await names(await grantFor(p.editor, ["orbit:read", "orbit:propose", "orbit:issues"]))).toEqual(
      [...READS, ...PROPOSALS.filter((n) => n !== "issues_propose_task" && n !== "issues_propose_github_issue")].sort(),
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

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SECRET = JSON.stringify({
  appId: "123",
  appSlug: "orbit-issues",
  installationId: "456",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

describe.skipIf(!enabled)("issues_propose_github_issue (slice 1, Task 6)", () => {
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let connectionId = "";
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const previous: Record<string, string | undefined> = {};
  const run = <T>(fn: (tx: DbTx) => Promise<T>) => scoped(p.owner.workspaceId, p.owner.projectId, fn);
  async function propose(who: Scope, args: Record<string, unknown>) {
    const principal = await grantFor(who);
    const { tool, scope } = await authorizeMcpCall(principal, "issues_propose_github_issue", p.owner.projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "issues"),
        runId: "synthetic-github",
        conversationId: "synthetic-github",
        callIndex: 0,
        channel: { kind: "mcp" as const, clientId: principal.clientId, grantId: principal.grantId, requestId: "synthetic-github" },
      },
      { idempotencyKey: randomUUID(), repository: "web", ...args },
    );
    return result.output as any;
  }
  async function grantFor(scope: Scope): Promise<McpPrincipal> {
    const grant = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://client.test/issues-gh-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes: ["orbit:read", "orbit:propose", "orbit:issues"],
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return { workspaceId: scope.workspaceId, userId: scope.userId, clientId: grant.clientId, grantId: grant.id, projectIds: [scope.projectId], scopes: new Set(grant.scopes), modules: [] };
  }
  const decide = (who: Scope, id: string) =>
    run(async (tx) => {
      const row = await entity(tx, who, "action_requests", id);
      return decideActionRequest(tx, who, id, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
  const requests = () => run((tx) => tx.entity.count({ where: { projectId: p.owner.projectId, kind: REQUEST_KIND } }));
  const readyIssue = (options: { reviewed?: boolean; title?: string } = {}) =>
    run(async (tx) => {
      const actor = userActor(p.owner);
      let issue = await createIssue(
        tx,
        p.owner,
        { title: options.title ?? "Checkout button does nothing", summary: "Clicking checkout leaves the cart unchanged.", acceptanceCriteria: ["Checkout completes"] },
        actor,
      );
      issue = await setIssueStatus(tx, p.owner, issue.id, { status: "confirmed", expectedVersion: issue.version }, actor);
      if (options.reviewed !== false)
        issue = await setShareReview(tx, p.owner, issue.id, { reviewed: true, expectedVersion: issue.version }, actor);
      return issue;
    });

  beforeAll(async () => {
    for (const key of [...Object.keys(ENV), "ORBIT_ISSUES_GITHUB", "ORBIT_CONNECTIONS"]) previous[key] = process.env[key];
    Object.assign(process.env, ENV, { ORBIT_ISSUES_GITHUB: "true", ORBIT_CONNECTIONS: "true" });
    p = await createIssuesProject({ modules: ["issues"] });
    const connection = await createConnection(admin, { provider: "github_app", label: "Synthetic GitHub", config: {}, secret: SECRET });
    connectionId = connection.id;
    await grantConnection(admin, connection.id, { workspaceId: p.owner.workspaceId, purposes: ["issues"], modules: ["issues"] });
    await grantConnection(admin, connection.id, { workspaceId: p.owner.workspaceId, projectId: p.owner.projectId, purposes: ["issues"], modules: ["issues"] });
    await run(async (tx) => {
      const stored = await readIssuesSettings(tx, p.owner);
      await saveIssuesSettings(tx, p.owner, { ...stored.settings, github: { repositories: [{ key: "web", fullName: "o/web" }] } }, stored.version);
    });
    setGithubFetchForTests(async (url) => {
      const u = String(url);
      if (u.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_fake" }), { status: 201 });
      if (u === "https://api.github.com/repos/o/web")
        return new Response(JSON.stringify({ full_name: "o/web", private: true, archived: false }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
  });
  afterAll(async () => {
    setGithubFetchForTests(null);
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    if (connectionId) await authDb.connection.deleteMany({ where: { id: connectionId } });
    await p?.cleanup();
    await closeDatabase();
  });

  it("refuses an issue without share review", async () => {
    const issue = await readyIssue({ reviewed: false });
    await expect(propose(p.owner, { number: issue.number })).rejects.toThrow(/ISSUES_SHARE_REVIEW_REQUIRED/);
    expect(await requests()).toBe(0);
  });

  it("proposes with the exact text, queues only after the owner approves, and an editor cannot decide", async () => {
    const issue = await readyIssue();
    const before = await requests();
    const proposal = await propose(p.owner, { number: issue.number });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    expect(await requests()).toBe(before);
    const row = await run((tx) => entity(tx, p.owner, "action_requests", proposal.actionRequestId));
    const text = JSON.stringify(data(row));
    expect(text).toContain("o/web");
    expect(text).toContain("Checkout button does nothing");
    expect(text).toContain("Clicking checkout leaves the cart unchanged.");
    await expect(decide(p.editor, proposal.actionRequestId)).rejects.toThrow(/OWNER_REQUIRED/);
    expect(await requests()).toBe(before);
    await decide(p.owner, proposal.actionRequestId);
    expect(await requests()).toBe(before + 1);
    const created = await run((tx) => tx.entity.findFirst({ where: { projectId: p.owner.projectId, kind: REQUEST_KIND, data: { path: ["issueId"], equals: issue.id } } }));
    expect(data(created)).toMatchObject({ status: "queued", fullName: "o/web" });
    // While the request is unsettled a second proposal is refused.
    await expect(propose(p.owner, { number: issue.number })).rejects.toThrow(/ISSUES_GITHUB_REQUEST_STATE/);
  });

  it("leaks no report, diagnostics, ticket id or triage text into the approval or the tool output", async () => {
    const issue = await readyIssue();
    await run(async (tx) => {
      await tx.issueReport.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          issueId: issue.id,
          sourceKind: "support",
          externalSystem: "support",
          externalId: "SENTINEL-TICKET-7731",
          title: "SENTINEL-REPORT-TITLE-7731",
          symptoms: "SENTINEL-SYMPTOMS-7731",
          diagnostics: { route: "SENTINEL-DIAGNOSTICS-7731" },
          occurredAt: new Date(),
          reportedByKind: "integration",
        },
      });
      await tx.issue.update({ where: { id: issue.id }, data: { aiTriage: { note: "SENTINEL-TRIAGE-7731" } } });
    });
    const proposal = await propose(p.owner, { number: issue.number });
    const row = await run((tx) => entity(tx, p.owner, "action_requests", proposal.actionRequestId));
    expect(JSON.stringify(data(row))).toContain("Checkout button does nothing");
    for (const text of [JSON.stringify(proposal), JSON.stringify(data(row))]) expect(text).not.toContain("7731");
  });

  it("refuses at approval when the shared text changed after the proposal", async () => {
    const issue = await readyIssue();
    const before = await requests();
    const proposal = await propose(p.owner, { number: issue.number });
    await run(async (tx) => {
      const actor = userActor(p.owner);
      const current = await tx.issue.findUniqueOrThrow({ where: { id: issue.id } });
      const edited = await updateIssue(tx, p.owner, issue.id, { expectedVersion: current.version, summary: "A different description." }, actor);
      await setShareReview(tx, p.owner, issue.id, { reviewed: true, expectedVersion: edited.version }, actor);
    });
    await expect(decide(p.owner, proposal.actionRequestId)).rejects.toThrow(/ISSUES_GITHUB_TEXT_CHANGED/);
    expect(await requests()).toBe(before);
  });

  it("refuses text the redaction would block, with counts only", async () => {
    const issue = await readyIssue();
    // Stored text that slipped past intake redaction (written directly).
    await run((tx) => tx.issue.update({ where: { id: issue.id }, data: { summary: "Fails for jan@example.org" } }));
    const failure = await propose(p.owner, { number: issue.number }).catch((e) => e);
    expect(String(failure?.message ?? failure)).toMatch(/ISSUES_GITHUB_REDACTION_HIT/);
    expect(String(failure?.message ?? failure)).not.toContain("jan@example");
    expect(await run((tx) => tx.entity.count({ where: { projectId: p.owner.projectId, kind: "action_requests", data: { path: ["payload", "args", "number"], equals: issue.number } } }))).toBe(0);
  });

  it("is refused while the GitHub flag is off", async () => {
    const issue = await readyIssue();
    delete process.env.ORBIT_ISSUES_GITHUB;
    try {
      await expect(propose(p.owner, { number: issue.number })).rejects.toThrow(/ISSUES_GITHUB_DISABLED/);
    } finally {
      process.env.ORBIT_ISSUES_GITHUB = "true";
    }
  });
});

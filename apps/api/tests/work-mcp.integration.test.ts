import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest, listActionRequests } from "../src/modules/action-requests.ts";
import {
  authorizeMcpCall,
  visibleMcpTools,
  visibleMcpToolsForDiscovery,
} from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { MCP_RESOURCE_SCOPES } from "../src/platform/mcp/server.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { registeredActionType, registeredTools } from "../src/platform/modules/contributions.ts";
import { availableTools } from "../src/modules/agents/tools/registry.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { userActor } from "../src/modules/work/common.ts";
import { createPackageProject } from "./support/package-project.ts";

registerModules();

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// MCP proposals need the MCP 2.0 switch, as for Support and Finance.
const ENV = { ORBIT_WORK: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true", ORBIT_MCP_TASKS: "true" };
const READS = ["work_get_task", "work_list_initiatives", "work_my_tasks", "work_progress", "work_search_tasks"];
const PROPOSALS = ["work_propose_comment", "work_propose_initiative", "work_propose_task_update", "work_propose_tasks"];
const ALL = ["orbit:read", "orbit:propose", "orbit:work"];

describe("work tool contracts (ADR 0016)", () => {
  // The module's tools count only while it is switched on for the installation.
  beforeAll(() => {
    process.env.ORBIT_WORK = "true";
  });
  afterAll(() => {
    delete process.env.ORBIT_WORK;
  });
  it("registers five reads and four editor-decided proposals with the work scope", () => {
    const tools = registeredTools().filter((t) => t.namespace === "work");
    expect(tools.map((t) => t.name).sort()).toEqual([...READS, ...PROPOSALS].sort());
    for (const tool of tools) {
      expect(tool.mcpScopes).toEqual(["orbit:work"]);
      expect(tool.feature).toBe("work");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.risk).toBe(PROPOSALS.includes(tool.name) ? "P_proposal" : "R0_read");
    }
    for (const name of PROPOSALS) {
      const type = registeredActionType(`work.mcp.${name}`)!;
      expect(type.deciderRole).toBe("editor");
      expect(type.policyRequired).toBe(false);
    }
    // Support and finance proposals stay with the owner.
    expect(registeredActionType("finance.mcp.finance_retry_extraction")!.deciderRole).toBe("owner");
    expect(MCP_SCOPES).toContain("orbit:work");
    expect(MCP_RESOURCE_SCOPES).toContain("orbit:work");
  });

  it("offers proposals to editors but not to viewers", () => {
    const names = (role: Scope["role"]) =>
      availableTools(registeredTools(), role, ["work"]).map((t) => t.name).filter((n) => n.startsWith("work_"));
    expect(names("editor").sort()).toEqual([...READS, ...PROPOSALS].sort());
    expect(names("viewer").sort()).toEqual(READS);
    // Without the module's feature (module off) nothing is offered.
    expect(availableTools(registeredTools(), "owner", []).filter((t) => t.name.startsWith("work_"))).toEqual([]);
  });
});

describe.skipIf(!enabled)("work MCP tools (SQL, no model call)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let p: McpPrincipal;
  const previous: Record<string, string | undefined> = {};
  const owner = () => project.owner;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) => scoped(owner().workspaceId, owner().projectId, fn);
  const names = async (principal: McpPrincipal) =>
    (await visibleMcpTools(principal, owner().projectId)).map((t) => t.name).filter((n) => n.startsWith("work_")).sort();
  const context = (scope: Scope, principal: McpPrincipal) => ({
    scope: moduleScope(scope, "work"),
    runId: "synthetic-work-mcp",
    conversationId: "synthetic-work-mcp",
    callIndex: 0,
    channel: { kind: "mcp" as const, clientId: principal.clientId, grantId: principal.grantId, requestId: "synthetic-work-mcp" },
  });
  async function op(name: string, args: unknown, principal = p): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(principal, name, owner().projectId);
    const result = await tool.execute(context(scope, principal), args);
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
        clientId: `https://client.test/work-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes,
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      clientId: grant.clientId,
      grantId: grant.id,
      projectIds: [scope.projectId],
      scopes: new Set(grant.scopes),
      modules: [],
    };
  }

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    project = await createPackageProject({ name: "Synthetic work MCP" });
    await run((tx) =>
      tx.projectModule.create({
        data: { workspaceId: owner().workspaceId, projectId: owner().projectId, moduleId: "work", enabled: true, moduleVersion: "1.0.0" },
      }),
    );
    p = await grantFor(owner(), ALL);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await project?.cleanup();
    await closeDatabase();
  });

  it("lists the tools by scope set and asks for orbit:work at discovery", async () => {
    expect(await names(p)).toEqual([...READS, ...PROPOSALS].sort());
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:propose"]))).toEqual([]);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:work"]))).toEqual(READS);
    const discovery = (await visibleMcpToolsForDiscovery(await grantFor(owner(), ["orbit:read"]), owner().projectId))
      .map((t) => t.name)
      .filter((n) => n.startsWith("work_"))
      .sort();
    expect(discovery).toEqual(READS);
    process.env.ORBIT_MCP_PROPOSALS = "false";
    try {
      expect(await names(p)).toEqual(READS);
    } finally {
      process.env.ORBIT_MCP_PROPOSALS = "true";
    }
    // Without MCP 2.0 a client may not propose, so the proposals are not listed.
    process.env.ORBIT_MCP_TASKS = "false";
    try {
      expect(await names(p)).toEqual(READS);
    } finally {
      process.env.ORBIT_MCP_TASKS = "true";
    }
  });

  it("hides every tool while the module is off and from viewers' proposals", async () => {
    await run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "work" }, data: { enabled: false } }));
    try {
      expect(await names(p)).toEqual([]);
    } finally {
      await run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "work" }, data: { enabled: true } }));
    }
    expect(await names(await grantFor(project.viewer, ALL))).toEqual(READS);
  });

  it("proposes tasks, lets an editor approve them once and reads them back", async () => {
    const proposal = await op("work_propose_tasks", {
      idempotencyKey: "batch-1",
      tasks: [{ title: "Write the launch post", priority: "high" }, { title: "Check the order flow", checklist: ["reproduce"] }],
    });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true, deduplicated: false });
    const again = await op("work_propose_tasks", {
      idempotencyKey: "batch-1",
      tasks: [{ title: "Write the launch post", priority: "high" }, { title: "Check the order flow", checklist: ["reproduce"] }],
    });
    expect(again).toMatchObject({ actionRequestId: proposal.actionRequestId, deduplicated: true });
    expect(await run((tx) => tx.workTask.count({ where: { projectId: owner().projectId } }))).toBe(0);
    // The editor finds it in the approvals list, with the module's summary
    // (so the work renderer shows it); a viewer's list stays empty.
    const listed = (await run((tx) => listActionRequests(tx, project.editor))).find((r) => r.id === proposal.actionRequestId);
    expect(listed).toMatchObject({
      actionType: "work.mcp.work_propose_tasks",
      summary: { operation: { kind: "tasks", titles: ["Write the launch post", "Check the order flow"] } },
    });
    expect(await run((tx) => listActionRequests(tx, project.viewer))).toEqual([]);
    await decide(project.editor, proposal.actionRequestId);
    const tasks = await run((tx) => tx.workTask.findMany({ where: { projectId: owner().projectId }, orderBy: { number: "asc" } }));
    expect(tasks.map((t) => [t.title, t.source])).toEqual([
      ["Write the launch post", "mcp"],
      ["Check the order flow", "mcp"],
    ]);
    // Repeating the approval of the consumed request executes nothing again.
    await decide(project.editor, proposal.actionRequestId).catch(() => undefined);
    expect(await run((tx) => tx.workTask.count({ where: { projectId: owner().projectId } }))).toBe(2);
    const found = await op("work_search_tasks", { query: "launch" });
    expect(found.result.items).toEqual([expect.objectContaining({ number: tasks[0]!.number, title: "Write the launch post", version: 1 })]);
    const detail = await op("work_get_task", { number: tasks[1]!.number });
    expect(detail.result.checklist).toEqual([{ text: "reproduce", done: false }]);
  });

  it("refuses a stale update at approval and a viewer's decision", async () => {
    const task = await run((tx) => createTask(tx, owner(), { title: "Versioned" }, userActor(owner())));
    const proposal = await op("work_propose_task_update", {
      idempotencyKey: "update-1",
      number: task.number,
      expectedVersion: task.version,
      changes: { status: "in_progress" },
    });
    await expect(decide(project.viewer, proposal.actionRequestId)).rejects.toThrow();
    // The task changes in Orbit meanwhile.
    await run((tx) => tx.workTask.update({ where: { id: task.id }, data: { version: { increment: 1 } } }));
    await expect(decide(project.editor, proposal.actionRequestId)).rejects.toThrow("WORK_VERSION_CONFLICT");
    expect((await run((tx) => tx.workTask.findFirstOrThrow({ where: { id: task.id } }))).status).toBe("todo");
  });

  it("refuses a proposal the service would refuse before anyone is asked", async () => {
    const code = (name: string, args: unknown) =>
      op(name, args).then(
        () => "resolved",
        (e: { code?: string; message: string }) => e.code ?? e.message,
      );
    const requests = () => run((tx) => tx.entity.count({ where: { projectId: owner().projectId, kind: "action_requests" } }));
    const before = await requests();
    expect(
      await code("work_propose_tasks", {
        idempotencyKey: "invalid-assignee",
        tasks: [{ title: "Viewer owns it", assigneeUserId: project.viewer.userId }],
      }),
    ).toBe("WORK_ASSIGNEE_INVALID");
    const task = await run((tx) => createTask(tx, owner(), { title: "Checked early" }, userActor(owner())));
    expect(
      await code("work_propose_task_update", {
        idempotencyKey: "stale",
        number: task.number,
        expectedVersion: task.version + 1,
        changes: { priority: "high" },
      }),
    ).toBe("WORK_VERSION_CONFLICT");
    expect(
      await code("work_propose_task_update", {
        idempotencyKey: "unknown-status",
        number: task.number,
        expectedVersion: task.version,
        changes: { status: "nonexistent" },
      }),
    ).toBe("WORK_STATUS_UNKNOWN");
    await run((tx) => createInitiative(tx, owner(), { title: "Taken", key: "TAKEN" }, userActor(owner())));
    expect(await code("work_propose_initiative", { idempotencyKey: "taken", title: "Again", key: "taken" })).toBe("WORK_KEY_TAKEN");
    expect(await requests()).toBe(before);
  });

  it("creates initiatives with milestones and comments after approval", async () => {
    const initiative = await op("work_propose_initiative", {
      idempotencyKey: "initiative-1",
      title: "Marketplace launch",
      key: "mkt",
      milestones: [{ title: "Beta", dueDate: "2026-12-01" }],
    });
    await decide(owner(), initiative.actionRequestId);
    const row = await run((tx) => tx.workInitiative.findFirstOrThrow({ where: { projectId: owner().projectId, key: "MKT" } }));
    expect(await run((tx) => tx.workMilestone.count({ where: { initiativeId: row.id } }))).toBe(1);
    const progress = await op("work_progress", { initiativeKey: "MKT" });
    expect(progress.result.initiative).toMatchObject({ key: "MKT", title: "Marketplace launch" });
    const task = await run((tx) => tx.workTask.findFirstOrThrow({ where: { projectId: owner().projectId }, orderBy: { number: "asc" } }));
    const comment = await op("work_propose_comment", { idempotencyKey: "comment-1", number: task.number, body: "Ready for review" });
    await decide(project.editor, comment.actionRequestId);
    const comments = await run((tx) => tx.workComment.findMany({ where: { taskId: task.id } }));
    expect(comments).toEqual([expect.objectContaining({ bodyText: "Ready for review", authorKind: "agent", authorUserId: null })]);
    expect(await op("work_get_task", { number: 99999 }).catch((e: { code?: string; message: string }) => e.code ?? e.message)).toBe(
      "WORK_TASK_NOT_FOUND",
    );
  });
});

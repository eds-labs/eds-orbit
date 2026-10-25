import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { exposedToAssistant } from "../src/platform/agents/tools/registry.ts";
import { authorizeMcpCall, visibleMcpTools, visibleMcpToolsForDiscovery } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { MCP_RESOURCE_SCOPES } from "../src/platform/mcp/server.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
import { registeredActionType, registeredTools } from "../src/platform/modules/contributions.ts";
import { authorizeDelegatedTool, type Delegation } from "../src/platform/tasks/delegation.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { workPmRequestPlan, workPmStatus } from "../src/modules/work/pm/tools.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async () => {
    throw new Error("NO_MODEL_CALL_EXPECTED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const READS = ["work_pm_findings", "work_pm_get_plan", "work_pm_get_report", "work_pm_status"];
const PROPOSALS = ["work_pm_propose_changes", "work_pm_propose_coding_run", "work_pm_propose_plan", "work_pm_propose_report"];
const ALL = ["orbit:read", "orbit:propose", "orbit:work", "orbit:work.pm", "orbit:work.coding"];

describe("AI project manager MCP contracts (WP2.10)", () => {
  // The module's tools count only while it is switched on for the installation.
  const env = withEnv({ ORBIT_WORK: "true" });
  beforeAll(() => env.apply());
  afterAll(() => env.restore());
  it("registers the new scopes everywhere and keeps spending tools apart", () => {
    for (const scope of ["orbit:work.pm", "orbit:work.coding"]) {
      expect(MCP_SCOPES).toContain(scope);
      expect(MCP_RESOURCE_SCOPES).toContain(scope);
    }
    const byName = new Map(registeredTools().map((t) => [t.name, t]));
    expect(byName.get("work_pm_propose_plan")!.mcpScopes).toEqual(["orbit:work", "orbit:work.pm"]);
    expect(byName.get("work_pm_propose_report")!.mcpScopes).toEqual(["orbit:work", "orbit:work.pm"]);
    expect(byName.get("work_pm_propose_changes")!.mcpScopes).toEqual(["orbit:work"]);
    expect(byName.get("work_pm_propose_coding_run")!.mcpScopes).toEqual(["orbit:work", "orbit:work.coding"]);
    // MCP proposals are never offered to the assistant (or delegated orders through it).
    for (const name of PROPOSALS) expect(exposedToAssistant(byName.get(name)!)).toBe(false);
    expect(registeredActionType("work.mcp.work_pm_propose_coding_run")!.deciderRole).toBe("owner");
    expect(registeredActionType("work.mcp.work_pm_propose_plan")!.deciderRole).toBe("editor");
  });
});

describe.skipIf(!enabled)("AI project manager MCP tools", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  let principal: McpPrincipal;
  const env = withEnv({
    ORBIT_WORK: "true",
    ORBIT_WORK_PM: "true",
    ORBIT_MODULES: "true",
    ORBIT_MCP_PROPOSALS: "true",
    ORBIT_MCP_TASKS: "true",
  });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  async function grantFor(scope: Scope, scopes: string[]): Promise<McpPrincipal> {
    const grant = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://client.test/pm-${randomUUID()}.json`,
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
  const names = async (who: McpPrincipal) =>
    (await visibleMcpTools(who, p.owner.projectId)).map((t) => t.name).filter((n) => n.startsWith("work_pm_")).sort();
  async function op(who: McpPrincipal, name: string, args: unknown): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(who, name, p.owner.projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "work"),
        runId: "synthetic-pm-mcp",
        conversationId: "synthetic-pm-mcp",
        callIndex: 0,
        channel: { kind: "mcp", clientId: who.clientId, grantId: who.grantId, requestId: "synthetic-pm-mcp" },
      },
      args,
    );
    return result.output;
  }
  const decide = (who: Scope, id: string) =>
    p.run(async (tx) => {
      const row = await entity(tx, who, "action_requests", id);
      return decideActionRequest(tx, who, id, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    await p.run((tx) => createInitiative(tx, p.owner, { title: "Launch", key: "LAUNCH" }, p.as(p.owner)));
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) =>
      savePmSettings(
        tx,
        p.owner,
        {
          ...current.settings,
          repositories: [
            { key: "orbit", label: "Orbit", provider: "github", fullName: "eds-labs/eds-orbit", defaultBranch: "main", dispatch: { kind: "manual" } },
          ],
        },
        current.version,
      ),
    );
    principal = await grantFor(p.owner, ALL);
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("lists PM tools by scope set; spending and coding need their own consent", async () => {
    expect(await names(principal)).toEqual([...READS, ...PROPOSALS].sort());
    expect(await names(await grantFor(p.owner, ["orbit:read", "orbit:propose", "orbit:work"]))).toEqual(
      [...READS, "work_pm_propose_changes"].sort(),
    );
    expect(await names(await grantFor(p.owner, ["orbit:read", "orbit:work"]))).toEqual(READS);
    const discovery = (await visibleMcpToolsForDiscovery(await grantFor(p.owner, ["orbit:read"]), p.owner.projectId))
      .map((t) => t.name)
      .filter((n) => n.startsWith("work_pm_"));
    expect(discovery.sort()).toEqual(READS);
    process.env.ORBIT_WORK_PM = "false";
    try {
      expect(await names(principal)).toEqual([]);
    } finally {
      process.env.ORBIT_WORK_PM = "true";
    }
  });

  it("asks a member to approve a plan request before anything is spent", async () => {
    const proposal = await op(principal, "work_pm_propose_plan", { idempotencyKey: "plan-1", goal: "Plan the launch", initiativeKey: "launch" });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    expect(await p.run((tx) => tx.workPlanProposal.count({ where: { projectId: p.owner.projectId } }))).toBe(0);
    await decide(p.editor, proposal.actionRequestId);
    const plans = await p.run((tx) => tx.workPlanProposal.findMany({ where: { projectId: p.owner.projectId } }));
    expect(plans.map((x) => [x.status, x.requestedVia, x.kind])).toEqual([["queued", "mcp", "extension"]]);
  });

  it("dispatches a coding work order only with the owner's approval of the redacted brief", async () => {
    const task = await p.run((tx) => createTask(tx, p.owner, { title: "Fees" }, p.as(p.owner)));
    const proposal = await op(principal, "work_pm_propose_coding_run", {
      idempotencyKey: "coding-1",
      number: task.number,
      repositoryKey: "orbit",
      goal: "Add a fee column",
      description: "Call +49 170 1234567 for access.",
      acceptanceCriteria: ["Fee visible"],
    });
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", proposal.actionRequestId));
    const summary = registeredActionType("work.mcp.work_pm_propose_coding_run")!.summary!(data(request).payload);
    expect(JSON.stringify(summary)).not.toContain("1234567");
    expect(await failure(decide(p.editor, proposal.actionRequestId))).toBe("OWNER_REQUIRED");
    await decide(p.owner, proposal.actionRequestId);
    const runs = await p.run((tx) => tx.workCodingRun.findMany({ where: { taskId: task.id } }));
    expect(runs.map((r) => [r.status, r.personalDataReviewed])).toEqual([["dispatched", true]]);
    expect(JSON.stringify(runs[0]!.brief)).not.toContain("1234567");
  });

  it("lets delegated work orders read the PM's state but never spend or dispatch", async () => {
    const delegation: Delegation = {
      taskId: randomUUID(),
      grantId: principal.grantId,
      clientId: principal.clientId,
      userId: p.owner.userId,
      scopes: ALL,
      modules: ["work"],
      mode: "execute",
      ceilingMicros: 1_000_000,
    };
    expect(await authorizeDelegatedTool(p.owner, delegation, workPmStatus)).toBeTruthy();
    expect(await failure(authorizeDelegatedTool(p.owner, delegation, workPmRequestPlan))).toBe("MCP_TOOL_NOT_ALLOWED");
  });
});

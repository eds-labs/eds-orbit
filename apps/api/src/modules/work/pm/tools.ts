import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { defineTool, dropNullFields } from "../../../platform/agents/tools/registry.ts";
import { WORK_SCOPE } from "../../../platform/mcp/scopes.ts";
import { readOperation } from "../../../platform/tasks/operation-tools.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { authorize } from "../../../platform/tenancy/permissions.ts";
import { userScoped } from "../../../platform/tenancy/scope.ts";
import { DomainError } from "../../../shared.ts";
import { uuid } from "../common.ts";
import { requirePm } from "../gate.ts";
import { WORK_PM_USE, WORK_READ } from "../permissions.ts";
import { pmBudgetToday } from "./budget.ts";
import { listFindings } from "./monitor.ts";
import { loadProposal, proposalView, requestPlan } from "./planner.ts";
import { listReports, loadReport, requestReport } from "./reporter.ts";
import { getPmState } from "./state.ts";

// The AI project manager's assistant tools (plan §2.9, WP2.6). Reads serve
// the assistant and MCP clients (scope orbit:work); asking for a plan or a
// report spends the PM's budget and is offered to the in-app assistant
// only, where the member asks in person. The PM itself never chats: the
// result arrives as a notification and in the plan view.

const shared = { module: "work", feature: "work_pm" as const, mcpScopes: [WORK_SCOPE] };
const initiativeKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/);

async function initiativeByKey(tx: DbTx, scope: Scope, key: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, key: key.toUpperCase() },
    select: { id: true, key: true, title: true },
  });
  if (!row) throw new DomainError("WORK_INITIATIVE_NOT_FOUND", 404);
  return row;
}

export const workPmStatus = readOperation({
  ...shared,
  name: "work_pm_status",
  description:
    "The AI project manager's view of one initiative by key: whether it watches it, open findings by severity, the last report date and the PM budget used today.",
  input: z.object({ initiativeKey }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    await requirePm(tx, scope);
    const initiative = await initiativeByKey(tx, scope, args.initiativeKey);
    const [state, findings, budget] = await Promise.all([
      getPmState(tx, scope, initiative.id),
      listFindings(tx, scope, { initiativeId: initiative.id }),
      pmBudgetToday(tx, scope),
    ]);
    const count = (severity: string) => findings.filter((f) => f.severity === severity).length;
    return {
      initiative: { key: initiative.key, title: initiative.title },
      watching: state.enabled,
      reportSchedule: state.settings.reportSchedule,
      lastScanAt: state.lastScanAt,
      lastReportAt: state.lastReportAt,
      findings: { critical: count("critical"), warning: count("warning"), info: count("info") },
      budget,
    };
  },
});

export const workPmFindings = readOperation({
  ...shared,
  name: "work_pm_findings",
  description:
    "The monitor's open findings of one initiative: rule code, severity, task numbers and numbers such as days overdue. Rules, not opinions; no AI cost.",
  input: z.object({ initiativeKey }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    await requirePm(tx, scope);
    const initiative = await initiativeByKey(tx, scope, args.initiativeKey);
    const findings = await listFindings(tx, scope, { initiativeId: initiative.id });
    const ids = [...new Set(findings.flatMap((f) => f.taskIds))];
    const numbers = new Map(
      (
        await tx.workTask.findMany({
          where: { projectId: scope.projectId, id: { in: ids } },
          select: { id: true, number: true },
        })
      ).map((t) => [t.id, t.number]),
    );
    return {
      items: findings.map((f) => ({
        rule: f.rule,
        severity: f.severity,
        tasks: f.taskIds.map((id) => numbers.get(id)).filter((n) => n !== undefined),
        data: f.data,
        since: f.firstSeenAt,
      })),
    };
  },
});

export const workPmGetReport = readOperation({
  ...shared,
  name: "work_pm_get_report",
  description:
    "The latest AI status report of one initiative by key (or a report by id). The report is AI-generated; say so when quoting it.",
  input: z.object({ initiativeKey, reportId: uuid.optional() }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    await requirePm(tx, scope);
    const initiative = await initiativeByKey(tx, scope, args.initiativeKey);
    if (args.reportId) {
      const report = await loadReport(tx, scope, args.reportId);
      if (report.initiativeId !== initiative.id) throw new DomainError("NOT_FOUND", 404);
      return { report };
    }
    const [report] = await listReports(tx, scope, initiative.id);
    return { report: report ?? null };
  },
});

export const workPmGetPlan = readOperation({
  ...shared,
  name: "work_pm_get_plan",
  description:
    "A plan or adjustment proposal of the AI project manager by id: status, validation codes, the plan and whether it waits for approval.",
  input: z.object({ planId: uuid }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    await requirePm(tx, scope);
    const view = proposalView(await loadProposal(tx, scope, args.planId));
    return {
      id: view.id,
      kind: view.kind,
      status: view.status,
      revision: view.revision,
      validation: view.validation,
      plan: view.plan,
      actionRequestId: view.actionRequestId,
      appliedAt: view.appliedAt,
      errorCode: view.errorCode,
    };
  },
});

/** Runs an in-app request as the member, with their role in the module. */
async function asMember<T>(scope: Scope, work: (tx: DbTx, member: Scope) => Promise<T>) {
  const member = moduleScope(scope, "work");
  authorize(member, WORK_PM_USE);
  return userScoped(member, (tx) => work(tx, member));
}

export const workPmRequestPlan = defineTool({
  name: "work_pm_request_plan",
  namespace: "work",
  description:
    "Ask the AI project manager to plan an initiative in the background (about 1–2 minutes, paid from the PM's daily budget). Pass the member's goal in their words and, to extend one, the initiative key. The plan arrives as a notification and must be reviewed and approved in Orbit; do not draft large plans yourself.",
  parameters: z
    .object({
      goal: z.string(),
      constraints: z.string().nullable(),
      initiativeKey: initiativeKey.nullable(),
    })
    .strict(),
  risk: "W0_internal",
  permission: WORK_PM_USE,
  feature: "work_pm",
  deferLoading: true,
  exposure: { assistant: true, mcp: false },
  async execute(context, raw) {
    const args = dropNullFields(raw) as { goal: string; constraints?: string; initiativeKey?: string };
    const result = await asMember(context.scope, async (tx, member) => {
      const initiative = args.initiativeKey ? await initiativeByKey(tx, member, args.initiativeKey) : null;
      return requestPlan(
        tx,
        member,
        {
          goal: args.goal,
          ...(args.constraints ? { constraints: args.constraints } : {}),
          initiativeId: initiative?.id ?? null,
          idempotencyKey: `${context.runId}:${context.callIndex}`,
        },
        "assistant",
      );
    });
    return {
      output: { planId: result.proposal.id, status: result.proposal.status, deduplicated: result.deduplicated },
      cards: [{ kind: "status" as const, label: "Planning started", status: "in_progress" }],
    };
  },
});

export const workPmRequestReport = defineTool({
  name: "work_pm_request_report",
  namespace: "work",
  description:
    "Ask the AI project manager for a status report of one initiative by key. Returns the latest report when nothing changed since; otherwise the report is written in the background and arrives as a notification.",
  parameters: z.object({ initiativeKey }).strict(),
  risk: "W0_internal",
  permission: WORK_PM_USE,
  feature: "work_pm",
  deferLoading: true,
  exposure: { assistant: true, mcp: false },
  async execute(context, raw) {
    const args = raw as { initiativeKey: string };
    const result = await asMember(context.scope, async (tx, member) => {
      const initiative = await initiativeByKey(tx, member, args.initiativeKey);
      return requestReport(tx, member, initiative.id);
    });
    return {
      output: result,
      cards: [
        {
          kind: "status" as const,
          label: result.status === "unchanged" ? "No changes since the last report" : "Report requested",
          status: result.status === "unchanged" ? "completed" : "in_progress",
        },
      ],
    };
  },
});

export const pmTools = [
  workPmStatus,
  workPmFindings,
  workPmGetReport,
  workPmGetPlan,
  workPmRequestPlan,
  workPmRequestReport,
];

/** The assistant prompt fragment while the PM is on. */
export const pmInstructions = [
  "AI project manager (work module): for planning an initiative or a larger piece of work, call work_pm_request_plan with the member's goal instead of proposing many tasks yourself; the plan arrives later for review. Use work_pm_status, work_pm_findings and work_pm_get_report to answer questions about progress, risks and blockers; reports are AI-generated drafts.",
];

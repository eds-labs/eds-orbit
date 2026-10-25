import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { approvedOperation } from "../../../platform/tasks/operation-tools.ts";
import { WORK_CODING_SCOPE, WORK_PM_SCOPE, WORK_SCOPE } from "../../../platform/mcp/scopes.ts";
import { redactText } from "../../../platform/privacy/redact.ts";
import { can } from "../../../platform/tenancy/permissions.ts";
import { DomainError } from "../../../shared.ts";
import { assignableIds, dateInput } from "../common.ts";
import { requirePm } from "../gate.ts";
import { WORK_CODING_DISPATCH, WORK_PM_USE, WORK_WRITE } from "../permissions.ts";
import { loadTask, PRIORITIES, updateTask } from "../tasks.ts";
import { assertPmBudget } from "./budget.ts";
import { approveCodingDispatch, codingBriefInput, createCodingRun } from "./coding.ts";
import { requestPlan } from "./planner.ts";
import { requestReport } from "./reporter.ts";
import { readPmSettings } from "./settings.ts";

// The AI project manager's MCP proposals (plan §2.9, WP2.10). Outside
// clients always go through an approval in Orbit: asking for a plan or a
// report spends the PM's budget (scope orbit:work.pm, an owner or editor
// decides), bulk task changes need orbit:work, and a coding work order needs
// orbit:work.coding and the owner, whose approval of the exact redacted
// brief is the dispatch. Delegated MCP 2.0 orders see none of them.

const initiativeKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/);
/** The most one plan run may spend; at most the PM's daily ceiling. */
const PLAN_CEILING_MICROS = 1_000_000;
const REPORT_CEILING_MICROS = 200_000;
const base = { module: "work", feature: "work_pm" as const, mcpProjectRequired: true, assistant: false };

async function initiativeIdOf(tx: DbTx, scope: Scope, key: string | undefined) {
  if (!key) return null;
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, key: key.toUpperCase(), archivedAt: null },
    select: { id: true },
  });
  if (!row) throw new DomainError("WORK_INITIATIVE_NOT_FOUND", 404);
  return row.id;
}

const ceiling = (max: number) => async (tx: DbTx, scope: Scope) =>
  Math.min(max, (await readPmSettings(tx, scope)).settings.dailyCeilingMicros);

const planInput = z
  .object({
    goal: z.string().trim().min(3).max(3000),
    constraints: z.string().trim().max(900).optional(),
    initiativeKey: initiativeKey.optional(),
  })
  .strict();

export const workPmProposePlan = approvedOperation({
  ...base,
  name: "work_pm_propose_plan",
  description:
    "Propose that the AI project manager plans an initiative (paid from the project's PM budget). A member approves the request in Orbit; the plan then needs a second approval before anything is created.",
  input: planInput,
  permission: WORK_PM_USE,
  mcpScopes: [WORK_SCOPE, WORK_PM_SCOPE],
  deciderRole: "editor",
  spendCeiling: ceiling(PLAN_CEILING_MICROS),
  summary: (args) => ({ operation: { kind: "pm_plan", goal: args.goal, initiativeKey: args.initiativeKey ?? null } }),
  async validate(tx, scope, args) {
    await requirePm(tx, scope);
    await initiativeIdOf(tx, scope, args.initiativeKey);
    await assertPmBudget(tx, scope, 1);
  },
  async run(tx, scope, args) {
    const input = args as z.infer<typeof planInput>;
    const { proposal } = await requestPlan(
      tx,
      scope,
      {
        goal: input.goal,
        ...(input.constraints ? { constraints: input.constraints } : {}),
        initiativeId: await initiativeIdOf(tx, scope, input.initiativeKey),
        idempotencyKey: createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 64),
      },
      "mcp",
    );
    return { planId: proposal.id, status: proposal.status };
  },
});

const reportInput = z.object({ initiativeKey }).strict();

export const workPmProposeReport = approvedOperation({
  ...base,
  name: "work_pm_propose_report",
  description:
    "Propose a status report of one initiative by the AI project manager (paid from the PM budget; nothing is spent when nothing changed since the last report). A member approves the request in Orbit.",
  input: reportInput,
  permission: WORK_PM_USE,
  mcpScopes: [WORK_SCOPE, WORK_PM_SCOPE],
  deciderRole: "editor",
  spendCeiling: ceiling(REPORT_CEILING_MICROS),
  summary: (args) => ({ operation: { kind: "pm_report", initiativeKey: args.initiativeKey } }),
  async validate(tx, scope, args) {
    await requirePm(tx, scope);
    await initiativeIdOf(tx, scope, args.initiativeKey);
  },
  async run(tx, scope, args) {
    const id = (await initiativeIdOf(tx, scope, (args as z.infer<typeof reportInput>).initiativeKey))!;
    return requestReport(tx, scope, id);
  },
});

const changesInput = z
  .object({
    rationale: z.string().trim().min(3).max(1000),
    changes: z
      .array(
        z
          .object({
            number: z.int().min(1),
            expectedVersion: z.int().min(1),
            priority: z.enum(PRIORITIES).optional(),
            dueDate: dateInput.nullable().optional(),
            assigneeUserId: z.string().min(1).max(100).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

async function boundChanges(tx: DbTx, scope: Scope, input: z.infer<typeof changesInput>) {
  if (new Set(input.changes.map((c) => c.number)).size !== input.changes.length)
    throw new DomainError("WORK_CHANGES_DUPLICATE", 422);
  const assignable = await assignableIds(scope);
  const tasks = await tx.workTask.findMany({
    where: { projectId: scope.projectId, number: { in: input.changes.map((c) => c.number) } },
    select: { id: true, number: true, version: true },
  });
  return input.changes.map((change) => {
    const task = tasks.find((t) => t.number === change.number);
    if (!task) throw new DomainError("WORK_TASK_NOT_FOUND", 404);
    if (task.version !== change.expectedVersion) throw new DomainError("WORK_VERSION_CONFLICT", 409);
    if (change.assigneeUserId && !assignable.has(change.assigneeUserId))
      throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
    const { number: _n, ...update } = change;
    return { taskId: task.id, update };
  });
}

export const workPmProposeChanges = approvedOperation({
  ...base,
  name: "work_pm_propose_changes",
  description:
    "Propose priority, due date and assignee changes to up to 50 tasks at once, each with the version you read. A member approves the whole set in Orbit; a task changed meanwhile fails the approval.",
  input: changesInput,
  permission: WORK_WRITE,
  mcpScopes: [WORK_SCOPE],
  deciderRole: "editor",
  policyRequired: false,
  requires: [],
  summary: (args) => ({ operation: { kind: "bulk_update", tasks: args.changes.length, rationale: args.rationale } }),
  async validate(tx, scope, args) {
    await requirePm(tx, scope);
    await boundChanges(tx, scope, args);
  },
  async run(tx, scope, args, requester) {
    const changes = await boundChanges(tx, scope, args as z.infer<typeof changesInput>);
    const actor = { kind: requester?.kind === "mcp" ? ("mcp" as const) : ("agent" as const), id: scope.userId };
    for (const change of changes) await updateTask(tx, scope, change.taskId, change.update, actor);
    return { tasks: changes.length };
  },
});

const codingInput = codingBriefInput
  .extend({
    number: z.int().min(1),
    repositoryKey: z.string().min(1).max(41),
    ceilingMicros: z.int().min(0).max(100_000_000).optional(),
  })
  .strict();

export const workPmProposeCodingRun = approvedOperation({
  ...base,
  name: "work_pm_propose_coding_run",
  description:
    "Propose a coding work order for one task by number: repository key, goal, acceptance criteria and constraints for an external coding agent. Personal data and credentials are removed; the owner approves the exact redacted brief in Orbit, which dispatches it. Never asks to merge or deploy.",
  input: codingInput,
  permission: WORK_PM_USE,
  mcpScopes: [WORK_SCOPE, WORK_CODING_SCOPE],
  deciderRole: "owner",
  policyRequired: false,
  requires: [],
  spendCeiling: async (_tx, _scope, args) => (args as { ceilingMicros?: number }).ceilingMicros ?? 0,
  // The owner decides on exactly the text that would leave Orbit.
  summary: (args) => {
    const clean = (t: string) => redactText(t).text;
    return {
      operation: {
        kind: "coding_dispatch",
        task: args.number,
        repository: args.repositoryKey,
        goal: clean(args.goal),
        description: clean(args.description ?? ""),
        acceptanceCriteria: args.acceptanceCriteria.map(clean),
        constraints: (args.constraints ?? []).map(clean),
        doNotTouch: (args.doNotTouch ?? []).map(clean),
        ceilingMicros: args.ceilingMicros ?? 0,
      },
    };
  },
  async validate(tx, scope, args) {
    await requirePm(tx, scope);
    const task = await tx.workTask.findFirst({
      where: { projectId: scope.projectId, number: args.number, archivedAt: null },
      select: { statusCategory: true },
    });
    if (!task) throw new DomainError("WORK_TASK_NOT_FOUND", 404);
    if (["done", "canceled"].includes(task.statusCategory)) throw new DomainError("WORK_TASK_CLOSED", 409);
    const { settings } = await readPmSettings(tx, scope);
    if (!settings.repositories.some((r) => r.key === args.repositoryKey))
      throw new DomainError("WORK_CODING_REPOSITORY_UNKNOWN", 422);
  },
  async run(tx, scope, args) {
    // The decider is the owner; the dispatch permission is checked again.
    if (!can(scope, WORK_CODING_DISPATCH)) throw new DomainError("OWNER_REQUIRED", 403);
    const { number, repositoryKey, ceilingMicros, ...brief } = args as z.infer<typeof codingInput>;
    const task = await tx.workTask.findFirstOrThrow({
      where: { projectId: scope.projectId, number },
      select: { id: true },
    });
    await loadTask(tx, scope, task.id);
    const draft = await createCodingRun(tx, scope, task.id, {
      repositoryKey,
      brief,
      ...(ceilingMicros !== undefined ? { ceilingMicros } : {}),
    });
    const run = await approveCodingDispatch(tx, scope, draft.id, scope.userId);
    return { codingRunId: run.id, status: run.status };
  },
});

const proposals = [workPmProposePlan, workPmProposeReport, workPmProposeChanges, workPmProposeCodingRun];
export const pmMcpTools = proposals.map((p) => p.tool);
export const pmMcpActionTypes = Object.fromEntries(proposals.map((p) => [p.actionType, p.action]));

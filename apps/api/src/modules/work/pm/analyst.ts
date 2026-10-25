import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { runStructured } from "../../../platform/agents/structured-run.ts";
import {
  createActionRequest,
  SYSTEM_ACTOR_ID,
  type ActionDefinition,
} from "../../../platform/governance/action-requests.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { audit, data, DomainError, update } from "../../../shared.ts";
import { assignableIds, dateInput, fromDate, uuid } from "../common.ts";
import { pmActive, requirePm } from "../gate.ts";
import { PRIORITIES, updateTask } from "../tasks.ts";
import { assertPmBudget, PM_BUDGET_CATEGORY } from "./budget.ts";
import { initiativeContext } from "./context.ts";
import { ANALYST_INSTRUCTIONS } from "./instructions.ts";
import { pmSnapshot } from "./monitor.ts";
import { loadProposal, PM_QUEUE, pmActor } from "./planner.ts";
import { evaluateRules, stateHash } from "./rules.ts";

// Re-prioritization proposals (plan §2.5): on request or when a critical
// finding appears (at most once per initiative and day). The analyst
// proposes priority, due date and assignee changes to open tasks; the
// changes are checked against the tasks as they are, bound to their
// versions and become one `work.tasks.bulk_update` request an editor
// decides. Nothing changes without that decision.

export const BULK_UPDATE = "work.tasks.bulk_update";
const ANALYST_LIMITS = {
  maxModelCalls: 2,
  maxToolCalls: 1,
  maxWebSearches: 0,
  timeoutMs: 90_000,
  maxInputBytes: 80_000,
};
const DAY = 86_400_000;

const text = (max: number) =>
  z.string().refine((v) => v.trim().length > 0 && v.length <= max, `1 to ${max} characters`);

export const adjustmentOutput = z
  .object({
    rationale: text(1000),
    changes: z
      .array(
        z
          .object({
            taskNumber: z.int().min(1),
            priority: z.enum(PRIORITIES).nullable(),
            dueDate: dateInput.nullable(),
            assigneeUserId: z.string().refine((v) => v.length <= 100).nullable(),
            reason: text(300),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

const fieldsSchema = z
  .object({
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dateInput.optional(),
    assigneeUserId: z.string().min(1).max(100).optional(),
  })
  .strict();
/** A stored adjustment: each change bound to the task's version when proposed. */
export const adjustmentSchema = z
  .object({
    rationale: z.string().max(1000),
    changes: z
      .array(
        z
          .object({
            taskId: uuid,
            number: z.int().min(1),
            expectedVersion: z.int().min(1),
            set: fieldsSchema,
            reason: z.string().max(300),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type Adjustment = z.infer<typeof adjustmentSchema>;

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Checks the analyst's changes against the tasks as they are now. */
export async function bindAdjustment(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  output: z.infer<typeof adjustmentOutput>,
) {
  const warnings: string[] = [];
  const assignable = await assignableIds(scope);
  const tasks = await tx.workTask.findMany({
    where: {
      projectId: scope.projectId,
      initiativeId,
      archivedAt: null,
      number: { in: output.changes.map((c) => c.taskNumber) },
      statusCategory: { notIn: ["done", "canceled"] },
    },
  });
  const byNumber = new Map(tasks.map((t) => [t.number, t]));
  const changes: Adjustment["changes"] = [];
  for (const change of output.changes) {
    const task = byNumber.get(change.taskNumber);
    if (!task || changes.some((c) => c.taskId === task.id)) {
      warnings.push(`task_unknown:${change.taskNumber}`);
      continue;
    }
    const set: z.infer<typeof fieldsSchema> = {};
    if (change.priority && change.priority !== task.priority) set.priority = change.priority;
    if (change.dueDate && change.dueDate !== fromDate(task.dueDate)) set.dueDate = change.dueDate;
    if (change.assigneeUserId && change.assigneeUserId !== task.assigneeUserId) {
      if (assignable.has(change.assigneeUserId)) set.assigneeUserId = change.assigneeUserId;
      else warnings.push(`assignee_dropped:${change.taskNumber}`);
    }
    if (!Object.keys(set).length) {
      warnings.push(`no_change:${change.taskNumber}`);
      continue;
    }
    changes.push({ taskId: task.id, number: task.number, expectedVersion: task.version, set, reason: change.reason });
  }
  return { adjustment: { rationale: output.rationale, changes }, warnings };
}

/**
 * Queues an analysis of an initiative. A member's request is deduplicated
 * by state; the monitor's (`automatic`) at most once per initiative and day.
 */
export async function requestAnalysis(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  options: { automatic?: boolean } = {},
  now = new Date(),
) {
  if (!options.automatic) await requirePm(tx, scope);
  else if (!(await pmActive(tx, scope))) return null;
  const initiative = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(initiativeId), archivedAt: null },
    select: { id: true },
  });
  if (!initiative) {
    if (options.automatic) return null;
    throw new DomainError("NOT_FOUND", 404);
  }
  const snapshot = await pmSnapshot(tx, scope, initiative.id, now);
  const hash = stateHash(snapshot, evaluateRules(snapshot));
  const key = options.automatic
    ? `pm-analysis:${initiative.id}:${now.toISOString().slice(0, 10)}`
    : `pm-analysis:${initiative.id}:${hash}`;
  const existing = await tx.workPlanProposal.findFirst({
    where: { projectId: scope.projectId, idempotencyKey: key },
  });
  if (existing) return { proposal: existing, deduplicated: true };
  if (options.automatic) {
    const state = await tx.workPmState.findFirst({
      where: { projectId: scope.projectId, initiativeId: initiative.id },
      select: { lastAnalysisAt: true },
    });
    if (state?.lastAnalysisAt && now.getTime() - state.lastAnalysisAt.getTime() < DAY) return null;
    try {
      await assertPmBudget(tx, scope, 1, now);
    } catch {
      await audit(tx, scope, "work.pm.analysis_skipped", initiative.id, { code: "WORK_PM_BUDGET_EXHAUSTED" });
      return null;
    }
  } else await assertPmBudget(tx, scope, 1, now);
  const proposal = await tx.workPlanProposal.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      initiativeId: initiative.id,
      kind: "adjustment",
      status: "queued",
      requestedBy: options.automatic ? SYSTEM_ACTOR_ID : scope.userId,
      requestedVia: options.automatic ? "monitor" : "ui",
      idempotencyKey: key,
    },
  });
  await tx.workPmState.updateMany({
    where: { projectId: scope.projectId, initiativeId: initiative.id },
    data: { lastAnalysisAt: now },
  });
  await enqueue(tx, scope, PM_QUEUE, proposal.id, `work_pm:analyse:${proposal.id}`, now, { kind: "analyse" });
  await audit(tx, scope, "work.pm.analysis_requested", proposal.id, {
    initiativeId: initiative.id,
    automatic: Boolean(options.automatic),
  });
  return { proposal, deduplicated: false };
}

/** The `analyse` job of one adjustment proposal. */
export async function runAnalysisJob(workerScope: Scope, proposalId: string, now = new Date()) {
  const prepared = await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const proposal = await loadProposal(tx, workerScope, proposalId);
    if (!["queued", "running"].includes(proposal.status) || !proposal.initiativeId) return null;
    if (!(await pmActive(tx, workerScope))) {
      await tx.workPlanProposal.update({
        where: { id: proposal.id },
        data: { status: "failed", errorCode: "WORK_PM_DISABLED", version: { increment: 1 } },
      });
      return null;
    }
    await tx.workPlanProposal.update({
      where: { id: proposal.id },
      data: { status: "running", version: { increment: 1 } },
    });
    return { proposal, context: await initiativeContext(tx, workerScope, proposal.initiativeId, now) };
  });
  if (!prepared) return;
  const { proposal } = prepared;
  const key = `work_pm:analyse:${proposal.id}`;
  const result = await runStructured(workerScope, {
    agentName: "work.pm_analyst",
    taskClass: "pm_analysis",
    kind: "work_pm",
    subject: { type: "work.plan_proposal", id: proposal.id },
    instructions: ANALYST_INSTRUCTIONS.text,
    input: prepared.context,
    tools: [],
    outputSchema: adjustmentOutput,
    limits: ANALYST_LIMITS,
    budget: {
      category: PM_BUDGET_CATEGORY,
      runKey: key,
      callKey: key,
      check: (tx, s, estimate, at) => assertPmBudget(tx, s, estimate, at),
    },
    guard: (tx, s) => requirePm(tx, s),
  });
  await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const current = await loadProposal(tx, workerScope, proposal.id);
    if (current.status !== "running") return;
    if (result.status !== "ok") {
      await tx.workPlanProposal.update({
        where: { id: proposal.id },
        data: {
          status: "failed",
          errorCode: result.code,
          agentRunId: result.agentRunId,
          costMicros: BigInt(result.costMicros),
          version: { increment: 1 },
        },
      });
      return;
    }
    const { adjustment, warnings } = await bindAdjustment(tx, workerScope, proposal.initiativeId!, result.output);
    const valid = adjustment.changes.length > 0;
    const planHash = hashOf(adjustment);
    let actionRequestId: string | null = null;
    if (valid) {
      const initiative = await tx.workInitiative.findFirstOrThrow({
        where: { projectId: workerScope.projectId, id: proposal.initiativeId! },
        select: { title: true },
      });
      const request = await createActionRequest(tx, workerScope, {
        actionType: BULK_UPDATE,
        payload: {
          proposalId: proposal.id,
          planHash,
          initiativeTitle: initiative.title,
          tasks: adjustment.changes.length,
        },
        requestedBy: {
          kind: "agent",
          userId: proposal.requestedBy,
          agentRunId: result.agentRunId,
        },
      });
      actionRequestId = request.id;
    }
    await tx.workPlanProposal.update({
      where: { id: proposal.id },
      data: {
        status: valid ? "proposed" : "invalid",
        plan: adjustment as Prisma.InputJsonValue,
        validation: { errors: valid ? [] : ["ADJUSTMENT_EMPTY"], warnings } as Prisma.InputJsonValue,
        planHash,
        actionRequestId,
        errorCode: valid ? null : "ADJUSTMENT_EMPTY",
        agentRunId: result.agentRunId,
        costMicros: BigInt(result.costMicros),
        version: { increment: 1 },
      },
    });
    await audit(tx, workerScope, valid ? "work.pm.adjustment_proposed" : "work.pm.adjustment_empty", proposal.id, {
      changes: adjustment.changes.length,
    });
  });
}

const bulkPayload = z
  .object({
    proposalId: z.uuid(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    initiativeTitle: z.string(),
    tasks: z.int().min(1).max(50),
  })
  .strict();
type BulkPayload = z.infer<typeof bulkPayload>;

/** The proposal is still open, unchanged, and its tasks still at their versions. */
async function stillCurrent(tx: DbTx, scope: Scope, p: BulkPayload) {
  await requirePm(tx, scope);
  const proposal = await loadProposal(tx, scope, p.proposalId);
  if (proposal.status !== "proposed" || proposal.kind !== "adjustment" || proposal.planHash !== p.planHash)
    throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  const adjustment = adjustmentSchema.parse(proposal.plan);
  if (hashOf(adjustment) !== p.planHash) throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  const tasks = await tx.workTask.findMany({
    where: { projectId: scope.projectId, id: { in: adjustment.changes.map((c) => c.taskId) } },
    select: { id: true, version: true },
  });
  const versions = new Map(tasks.map((t) => [t.id, t.version]));
  if (adjustment.changes.some((c) => versions.get(c.taskId) !== c.expectedVersion))
    throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  return { proposal, adjustment };
}

/** `work.tasks.bulk_update`: an owner or editor applies the analyst's changes once. */
export const bulkUpdateAction: ActionDefinition<BulkPayload> = {
  riskClass: "W0_internal",
  approvalMode: "approval_required",
  deciderRole: "editor",
  inbox: "editors",
  policyRequired: false,
  ttlMs: 3 * 24 * 3600000,
  payload: bulkPayload,
  costCeilingMicros: () => 0,
  summary: (p) => ({ operation: { kind: "bulk_update", initiative: p.initiativeTitle, tasks: p.tasks } }),
  async revalidate(tx, scope, p) {
    await stillCurrent(tx, scope, p);
  },
  async onApproved(tx, scope, row) {
    const p = bulkPayload.parse(data(row).payload);
    const { proposal, adjustment } = await stillCurrent(tx, scope, p);
    for (const change of adjustment.changes)
      await updateTask(tx, scope, change.taskId, { expectedVersion: change.expectedVersion, ...change.set }, pmActor);
    const taskIds = adjustment.changes.map((c) => c.taskId);
    await tx.workPlanProposal.update({
      where: { id: proposal.id },
      data: { status: "applied", appliedAt: new Date(), appliedTaskIds: taskIds, version: { increment: 1 } },
    });
    await audit(tx, scope, "work.pm.adjustment_applied", proposal.id, { tasks: taskIds.length });
    await update(tx, scope, row, {
      ...data(row),
      status: "consumed",
      executionResult: { tasks: taskIds.length },
      consumedBy: { executionId: row.id, consumedAt: new Date().toISOString() },
    });
  },
  async executionResult(_tx, _scope, row) {
    return data(row).executionResult ?? null;
  },
};

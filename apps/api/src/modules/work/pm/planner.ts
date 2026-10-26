import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { runStructured } from "../../../platform/agents/structured-run.ts";
import { requireSpendMandate } from "../../../platform/ai/spend-mandate.ts";
import { knowledgeSearchTool } from "../../../platform/knowledge/search-tool.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { can } from "../../../platform/tenancy/permissions.ts";
import {
  cancelActionRequest,
  createActionRequest,
} from "../../../platform/governance/action-requests.ts";
import { audit, DomainError } from "../../../shared.ts";
import { assignableIds, uuid } from "../common.ts";
import { pmActive, requirePm } from "../gate.ts";
import { notifyMembers } from "../../../platform/notifications/members.ts";
import { WORK_PM_USE } from "../permissions.ts";
import { workGetTask, workListInitiatives, workSearchTasks } from "../tools.ts";
import { assertPmBudget, PM_BUDGET_CATEGORY } from "./budget.ts";
import { planContext } from "./context.ts";
import { PLANNER_INSTRUCTIONS } from "./instructions.ts";
import { workPlanSchema, type WorkPlan } from "./plan-schema.ts";
import { validatePlan, type PlanValidation } from "./plan-validate.ts";
import { getPmState } from "./state.ts";

// Planning (ADR 0017, plan §2.4): a member asks for a plan; a background
// job runs one structured run, validates the answer deterministically and
// stores it as a proposal; a valid proposal gets one `work.plan.apply`
// request that an owner or editor decides. Editing makes a new revision
// and withdraws the previous request.

export const PM_QUEUE = "work_pm";
export const PLAN_APPLY = "work.plan.apply";
/** The PM's writes carry this origin; its monitor subscribes under the same name. */
export const PM_ORIGIN = "work.pm" as const;
export const pmActor = { kind: "agent" as const, id: PM_ORIGIN, origin: PM_ORIGIN };

const PLANNER_LIMITS = {
  maxModelCalls: 4,
  maxToolCalls: 8,
  maxWebSearches: 3,
  timeoutMs: 180_000,
  maxInputBytes: 120_000,
};

export const requestPlanInput = z
  .object({
    goal: z.string().trim().min(3).max(3000),
    constraints: z.string().trim().max(900).optional(),
    initiativeId: uuid.nullable().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export type ProposalRow = Awaited<ReturnType<DbTx["workPlanProposal"]["findFirstOrThrow"]>>;

/** sha256 of a plan's canonical JSON (keys in schema order, as parsed). */
export const planHash = (plan: WorkPlan) =>
  createHash("sha256").update(JSON.stringify(workPlanSchema.parse(plan))).digest("hex");

export function proposalView(row: ProposalRow) {
  return {
    id: row.id,
    initiativeId: row.initiativeId,
    kind: row.kind,
    status: row.status,
    requestText: row.requestText,
    requestedBy: row.requestedBy,
    requestedVia: row.requestedVia,
    revision: row.revision,
    supersedesId: row.supersedesId,
    plan: row.plan as WorkPlan | null,
    validation: row.validation as PlanValidation,
    planHash: row.planHash,
    actionRequestId: row.actionRequestId,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedTaskIds: row.appliedTaskIds,
    costMicros: Number(row.costMicros),
    errorCode: row.errorCode,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadProposal(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workPlanProposal.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

async function liveInitiative(tx: DbTx, scope: Scope, initiativeId: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: initiativeId },
    select: { id: true, archivedAt: true },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  if (row.archivedAt) throw new DomainError("WORK_INITIATIVE_ARCHIVED", 409);
  return row;
}

/**
 * Starts planning for a member with `work.pm.use`. A repeated request with
 * the same key (or the same goal and initiative on the same day) returns
 * the existing proposal. Fails before queuing when the PM cannot spend.
 */
export async function requestPlan(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  via: "ui" | "assistant" | "mcp",
  now = new Date(),
) {
  await requirePm(tx, scope);
  const input = requestPlanInput.parse(raw);
  const initiativeId = input.initiativeId ?? null;
  if (initiativeId) await liveInitiative(tx, scope, initiativeId);
  const text = input.constraints
    ? `${input.goal}\n\nConstraints:\n${input.constraints}`
    : input.goal;
  const key = `pm-plan:${scope.userId}:${
    input.idempotencyKey ??
    createHash("sha256")
      .update(`${now.toISOString().slice(0, 10)}\n${initiativeId ?? ""}\n${text}`)
      .digest("hex")
  }`;
  const existing = await tx.workPlanProposal.findFirst({
    where: { projectId: scope.projectId, idempotencyKey: key },
  });
  // The same request again after a failed run plans anew instead of
  // returning the failure (the new revision takes over the key).
  if (existing?.status === "failed")
    return { proposal: await retryPlan(tx, scope, existing.id, via, now), deduplicated: false };
  if (existing) return { proposal: existing, deduplicated: true };
  // Nothing is queued that could not spend: no mandate or no budget left.
  await requireSpendMandate(tx, scope);
  await assertPmBudget(tx, scope, 1, now);
  const proposal = await tx.workPlanProposal.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      initiativeId,
      kind: initiativeId ? "extension" : "new_plan",
      status: "queued",
      requestText: text,
      requestedBy: scope.userId,
      requestedVia: via,
      idempotencyKey: key,
    },
  });
  await enqueue(tx, scope, PM_QUEUE, proposal.id, `work_pm:plan:${proposal.id}`, now, {
    kind: "plan",
  });
  await audit(tx, scope, "work.pm.plan_requested", proposal.id, {
    kind: proposal.kind,
    via,
    initiativeId,
  });
  return { proposal, deduplicated: false };
}

/**
 * Runs a failed plan request again as a new revision with the same request
 * text: the failed revision is superseded and hands its idempotency key
 * to the new one, so a repeated retry finds the running revision instead
 * of starting a second. Spend mandate and the PM budget are checked as for
 * a new request; nothing of the failed run is reused.
 */
export async function retryPlan(
  tx: DbTx,
  scope: Scope,
  id: string,
  via: "ui" | "assistant" | "mcp" = "ui",
  now = new Date(),
) {
  await requirePm(tx, scope);
  // It spends the PM budget: only members who may ask the PM.
  if (!can(scope, WORK_PM_USE)) throw new DomainError("FORBIDDEN", 403);
  const failed = await loadProposal(tx, scope, id);
  if (failed.status !== "failed") throw new DomainError("WORK_PROPOSAL_NOT_FAILED", 409);
  if (failed.initiativeId) await liveInitiative(tx, scope, failed.initiativeId);
  await requireSpendMandate(tx, scope);
  await assertPmBudget(tx, scope, 1, now);
  await tx.workPlanProposal.update({
    where: { id: failed.id },
    data: { status: "superseded", idempotencyKey: null, version: { increment: 1 } },
  });
  const next = await tx.workPlanProposal.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      initiativeId: failed.initiativeId,
      kind: failed.kind,
      status: "queued",
      requestText: failed.requestText,
      requestedBy: scope.userId,
      requestedVia: via,
      revision: failed.revision + 1,
      supersedesId: failed.id,
      idempotencyKey: failed.idempotencyKey,
    },
  });
  await enqueue(tx, scope, PM_QUEUE, next.id, `work_pm:plan:${next.id}`, now, { kind: "plan" });
  await audit(tx, scope, "work.pm.plan_retried", next.id, {
    previousId: failed.id,
    previousError: failed.errorCode,
    via,
  });
  return next;
}

/** The member a PM job acts for, with their role in the module; null when they left. */
async function requesterScope(scope: Scope, userId: string) {
  const member = await actorScope(scope.workspaceId, scope.projectId, userId);
  if (!member) return null;
  try {
    return moduleScope(member, "work");
  } catch {
    return null;
  }
}

/** The read tools of a planning run; knowledge only when research is not off. */
function plannerTools(research: string, runKey: string) {
  return [
    workSearchTasks,
    workGetTask,
    workListInitiatives,
    ...(research === "off"
      ? []
      : [
          knowledgeSearchTool({
            budget: (context) => ({
              retrievalJobKey: `${runKey}:knowledge:${context.callIndex}`,
              budgetRunKey: runKey,
            }),
            consumer: "work",
          }),
        ]),
  ];
}

async function fail(tx: DbTx, scope: Scope, id: string, code: string, extra: object = {}) {
  await tx.workPlanProposal.update({
    where: { id },
    data: { status: "failed", errorCode: code, version: { increment: 1 }, ...extra },
  });
  await audit(tx, scope, "work.pm.plan_failed", id, { code });
}

/** Creates the apply request of a valid proposal; returns its id. */
async function proposeApply(
  tx: DbTx,
  scope: Scope,
  proposal: ProposalRow,
  plan: WorkPlan,
  hash: string,
  requestedBy: { kind: "user"; userId: string } | { kind: "agent"; userId: string; agentRunId: string | null },
) {
  const request = await createActionRequest(tx, scope, {
    actionType: PLAN_APPLY,
    payload: {
      proposalId: proposal.id,
      planHash: hash,
      revision: proposal.revision,
      actorId: requestedBy.userId,
      kind: proposal.kind,
      initiativeTitle: plan.initiative.title,
      milestones: plan.milestones.length,
      tasks: plan.tasks.length,
    },
    requestedBy,
  });
  return request.id;
}

/** Stores a validated plan on a proposal: invalid, or proposed with its apply request. */
async function storePlan(
  tx: DbTx,
  scope: Scope,
  proposal: ProposalRow,
  output: WorkPlan,
  requestedBy: Parameters<typeof proposeApply>[5],
  extra: { agentRunId?: string | null; costMicros?: number } = {},
) {
  const taken = await tx.workInitiative.findMany({
    where: { projectId: scope.projectId },
    select: { key: true },
  });
  const { plan, validation } = validatePlan(output, {
    assignable: await assignableIds(scope),
    takenKeys: proposal.kind === "new_plan" ? new Set(taken.map((t) => t.key)) : undefined,
  });
  const hash = planHash(plan);
  const valid = validation.errors.length === 0;
  const actionRequestId = valid
    ? await proposeApply(tx, scope, proposal, plan, hash, requestedBy)
    : null;
  const updated = await tx.workPlanProposal.update({
    where: { id: proposal.id },
    data: {
      status: valid ? "proposed" : "invalid",
      plan: plan as Prisma.InputJsonValue,
      validation: validation as Prisma.InputJsonValue,
      planHash: hash,
      actionRequestId,
      errorCode: valid ? null : "PLAN_INVALID",
      version: { increment: 1 },
      ...(extra.agentRunId !== undefined ? { agentRunId: extra.agentRunId } : {}),
      ...(extra.costMicros !== undefined ? { costMicros: BigInt(extra.costMicros) } : {}),
    },
  });
  await audit(tx, scope, valid ? "work.pm.plan_proposed" : "work.pm.plan_invalid", proposal.id, {
    revision: proposal.revision,
    tasks: plan.tasks.length,
    errors: validation.errors.length,
  });
  return updated;
}

/**
 * The `work_pm` job of one plan request. Runs once per proposal: the run's
 * calls reserve under the proposal's key, so a repeated attempt never sends
 * a call again and ends as unknown instead.
 */
export async function runPlanJob(workerScope: Scope, proposalId: string) {
  const prepared = await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const proposal = await loadProposal(tx, workerScope, proposalId);
    if (!["queued", "running"].includes(proposal.status)) return null;
    const scope = await requesterScope(workerScope, proposal.requestedBy);
    if (!scope || !can(scope, WORK_PM_USE)) {
      await fail(tx, workerScope, proposal.id, "WORK_PM_REQUESTER_GONE");
      return null;
    }
    if (!(await pmActive(tx, scope))) {
      await fail(tx, workerScope, proposal.id, "WORK_PM_DISABLED");
      return null;
    }
    const research = proposal.initiativeId
      ? (await getPmState(tx, scope, proposal.initiativeId)).settings.research
      : "knowledge";
    const context = await planContext(tx, scope, {
      text: proposal.requestText ?? "",
      initiativeId: proposal.initiativeId,
    });
    await tx.workPlanProposal.update({
      where: { id: proposal.id },
      data: { status: "running", version: { increment: 1 } },
    });
    return { proposal, scope, context, research };
  });
  if (!prepared) return;
  const { proposal, scope, context, research } = prepared;
  const runKey = `work_pm:plan:${proposal.id}`;
  const result = await runStructured(scope, {
    agentName: "work.pm_planner",
    taskClass: "pm_plan",
    kind: "work_pm",
    subject: { type: "work.plan_proposal", id: proposal.id },
    instructions: PLANNER_INSTRUCTIONS.text,
    input: context,
    tools: plannerTools(research, runKey),
    webSearch: research === "web",
    outputSchema: workPlanSchema,
    limits: { ...PLANNER_LIMITS, maxWebSearches: research === "web" ? PLANNER_LIMITS.maxWebSearches : 0 },
    budget: {
      category: PM_BUDGET_CATEGORY,
      runKey,
      callKey: runKey,
      check: (tx, s, estimate, now) => assertPmBudget(tx, s, estimate, now),
    },
    async guard(tx, s) {
      await requirePm(tx, s);
      const current = await loadProposal(tx, s, proposal.id);
      if (current.status !== "running") throw new DomainError("WORK_PM_RUN_CANCELED", 409);
    },
  });
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await loadProposal(tx, scope, proposal.id);
    if (current.status !== "running") return;
    if (result.status !== "ok") {
      await fail(tx, scope, proposal.id, result.code, {
        agentRunId: result.agentRunId,
        costMicros: BigInt(result.costMicros),
      });
      return;
    }
    const stored = await storePlan(
      tx,
      scope,
      current,
      result.output,
      { kind: "agent", userId: scope.userId, agentRunId: result.agentRunId },
      { agentRunId: result.agentRunId, costMicros: result.costMicros },
    );
    await notifyMembers(tx, scope, {
      kind: "work_pm_plan_ready",
      userIds: [scope.userId],
      title: stored.status === "proposed" ? "Plan ready for review" : "Plan needs changes",
      body: "",
      link: `/p/${scope.projectId}/work/initiatives?plan=${stored.id}`,
    });
  });
}

/**
 * Saves an edited plan as a new revision of a draft, proposed or invalid
 * proposal; the previous revision's request is withdrawn.
 */
export async function revisePlan(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  await requirePm(tx, scope);
  const input = z
    .object({ expectedVersion: z.int().min(1), plan: workPlanSchema })
    .strict()
    .parse(raw);
  const previous = await loadProposal(tx, scope, id);
  if (!["draft", "proposed", "invalid"].includes(previous.status))
    throw new DomainError("WORK_PROPOSAL_CLOSED", 409);
  if (previous.version !== input.expectedVersion)
    throw new DomainError("WORK_VERSION_CONFLICT", 409);
  if (previous.initiativeId) await liveInitiative(tx, scope, previous.initiativeId);
  if (previous.actionRequestId)
    await cancelActionRequest(tx, scope, previous.actionRequestId, "WORK_PLAN_REVISED", {
      pendingOnly: true,
    });
  await tx.workPlanProposal.update({
    where: { id: previous.id },
    data: { status: "superseded", version: { increment: 1 } },
  });
  const next = await tx.workPlanProposal.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      initiativeId: previous.initiativeId,
      kind: previous.kind,
      status: "draft",
      requestText: previous.requestText,
      requestedBy: scope.userId,
      requestedVia: "ui",
      revision: previous.revision + 1,
      supersedesId: previous.id,
    },
  });
  return storePlan(tx, scope, next, input.plan, { kind: "user", userId: scope.userId });
}

/** Discards an open proposal and withdraws its request. */
export async function discardPlan(tx: DbTx, scope: Scope, id: string) {
  const proposal = await loadProposal(tx, scope, id);
  if (["applied", "superseded", "rejected"].includes(proposal.status))
    throw new DomainError("WORK_PROPOSAL_CLOSED", 409);
  if (proposal.actionRequestId)
    await cancelActionRequest(tx, scope, proposal.actionRequestId, "WORK_PLAN_DISCARDED", {
      pendingOnly: true,
    });
  const row = await tx.workPlanProposal.update({
    where: { id: proposal.id },
    data: { status: "rejected", version: { increment: 1 } },
  });
  await audit(tx, scope, "work.pm.plan_discarded", proposal.id, { revision: proposal.revision });
  return row;
}

export async function listProposals(
  tx: DbTx,
  scope: Scope,
  filter: { initiativeId?: string; open?: boolean },
) {
  const rows = await tx.workPlanProposal.findMany({
    where: {
      projectId: scope.projectId,
      ...(filter.initiativeId ? { initiativeId: filter.initiativeId } : {}),
      ...(filter.open
        ? { status: { in: ["queued", "running", "draft", "proposed", "invalid"] } }
        : { status: { not: "superseded" } }),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(proposalView);
}

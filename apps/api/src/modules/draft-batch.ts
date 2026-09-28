import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, list, update } from "../shared.ts";
import { activePolicy } from "./policy.ts";
import { assertMissionAssets } from "./asset-tools.ts";
import { enqueue } from "./workflow.ts";

/**
 * Owner-approved batch of paid internal drafts for one confirmed Chat
 * mission. Runs are strictly sequential: each successful run queues the next
 * single-attempt job in the same transaction as its Content, and any failure
 * stops the batch until an owner resumes it without a charged attempt.
 */
export const MAX_BATCH_DRAFTS = 5;

export function batchJobKey(missionId: string, run: number, suffix = "") {
  return `mission:${missionId}:batch:${run}${suffix ? ":" + suffix : ""}`;
}

async function assertSafeOwnerDraftContext(tx: DbTx, scope: Scope) {
  if (scope.role !== "owner") throw new DomainError("FORBIDDEN", 403);
  if (
    process.env.EXECUTION_MODE !== "test" ||
    process.env.ENABLE_EXTERNAL_WRITES !== "false"
  )
    throw new DomainError("SAFE_DRAFT_MODE_REQUIRED", 409);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused || project.mode !== "observe")
    throw new DomainError("OBSERVE_PROJECT_REQUIRED", 409);
}

async function lockedMission(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  expectedVersion: number,
) {
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${missionId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const mission = await entity(tx, scope, "missions", missionId);
  if (mission.version !== expectedVersion)
    throw new DomainError("VERSION_CONFLICT", 409);
  return mission;
}

async function paidPolicy(
  tx: DbTx,
  scope: Scope,
  m: Record<string, any>,
  now: Date,
) {
  const policy = await activePolicy(tx, scope);
  if (!policy) throw new DomainError("PAID_MANDATE_REQUIRED", 409);
  const p = data(policy);
  if (
    !p.approvedPaidTests ||
    !p.perRunBudgetMicros ||
    p.perRunBudgetMicros > 10_000_000 ||
    now < new Date(p.startAt) ||
    now >= new Date(p.endAt) ||
    !p.dailyBudgetMicros ||
    !p.monthlyBudgetMicros ||
    !m.channels.every((channel: string) => p.channels?.includes(channel)) ||
    !p.contentTypes?.includes(m.contentType)
  )
    throw new DomainError("PAID_MANDATE_REQUIRED", 409);
  return p;
}

async function assertBudgetHeadroom(
  tx: DbTx,
  scope: Scope,
  p: Record<string, any>,
  amount: number,
  now: Date,
) {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const rows = await tx.budgetReservation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: month },
      state: { not: "released" },
    },
  });
  const cost = (r: (typeof rows)[number]) =>
    Number(r.state === "settled" ? r.settledMicros : r.amountMicros);
  const monthly = rows.reduce((n, r) => n + cost(r), 0);
  const daily = rows
    .filter((r) => r.createdAt >= day)
    .reduce((n, r) => n + cost(r), 0);
  if (
    monthly + amount > p.monthlyBudgetMicros ||
    daily + amount > p.dailyBudgetMicros
  )
    throw new DomainError("BUDGET_EXCEEDED", 409);
}

async function batchJobs(tx: DbTx, scope: Scope, missionId: string) {
  return (await list(tx, scope, "jobs")).filter(
    (job) =>
      data(job).topic === "generation" &&
      data(job).resourceId === missionId &&
      Number.isInteger(data(job).batchRun),
  );
}

/** Reserved or settled spend of all batch jobs of a mission, including retrieval. */
export async function batchCostUsedMicros(
  tx: DbTx,
  scope: Scope,
  missionId: string,
) {
  const keys = (await batchJobs(tx, scope, missionId)).flatMap((job) => [
    scope.projectId + ":" + job.id,
    scope.projectId + ":query:mission:" + job.id,
  ]);
  if (!keys.length) return 0;
  const rows = await tx.budgetReservation.findMany({
    where: {
      projectId: scope.projectId,
      key: { in: keys },
      state: { not: "released" },
    },
  });
  return rows.reduce(
    (n, r) =>
      n + Number(r.state === "settled" ? r.settledMicros : r.amountMicros),
    0,
  );
}

async function markSingleAttempt(
  tx: DbTx,
  scope: Scope,
  job: Awaited<ReturnType<typeof enqueue>>,
  fields: Record<string, unknown>,
) {
  return update(tx, scope, job, {
    ...data(job),
    maxAttempts: 1,
    liveDraftOnce: true,
    ...fields,
  });
}

export async function startApprovedLiveDraftBatch(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  expectedVersion: number,
) {
  await assertSafeOwnerDraftContext(tx, scope);
  const mission = await lockedMission(tx, scope, missionId, expectedVersion);
  const m = data(mission);
  if (
    !Number.isInteger(m.maxContents) ||
    m.maxContents < 2 ||
    m.maxContents > MAX_BATCH_DRAFTS
  )
    throw new DomainError("BATCH_SIZE_NOT_ALLOWED", 409);
  if (
    m.status !== "ready" ||
    m.batch ||
    (m.completedRuns ?? 0) !== 0 ||
    typeof m.chatProposalId !== "string" ||
    !Number.isSafeInteger(m.chatCostCeilingMicros) ||
    m.chatCostCeilingMicros <= 0 ||
    !Array.isArray(m.allowedActions) ||
    m.allowedActions.length !== 1 ||
    m.allowedActions[0] !== "draft"
  )
    throw new DomainError("MISSION_NOT_READY", 409);
  const now = new Date();
  if (new Date(m.endAt) <= now) throw new DomainError("MISSION_EXPIRED", 409);
  if (new Date(m.startAt) <= now)
    throw new DomainError("MISSION_ALREADY_ACTIVE", 409);
  await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
  const proposals = await tx.chatProposal.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      userId: scope.userId,
      missionId,
      status: "confirmed",
    },
  });
  if (proposals.length !== 1 || !proposals[0]?.jobId)
    throw new DomainError("CONFIRMED_PROPOSAL_REQUIRED", 409);
  const job = await entity(tx, scope, "jobs", proposals[0].jobId);
  const j = data(job);
  if (
    j.topic !== "generation" ||
    j.resourceId !== missionId ||
    j.actorId !== scope.userId ||
    j.status !== "queued" ||
    j.attempts !== 0 ||
    j.liveDraftOnce
  )
    throw new DomainError("JOB_NOT_QUEUED", 409);
  const events = await tx.outbox.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      topic: "generation",
      entityId: job.id,
      dispatchedAt: null,
    },
  });
  if (events.length !== 1) throw new DomainError("OUTBOX_NOT_UNIQUE", 409);
  const existingContent = await tx.entity.count({
    where: {
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["missionId"], equals: missionId },
    },
  });
  if (existingContent) throw new DomainError("MISSION_CONTENT_QUOTA", 409);
  if (
    await tx.budgetReservation.findFirst({
      where: {
        projectId: scope.projectId,
        key: scope.projectId + ":" + job.id,
      },
    })
  )
    throw new DomainError("RESERVATION_ALREADY_USED", 409);
  const p = await paidPolicy(tx, scope, m, now);
  if (m.chatCostCeilingMicros > p.perRunBudgetMicros)
    throw new DomainError("PAID_MANDATE_REQUIRED", 409);
  const costCeilingMicros = m.maxContents * m.chatCostCeilingMicros;
  await assertBudgetHeadroom(tx, scope, p, costCeilingMicros, now);
  await assertMissionAssets(tx, scope, m.assetIds ?? []);
  const updatedMission = await update(tx, scope, mission, {
    ...m,
    startAt: now.toISOString(),
    batch: {
      status: "running",
      size: m.maxContents,
      perDraftCeilingMicros: m.chatCostCeilingMicros,
      costCeilingMicros,
      approvedBy: scope.userId,
      approvedAt: now.toISOString(),
    },
  });
  await markSingleAttempt(tx, scope, job, {
    batchRun: 1,
    approvedBy: scope.userId,
    availableAt: now.toISOString(),
  });
  await tx.outbox.update({
    where: { id: events[0]!.id },
    data: { availableAt: now },
  });
  await audit(tx, scope, "mission.live_draft_batch_approved", missionId, {
    jobId: job.id,
    missionVersion: updatedMission.version,
    size: m.maxContents,
    costCeilingMicros,
  });
  return {
    missionId,
    jobId: job.id,
    size: m.maxContents,
    costCeilingMicros,
    startAt: now.toISOString(),
  };
}

/**
 * Queue the next sequential run after a successful batch run. Called in the
 * same transaction that stores the run's Content and finishes the mission run.
 */
export async function enqueueNextBatchRun(
  tx: DbTx,
  scope: Scope,
  mission: { id: string; data: unknown },
  finishedJobId: string,
) {
  const m = data(mission as any);
  if (m.batch?.status !== "running" || (m.completedRuns ?? 0) >= m.maxContents)
    return null;
  const finished = await tx.entity.findFirst({
    where: { id: finishedJobId, projectId: scope.projectId, kind: "jobs" },
  });
  if (!finished || !Number.isInteger(data(finished).batchRun)) return null;
  const run = (m.completedRuns ?? 0) + 1;
  const next = await enqueue(
    tx,
    scope,
    "generation",
    mission.id,
    batchJobKey(mission.id, run),
  );
  return markSingleAttempt(tx, scope, next, {
    batchRun: run,
    approvedBy: m.batch.approvedBy,
  });
}

/** Resume a stopped batch only when its failed run left no charge and no Content. */
export async function resumeLiveDraftBatch(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  expectedVersion: number,
) {
  await assertSafeOwnerDraftContext(tx, scope);
  const mission = await lockedMission(tx, scope, missionId, expectedVersion);
  const m = data(mission);
  const now = new Date();
  if (
    m.batch?.status !== "running" ||
    m.status !== "ready" ||
    (m.completedRuns ?? 0) >= m.maxContents
  )
    throw new DomainError("BATCH_NOT_RESUMABLE", 409);
  if (new Date(m.endAt) <= now) throw new DomainError("MISSION_EXPIRED", 409);
  const jobs = await batchJobs(tx, scope, missionId);
  if (
    jobs.some((job) =>
      ["queued", "running", "retry_scheduled"].includes(data(job).status),
    )
  )
    throw new DomainError("BATCH_RUN_IN_PROGRESS", 409);
  const run = (m.completedRuns ?? 0) + 1;
  const failed = jobs
    .filter((job) => data(job).batchRun === run)
    .sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf())[0];
  if (!failed || data(failed).status !== "blocked_dependency")
    throw new DomainError("BATCH_NOT_RESUMABLE", 409);
  const content = await tx.entity.count({
    where: {
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["jobId"], equals: failed.id },
    },
  });
  if (content) throw new DomainError("MISSION_CONTENT_QUOTA", 409);
  if (
    await tx.budgetReservation.findFirst({
      where: {
        projectId: scope.projectId,
        key: scope.projectId + ":" + failed.id,
      },
    })
  )
    throw new DomainError("RESERVATION_ALREADY_USED", 409);
  const p = await paidPolicy(tx, scope, m, now);
  const used = await batchCostUsedMicros(tx, scope, missionId);
  if (used + m.batch.perDraftCeilingMicros > m.batch.costCeilingMicros)
    throw new DomainError("BATCH_BUDGET_EXHAUSTED", 409);
  await assertBudgetHeadroom(tx, scope, p, m.batch.perDraftCeilingMicros, now);
  await assertMissionAssets(tx, scope, m.assetIds ?? []);
  const next = await enqueue(
    tx,
    scope,
    "generation",
    missionId,
    batchJobKey(missionId, run, "resume:" + failed.id),
    now,
  );
  await markSingleAttempt(tx, scope, next, {
    batchRun: run,
    approvedBy: scope.userId,
    resumeOfJobId: failed.id,
  });
  await audit(tx, scope, "mission.live_draft_batch_resumed", missionId, {
    jobId: next.id,
    blockedJobId: failed.id,
    run,
  });
  return { missionId, jobId: next.id, run, blockedJobId: failed.id };
}

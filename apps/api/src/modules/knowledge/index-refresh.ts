import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  activateIndexGeneration,
  beginIndexBuild,
  currentIndexCorpus,
  getActiveIndex,
  KnowledgeError,
  validateActiveIndexEvaluation,
} from "../../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { requireSpendMandate } from "../../platform/ai/spend-mandate.ts";
import {
  queueEvaluationSet,
  startEvaluationSet,
} from "../../platform/knowledge/evaluation-set.ts";
import {
  INDEX_REFRESH_RUNS,
  refreshRunWhere,
  requireRefreshOwner,
} from "../../platform/knowledge/index-refresh-authority.ts";
import type { SchedulerContribution } from "../../platform/jobs/types.ts";
import { create, data, DomainError, entity, update } from "../../shared.ts";
import { queueIndexBuild } from "./evaluation-tools.ts";

const INDEX_REFRESH_SETTINGS = "knowledge_index_refresh_settings";
const CHECK_INTERVAL_MS = 60_000;
const AUTO_COOLDOWN_MS = 15 * CHECK_INTERVAL_MS;
const AUTO_START_DELAY_MS = 2 * CHECK_INTERVAL_MS;
const RUN_DEADLINE_MS = 60 * CHECK_INTERVAL_MS;
const PENDING_JOB = ["queued", "running", "retry_scheduled"];

const consent = z.object({ confirmPaidProviderUse: z.literal(true) }).strict();
const automationInput = z.discriminatedUnion("enabled", [
  consent.extend({ enabled: z.literal(true) }),
  z.object({ enabled: z.literal(false) }).strict(),
]);

async function settings(tx: DbTx, s: Scope) {
  return tx.entity.findFirst({
    where: {
      projectId: s.projectId,
      workspaceId: s.workspaceId,
      kind: INDEX_REFRESH_SETTINGS,
    },
  });
}

async function latestRun(tx: DbTx, s: Scope) {
  return tx.entity.findFirst({
    where: refreshRunWhere(s),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function indexRefreshStatus(tx: DbTx, s: Scope) {
  const config = await settings(tx, s);
  const run = await latestRun(tx, s);
  return {
    autoEnabled: data(config).enabled === true,
    run: run
      ? {
          indexId: String(data(run).indexId),
          status: String(data(run).status),
          stage: String(data(run).stage),
          errorCode: (data(run).errorCode ?? null) as string | null,
        }
      : null,
  };
}

async function assertPaidRefresh(tx: DbTx, s: Scope, at: Date) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: s.projectId },
    select: { paused: true },
  });
  if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
  const { limits } = await requireSpendMandate(tx, s);
  if (
    !limits.approvedPaidTests ||
    limits.perRunBudgetMicros <= 0 ||
    limits.dailyBudgetMicros <= 0 ||
    limits.monthlyBudgetMicros <= 0 ||
    at.getTime() < Date.parse(limits.startAt) ||
    at.getTime() >= Date.parse(limits.endAt)
  )
    throw new DomainError("PAID_MANDATE_REQUIRED", 409);
}

export async function setIndexRefreshAutomation(
  tx: DbTx,
  s: Scope,
  raw: unknown,
) {
  const input = automationInput.parse(raw);
  if (input.enabled) await assertPaidRefresh(tx, s, new Date());
  const row = await settings(tx, s);
  const value = {
    enabled: input.enabled,
    ownerId: s.userId,
    consentedAt: input.enabled ? new Date().toISOString() : null,
  };
  if (row) await update(tx, s, row, value);
  else await create(tx, s, INDEX_REFRESH_SETTINGS, value);
  return { enabled: input.enabled };
}

async function beginRefresh(tx: DbTx, s: Scope, at: Date) {
  await assertPaidRefresh(tx, s, at);
  // With at most three questions per passage, fewer than 16 cannot pass.
  if ((await currentIndexCorpus(tx, s)).chunks < 16)
    throw new DomainError("EVALUATION_SET_TOO_SMALL", 409);
  const active = await getActiveIndex(tx, s);
  const index = await beginIndexBuild(tx, s, active.profile);
  await queueIndexBuild(tx, s, index.id);
  return create(tx, s, INDEX_REFRESH_RUNS, {
    ownerId: s.userId,
    previousIndexId: active.id,
    indexId: index.id,
    corpusHash: index.manifestHash,
    status: "running",
    stage: "embedding",
    evaluationId: null,
  });
}

export async function startIndexRefresh(tx: DbTx, s: Scope, raw: unknown) {
  consent.parse(raw);
  const previous = await latestRun(tx, s);
  if (previous && data(previous).status === "running")
    return { indexId: data(previous).indexId, status: "running" };
  if ((await validateActiveIndexEvaluation(tx, s)).valid)
    return { status: "current" };
  const run = await beginRefresh(tx, s, new Date());
  return { indexId: data(run).indexId, status: "running" };
}

const knownCode = (error: unknown) => {
  if (error instanceof DomainError || error instanceof KnowledgeError)
    return error.code;
  throw error;
};

async function stageJob(tx: DbTx, s: Scope, resourceId: string, topic: string) {
  return tx.entity.findFirst({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      kind: "jobs",
      AND: [
        { data: { path: ["topic"], equals: topic } },
        { data: { path: ["resourceId"], equals: resourceId } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

async function advance(
  tx: DbTx,
  s: Scope,
  run: NonNullable<Awaited<ReturnType<typeof latestRun>>>,
  at: Date,
) {
  const current = data(run);
  const save = (changes: Record<string, unknown>) =>
    update(tx, s, run, { ...current, ...changes });
  const fail = (errorCode: string) => save({ status: "failed", errorCode });
  if (at.getTime() - run.createdAt.getTime() >= RUN_DEADLINE_MS) {
    await fail("INDEX_REFRESH_TIMEOUT");
    return;
  }
  try {
    const owner = await requireRefreshOwner(tx, s, current.ownerId);
    const active = await getActiveIndex(tx, s);
    if (active.id !== current.previousIndexId)
      throw new DomainError("INDEX_REFRESH_ACTIVE_CHANGED");
    const index = await tx.knowledgeIndex.findFirstOrThrow({
      where: {
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        id: current.indexId,
      },
    });
    if (index.manifestHash !== (await currentIndexCorpus(tx, s)).hash)
      throw new DomainError("INDEX_CORPUS_CHANGED");

    if (current.stage === "embedding") {
      const job = await stageJob(tx, s, index.id, "reindex");
      if (job && PENDING_JOB.includes(data(job).status)) return;
      if (!job || data(job).status !== "succeeded")
        throw new DomainError(data(job).error ?? "INDEX_REFRESH_BUILD_FAILED");
      await assertPaidRefresh(tx, owner, at);
      const evaluation = await queueEvaluationSet(tx, owner, index.id);
      await save({ stage: "questions", evaluationId: evaluation.id });
      return;
    }

    const evaluation = await entity(
      tx,
      s,
      "index_evaluations",
      current.evaluationId,
    );
    const result = data(evaluation);
    if (result.status === "failed")
      throw new DomainError(
        result.errorCode ?? "INDEX_REFRESH_EVALUATION_FAILED",
      );
    if (current.stage === "questions" && result.status === "review") {
      await assertPaidRefresh(tx, owner, at);
      await startEvaluationSet(tx, owner, {
        evaluationId: evaluation.id,
        confirmQueriesMayBeSentToOpenAI: true,
      });
      await save({ stage: "evaluation" });
      return;
    }
    if (result.status === "completed") {
      const indexEvaluation = index.evaluation as {
        datasetVersion?: string;
      } | null;
      if (
        current.stage !== "evaluation" ||
        result.evaluation?.passed !== true ||
        result.evaluation?.provenance !== "live" ||
        index.state !== "evaluated" ||
        indexEvaluation?.datasetVersion !== result.datasetVersion
      )
        throw new DomainError("INDEX_REFRESH_CHECK_NOT_PASSED");
      await activateIndexGeneration(tx, owner, index.id);
      await save({ status: "completed" });
      return;
    }
    const job = await stageJob(
      tx,
      s,
      evaluation.id,
      result.status === "generating"
        ? "index_evaluation_set"
        : "index_evaluation",
    );
    if (
      job &&
      !PENDING_JOB.includes(data(job).status) &&
      data(job).status !== "succeeded"
    )
      throw new DomainError(
        data(job).error ?? "INDEX_REFRESH_EVALUATION_FAILED",
      );
  } catch (error) {
    await fail(knownCode(error));
  }
}

export const indexRefreshScheduler: SchedulerContribution = {
  async sweep(tx, s, at) {
    const run = await latestRun(tx, s);
    if (run && data(run).status === "running") {
      await advance(tx, s, run, at);
      return { queued: 0 };
    }
    const config = await settings(tx, s);
    if (
      !config ||
      data(config).enabled !== true ||
      at.getTime() - config.updatedAt.getTime() < AUTO_START_DELAY_MS ||
      (run && at.getTime() - run.createdAt.getTime() < AUTO_COOLDOWN_MS)
    )
      return { queued: 0 };
    const live = await validateActiveIndexEvaluation(tx, s, at);
    if (live.valid) return { queued: 0 };
    const corpus = await currentIndexCorpus(tx, s);
    // At most three generated questions per passage and at least 48 required.
    if (
      corpus.chunks < 16 ||
      (run &&
        data(run).status === "failed" &&
        data(run).previousIndexId === live.indexId &&
        data(run).corpusHash === corpus.hash)
    )
      return { queued: 0 };
    try {
      const owner = await requireRefreshOwner(tx, s, data(config).ownerId);
      await beginRefresh(tx, owner, at);
      return { queued: 1 };
    } catch (error) {
      knownCode(error);
      return { queued: 0 };
    }
  },
  async nextDueAt(tx, s, at) {
    const [config, run] = await Promise.all([
      settings(tx, s),
      latestRun(tx, s),
    ]);
    if (
      data(config).enabled !== true &&
      (!run || data(run).status !== "running")
    )
      return null;
    return new Date(at.getTime() + CHECK_INTERVAL_MS);
  },
};

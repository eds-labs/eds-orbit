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
import { isolated } from "../../platform/knowledge/release-impact.ts";
import {
  knowledgeOperationsSettings,
  lockKnowledge,
  recordKnowledgeIssue,
  resolveKnowledgeIssue,
  sweepKnowledgeSources,
  sweepKnowledgeRecoveries,
} from "./operations.ts";
import { githubRefreshScheduler } from "./github-refresh.ts";

const INDEX_REFRESH_SETTINGS = "knowledge_index_refresh_settings";
const CHECK_INTERVAL_MS = 60_000;
const AUTO_COOLDOWN_MS = 15 * CHECK_INTERVAL_MS;
const AUTO_START_DELAY_MS = 2 * CHECK_INTERVAL_MS;
const CORPUS_SETTLE_MS = 5 * CHECK_INTERVAL_MS;
const RETRY_DELAYS = [5 * CHECK_INTERVAL_MS, 15 * CHECK_INTERVAL_MS];
const SAFE_RETRY_CODES = new Set([
  "INDEX_RATE_LIMIT_RETRY_REQUIRED",
  "PROVIDER_UNAVAILABLE_BEFORE_SEND",
]);
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
    nextAttemptAt: (data(run).status === "waiting_retry"
      ? data(run).retryAt
      : data(config).nextAttemptAt) as string | undefined,
    lastSuccessAt: data(config).lastSuccessAt as string | undefined,
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
  await lockKnowledge(tx, s);
  if (input.enabled) await assertPaidRefresh(tx, s, new Date());
  const row = await settings(tx, s);
  const value = {
    ...data(row),
    nextAttemptAt: null,
    enabled: input.enabled,
    ownerId: s.userId,
    consentedAt: input.enabled ? new Date().toISOString() : null,
  };
  if (row) await update(tx, s, row, value);
  else await create(tx, s, INDEX_REFRESH_SETTINGS, value);
  return { enabled: input.enabled };
}

async function beginRefresh(tx: DbTx, s: Scope, at: Date, attempt = 1) {
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
    attempt,
  });
}

export async function startIndexRefresh(tx: DbTx, s: Scope, raw: unknown) {
  consent.parse(raw);
  await lockKnowledge(tx, s);
  const previous = await latestRun(tx, s);
  if (previous && data(previous).status === "running")
    return { indexId: data(previous).indexId, status: "running" };
  if ((await validateActiveIndexEvaluation(tx, s)).valid)
    return { status: "current" };
  if (previous && (await hasUnreconciledIndexSpend(tx, s, data(previous)))) {
    throw new DomainError("INDEX_REFRESH_RECONCILIATION_REQUIRED", 409);
  }
  const run = await beginRefresh(tx, s, new Date());
  return { indexId: data(run).indexId, status: "running" };
}

async function hasUnreconciledIndexSpend(
  tx: DbTx,
  s: Scope,
  previous: Record<string, any>,
) {
  if (!previous.indexId) return false;
  return !!(await tx.budgetReservation.findFirst({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      state: { in: ["unknown", "in_flight"] },
      OR: [
        { key: { startsWith: `${s.projectId}:index:${previous.indexId}:` } },
        ...(previous.evaluationId
          ? [
              {
                key: {
                  contains: `knowledge_evaluation:${previous.evaluationId}`,
                },
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  }));
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
  const fail = async (errorCode: string) => {
    const improved = (await knowledgeOperationsSettings(tx, s)).automation;
    const superseded =
      improved &&
      ["INDEX_CORPUS_CHANGED", "INDEX_REFRESH_ACTIVE_CHANGED"].includes(
        errorCode,
      );
    const retry =
      improved &&
      SAFE_RETRY_CODES.has(errorCode) &&
      Number(current.attempt ?? 1) <= RETRY_DELAYS.length;
    const retryAt = retry
      ? new Date(
          at.getTime() + RETRY_DELAYS[Number(current.attempt ?? 1) - 1]!,
        ).toISOString()
      : null;
    await save({
      status: superseded ? "superseded" : retry ? "waiting_retry" : "failed",
      errorCode,
      retryAt,
    });
    if (!superseded && !retry)
      await recordKnowledgeIssue(tx, s, "index", s.projectId, errorCode, at);
  };
  if (at.getTime() - run.createdAt.getTime() >= RUN_DEADLINE_MS) {
    await fail("INDEX_REFRESH_TIMEOUT");
    return;
  }
  try {
    await isolated(tx, "knowledge_index_advance", async () => {
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
          throw new DomainError(
            data(job).error ?? "INDEX_REFRESH_BUILD_FAILED",
          );
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
      if (["failed", "unknown"].includes(result.status))
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
        const config = await settings(tx, s);
        if (config)
          await update(tx, s, config, {
            ...data(config),
            lastSuccessAt: at.toISOString(),
            nextAttemptAt: null,
            pendingHash: null,
          });
        await resolveKnowledgeIssue(tx, s, "index", s.projectId, at);
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
    });
  } catch (error) {
    await fail(knownCode(error));
  }
}

async function sweepIndex(tx: DbTx, s: Scope, at: Date) {
  const run = await latestRun(tx, s);
  const previous = data(run);
  if (run && previous.status === "running") {
    return advance(tx, s, run, at);
  }
  const config = await settings(tx, s);
  const operations = await knowledgeOperationsSettings(tx, s);
  if (!config && !operations.monitoring) return;
  const active = await tx.knowledgeIndex.findFirst({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      state: "active",
    },
    select: { id: true },
  });
  if (!active && data(config).enabled !== true) return;

  let live: Awaited<ReturnType<typeof validateActiveIndexEvaluation>>;
  try {
    live = await validateActiveIndexEvaluation(tx, s, at);
  } catch (error) {
    if (!(error instanceof KnowledgeError) || error.code !== "NO_ACTIVE_EMBEDDING_INDEX")
      throw error;
    await recordKnowledgeIssue(tx, s, "index", s.projectId, error.code, at);
    return;
  }
  if (live.valid) {
    await resolveKnowledgeIssue(tx, s, "index", s.projectId, at);
    if (config && data(config).nextAttemptAt)
      await update(tx, s, config, {
        ...data(config),
        pendingHash: null,
        nextAttemptAt: null,
      });
    return;
  }
  if (!config || data(config).enabled !== true) return;
  const configData = data(config);
  if (
    at.getTime() -
      Date.parse(configData.consentedAt ?? config.updatedAt.toISOString()) <
    AUTO_START_DELAY_MS
  )
    return;

  if (run && (await hasUnreconciledIndexSpend(tx, s, previous))) {
    await recordKnowledgeIssue(
      tx,
      s,
      "index",
      s.projectId,
      "INDEX_REFRESH_RECONCILIATION_REQUIRED",
      at,
    );
    return;
  }
  const corpus = await currentIndexCorpus(tx, s);
  if (corpus.chunks < 16) {
    await recordKnowledgeIssue(
      tx,
      s,
      "index",
      s.projectId,
      "EVALUATION_SET_TOO_SMALL",
      at,
    );
    return;
  }
  const sameCorpus =
    previous.previousIndexId === live.indexId &&
    previous.corpusHash === corpus.hash;
  if (sameCorpus && previous.status === "failed") {
    await recordKnowledgeIssue(
      tx,
      s,
      "index",
      s.projectId,
      previous.errorCode ?? "INDEX_REFRESH_FAILED",
      at,
    );
    return;
  }

  const retrying = sameCorpus && previous.status === "waiting_retry";
  if (operations.automation) {
    if (configData.pendingHash !== corpus.hash) {
      await update(tx, s, config, {
        ...configData,
        pendingHash: corpus.hash,
        nextAttemptAt: new Date(at.getTime() + CORPUS_SETTLE_MS).toISOString(),
      });
      return;
    }
    if (
      Date.parse(retrying ? previous.retryAt : configData.nextAttemptAt) >
      at.getTime()
    )
      return;
  } else if (
    run &&
    (retrying || at.getTime() - run.createdAt.getTime() < AUTO_COOLDOWN_MS)
  )
    return;

  try {
    await isolated(tx, "knowledge_index_start", async () => {
      const owner = await requireRefreshOwner(tx, s, configData.ownerId);
      await beginRefresh(
        tx,
        owner,
        at,
        retrying ? Number(previous.attempt ?? 1) + 1 : 1,
      );
    });
    return 1;
  } catch (error) {
    const code = knownCode(error);
    await recordKnowledgeIssue(tx, s, "index", s.projectId, code, at);
  }
}

export const indexRefreshScheduler: SchedulerContribution = {
  async sweep(tx, s, at) {
    await lockKnowledge(tx, s);
    const indexJobs = (await sweepIndex(tx, s, at)) ?? 0;
    await sweepKnowledgeSources(tx, s, at);
    await sweepKnowledgeRecoveries(tx, s);
    const githubJobs = await githubRefreshScheduler(tx, s, at);
    return { queued: indexJobs + githubJobs };
  },
  async nextDueAt(tx, s, at) {
    const [config, run, operations] = await Promise.all([
      settings(tx, s),
      latestRun(tx, s),
      knowledgeOperationsSettings(tx, s),
    ]);
    if (
      data(config).enabled !== true &&
      data(run).status !== "running" &&
      !operations.monitoring &&
      !operations.automation
    )
      return null;
    return new Date(at.getTime() + CHECK_INTERVAL_MS);
  },
};

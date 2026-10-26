import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  activateIndexGeneration,
  beginIndexBuild,
  describeIndexGenerations,
  EMBEDDING_PROFILES,
  evaluationChunksNotInIndex,
  getActiveIndex,
  validateActiveIndexEvaluation,
} from "../../../../../packages/knowledge/src/index.ts";
import { estimateCost } from "../../../../../packages/ai/src/index.ts";
import { data, DomainError, list } from "../../shared.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import {
  indexEvaluationRequest,
  queueIndexEvaluation,
} from "../../platform/knowledge/index-evaluation.ts";
import { knowledgeIndexStatus } from "../../platform/knowledge/index-status.ts";
import { runtimeOpenAiConfiguration } from "../../platform/ai/openai-configuration.ts";
import { requireSpendMandate } from "../../platform/ai/spend-mandate.ts";
import { projectAdministrationEnabled } from "../../platform/configuration/configuration.ts";
import {
  approvedOperation,
  readOperation,
} from "../../platform/tasks/operation-tools.ts";
import { PROJECT_OWN, PROJECT_READ } from "../../platform/tenancy/permissions.ts";

// Knowledge quality over MCP (docs/MCP_PROJECT_ADMINISTRATION.md): the
// official live RAG evaluation of the project's embedding index. Results
// are read freely; each paid or state-changing step (build, evaluate,
// activate) is an owner approval and runs through the same services as
// Orbit's knowledge settings. The release gate only opens for an index
// whose live evaluation passed with settled provider receipts.

/** Queues the paid embedding build of an index generation in `building`. */
export async function queueIndexBuild(tx: DbTx, scope: Scope, indexId: string) {
  const index = await tx.knowledgeIndex.findFirst({
    where: { id: indexId, projectId: scope.projectId },
  });
  if (!index || index.state !== "building")
    throw new DomainError("INDEX_NOT_BUILDING");
  const count = await tx.chunkEmbedding.count({
    where: {
      projectId: scope.projectId,
      profile: index.profile,
      indexGeneration: index.generation,
    },
  });
  return enqueue(tx, scope, "reindex", index.id, "reindex:" + index.id + ":" + count);
}

const summary = (e: Record<string, any> | null) =>
  e
    ? {
        passed: e.passed === true,
        provenance: e.provenance ?? null,
        datasetVersion: e.datasetVersion ?? null,
        executedAt: e.executedAt ?? null,
        cases: e.cases ?? null,
        answered: e.answered ?? null,
        recallAt10: e.recallAt10 ?? null,
        mrr: e.mrr ?? null,
        forbiddenHits: e.forbiddenHits ?? null,
        providerCostMicros: e.providerCostMicros ?? null,
        // Answerable cases the index missed, and cases with forbidden hits.
        missedCases: Array.isArray(e.results)
          ? e.results
              .filter((r: any) => r.rank === 0 || r.forbiddenHits > 0)
              .slice(0, 50)
              .map((r: any) => ({ id: r.id, rank: r.rank, forbiddenHits: r.forbiddenHits }))
          : [],
      }
    : null;

export async function readKnowledgeEvaluation(tx: DbTx, scope: Scope) {
  const active = await getActiveIndex(tx, scope);
  const generations = await describeIndexGenerations(tx, scope);
  const live = await validateActiveIndexEvaluation(tx, scope);
  const runs = (await list(tx, scope, "index_evaluations")).slice(0, 10);
  const sources = await knowledgeIndexStatus(tx, scope);
  // The spend mandate (ADR 0015): the platform's authority or the policy.
  const mandate = await requireSpendMandate(tx, scope).catch(() => null);
  return {
    projectId: scope.projectId,
    liveEvaluation: {
      valid: live.valid,
      reasons: live.reasons,
      activeIndexId: live.indexId,
    },
    activeIndex: {
      id: active.id,
      generation: active.generation,
      profile: active.profile,
      state: active.state,
    },
    generations: generations.slice(0, 10).map((g) => ({
      id: g.id,
      generation: g.generation,
      profile: g.profile,
      model: g.model,
      state: g.state,
      // `building` covers "embedding" and "embedded, waiting for evaluation".
      phase: g.phase,
      nextStep: g.nextStep,
      chunks: g.chunks,
      embeddedChunks: g.embeddedChunks,
      evaluation: summary(g.evaluation as Record<string, any> | null),
    })),
    evaluationRuns: runs.map((r) => ({
      id: r.id,
      status: data(r).status,
      indexId: data(r).indexId,
      datasetVersion: data(r).datasetVersion,
      cases: Array.isArray(data(r).cases) ? data(r).cases.length : 0,
      batch: data(r).batch ?? 0,
      createdAt: r.createdAt,
      completedAt: data(r).completedAt ?? null,
      evaluation: summary(data(r).evaluation ?? null),
    })),
    // Sources whose documents are missing from search, and why.
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      state: s.state,
      searchMode: s.searchMode,
      blockers: s.blockers,
      documents: s.documents,
      chunks: s.chunks,
      embeddedChunks: s.embeddedChunks,
    })),
    requirements: {
      cases: "60 to 120 cases; at least 48 with expectedChunkIds and 12 negatives with forbiddenChunkIds only",
      pass: "recall@10 >= 0.9 and no forbidden hit",
      freshness: "valid for 30 days and only while the indexed corpus is unchanged",
      receipts: "settled provider receipts of the build and of the evaluation",
      sources: "active model-usable sources with authority official, website or research",
      embeddingProfiles: Object.keys(EMBEDDING_PROFILES),
    },
    paidMandate: {
      activePolicy: Boolean(mandate),
      approvedPaidTests: mandate?.limits.approvedPaidTests === true,
      perRunBudgetMicros: mandate?.limits.perRunBudgetMicros ?? 0,
    },
    steps:
      "knowledge_evaluate step begin_index (free) → build_index (paid embeddings) → evaluate (paid query embeddings) → activate (only a passed evaluation). A generation stays in state building until its evaluation passes; its phase names the next step (corpus_changed: the knowledge changed after begin_index, so begin a new generation).",
  };
}

export const knowledgeEvaluateInput = z
  .object({
    step: z.enum(["begin_index", "build_index", "evaluate", "activate"]),
    profile: z.string().max(200).optional(),
    indexId: z.uuid().optional(),
    datasetVersion: indexEvaluationRequest.shape.datasetVersion.optional(),
    cases: indexEvaluationRequest.shape.cases.optional(),
    confirmQueriesMayBeSentToOpenAI: z.literal(true).optional(),
  })
  .strict();
type EvaluateInput = z.infer<typeof knowledgeEvaluateInput>;

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new DomainError(`FIELD_REQUIRED:${field}`, 400);
  return value;
}

async function indexOf(tx: DbTx, scope: Scope, id: string) {
  const index = await tx.knowledgeIndex.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  if (!index) throw new DomainError("INDEX_UNAVAILABLE", 404);
  return index;
}

/** The paid ceiling the owner approves: embedding tokens of the step. */
async function stepCeiling(tx: DbTx, scope: Scope, args: EvaluateInput) {
  if (args.step !== "build_index" && args.step !== "evaluate") return 0;
  const index = await indexOf(tx, scope, need(args.indexId, "indexId"));
  const tokens =
    args.step === "evaluate"
      ? need(args.cases, "cases").reduce((n, c) => n + Buffer.byteLength(c.query), 0)
      : ((
          await tx.knowledgeChunk.aggregate({
            where: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              id: {
                in: (index.manifest as Array<{ chunkId: string }>).map((m) => m.chunkId),
              },
            },
            _sum: { tokenEstimate: true },
          })
        )._sum.tokenEstimate ?? 0);
  try {
    return estimateCost(index.model, tokens, 0, await runtimeOpenAiConfiguration(tx, scope));
  } catch {
    throw new DomainError("EMBEDDING_PRICE_REQUIRED", 409);
  }
}

async function validateStep(tx: DbTx, scope: Scope, args: EvaluateInput) {
  switch (args.step) {
    case "begin_index":
      if (args.profile && !(args.profile in EMBEDDING_PROFILES))
        throw new DomainError("UNSUPPORTED_EMBEDDING_PROFILE", 400);
      return;
    case "build_index": {
      const index = await indexOf(tx, scope, need(args.indexId, "indexId"));
      if (index.state !== "building") throw new DomainError("INDEX_NOT_BUILDING", 409);
      return;
    }
    case "evaluate": {
      need(args.datasetVersion, "datasetVersion");
      const cases = need(args.cases, "cases");
      // The same coverage the evaluation itself requires.
      if (
        new Set(cases.map((c) => c.id)).size !== cases.length ||
        cases.filter((c) => c.expectedChunkIds.length).length < 48 ||
        cases.filter((c) => !c.expectedChunkIds.length && c.forbiddenChunkIds.length)
          .length < 12
      )
        throw new DomainError("EVALUATION_CASE_COVERAGE_REQUIRED", 400);
      need(args.confirmQueriesMayBeSentToOpenAI, "confirmQueriesMayBeSentToOpenAI");
      const index = await indexOf(tx, scope, need(args.indexId, "indexId"));
      // Before approval: an unknown expected id fails the run after paying for
      // it, and an unknown forbidden id makes its negative case test nothing.
      const missing = await evaluationChunksNotInIndex(tx, scope, index.id, cases);
      if (missing.length)
        throw new DomainError(
          `EVALUATION_CHUNKS_NOT_IN_INDEX:${missing.slice(0, 5).join(",")}`,
          409,
        );
      return;
    }
    case "activate": {
      const index = await indexOf(tx, scope, need(args.indexId, "indexId"));
      const e = index.evaluation as Record<string, unknown> | null;
      // Only a passed live evaluation may become the active index.
      if (index.state !== "evaluated" || e?.passed !== true || e?.provenance !== "live")
        throw new DomainError("INDEX_NOT_EVALUATED", 409);
      return;
    }
  }
}

async function runStep(tx: DbTx, scope: Scope, args: EvaluateInput) {
  switch (args.step) {
    case "begin_index": {
      const active = await getActiveIndex(tx, scope);
      const index = await beginIndexBuild(tx, scope, args.profile ?? active.profile);
      return { step: args.step, indexId: index.id, generation: index.generation };
    }
    case "build_index":
      await queueIndexBuild(tx, scope, args.indexId!);
      return { step: args.step, indexId: args.indexId, queued: true };
    case "evaluate": {
      await queueIndexEvaluation(tx, scope, {
        indexId: args.indexId!,
        datasetVersion: args.datasetVersion!,
        confirmQueriesMayBeSentToOpenAI: true,
        cases: args.cases!,
      });
      return { step: args.step, indexId: args.indexId, queued: true };
    }
    case "activate": {
      const index = await activateIndexGeneration(tx, scope, args.indexId!);
      return { step: args.step, indexId: index.id, state: index.state };
    }
  }
}

const getTool = readOperation({
  name: "knowledge_evaluation_get",
  module: "knowledge",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the knowledge quality gate: whether the active index has a valid live RAG evaluation (and why not), every index generation with its embedding coverage and evaluation metrics (recall@10, MRR, forbidden hits, missed cases), recent evaluation runs, sources missing from search, the requirements and the paid mandate.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readKnowledgeEvaluation(tx, scope),
});

const evaluate = approvedOperation({
  name: "knowledge_evaluate",
  // For outside clients (ChatGPT over MCP); the assistant reads only.
  assistant: false,
  module: "knowledge",
  feature: "project_administration",
  proposable: projectAdministrationEnabled,
  mcpProjectRequired: true,
  description:
    "Proposes one step of the official live RAG evaluation: begin_index (optional profile), build_index (indexId; paid embeddings), evaluate (indexId, datasetVersion, 60-120 cases with expectedChunkIds or forbiddenChunkIds, confirmQueriesMayBeSentToOpenAI; paid) or activate (indexId; only after a passed live evaluation). Paid steps need an AI spending mandate with approved paid use. Owners only.",
  input: knowledgeEvaluateInput,
  permission: PROJECT_OWN,
  validate: (tx, scope, args) => validateStep(tx, scope, args),
  spendCeiling: (tx, scope, args) =>
    stepCeiling(tx, scope, knowledgeEvaluateInput.parse(args)),
  run: (tx, scope, args) => runStep(tx, scope, args),
  executionResult: async (_tx, _scope, saved) => saved,
});

export const knowledgeEvaluationTools = [getTool, evaluate.tool];
export const knowledgeEvaluationActionTypes = {
  [evaluate.actionType]: evaluate.action,
};

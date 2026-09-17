import { Prisma, type DbTx } from "@orbit/db";
import { randomUUID } from "node:crypto";
import { hash, validateVector } from "./algorithms.js";
import {
  EMBEDDING_PROFILE,
  RETRIEVER_VERSION,
  CHUNK_VERSION,
  KnowledgeError,
  type Scope,
} from "./types.js";

export const EMBEDDING_PROFILES = {
  [EMBEDDING_PROFILE]: { model: "text-embedding-3-small", dimensions: 1536 },
  "openai:text-embedding-3-large:1536:chunk-v1": {
    model: "text-embedding-3-large",
    dimensions: 1536,
  },
  "openai:text-embedding-3-large:3072:chunk-v1": {
    model: "text-embedding-3-large",
    dimensions: 3072,
  },
} as const;
const where = (s: Scope) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
});
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function profileConfig(profile: string) {
  const config = EMBEDDING_PROFILES[profile as keyof typeof EMBEDDING_PROFILES];
  if (!config) throw new KnowledgeError("UNSUPPORTED_EMBEDDING_PROFILE");
  return config;
}
type ManifestItem = {
  chunkId: string;
  versionId: string;
  sourceId: string;
  sourceGeneration: number;
  chunkHash: string;
};
async function manifest(tx: DbTx, s: Scope) {
  return tx.$queryRaw<
    ManifestItem[]
  >`SELECT c.id AS "chunkId",v.id AS "versionId",d."sourceId",v."sourceGeneration",c."chunkHash" FROM "KnowledgeChunk" c JOIN "DocumentVersion" v ON v.id=c."documentVersionId" JOIN "KnowledgeDocument" d ON d.id=v."documentId" JOIN "Entity" s ON s.id=d."sourceId" WHERE c."workspaceId"=${s.workspaceId}::uuid AND c."projectId"=${s.projectId}::uuid AND v.state='active' AND d."activeVersionId"=v.id AND s.kind='sources' AND s.data->>'status'='active' AND s.data->>'modelUse'='true' AND s.data->>'authority' IN ('official','website','research') AND v."sourceGeneration"=(s.data->>'generation')::int ORDER BY c.id`;
}
async function auditIndex(
  tx: DbTx,
  s: Scope,
  action: string,
  id: string,
  metadata: unknown,
) {
  await tx.auditEvent.create({
    data: {
      ...where(s),
      actorId: s.userId,
      action,
      resourceId: id,
      metadata: json(metadata),
    },
  });
}
/** Baseline is lazily created for new projects; existing vector rows are backfilled by migration 002. */
export async function getActiveIndex(tx: DbTx, s: Scope) {
  let active = await tx.knowledgeIndex.findFirst({
    where: { ...where(s), state: "active" },
  });
  if (!active) {
    const any = await tx.knowledgeIndex.count({ where: where(s) });
    if (any) throw new KnowledgeError("NO_ACTIVE_EMBEDDING_INDEX");
    active = await tx.knowledgeIndex.create({
      data: {
        ...where(s),
        generation: 1,
        profile: EMBEDDING_PROFILE,
        ...profileConfig(EMBEDDING_PROFILE),
        state: "active",
        manifest: [],
        manifestHash: "legacy-baseline",
        activatedAt: new Date(),
      },
    });
  }
  if (
    (active.evaluation as { provenance?: string } | null)?.provenance ===
      "synthetic_test" &&
    process.env.NODE_ENV !== "test"
  )
    throw new KnowledgeError("SYNTHETIC_INDEX_UNAVAILABLE");
  return active;
}
export async function assertActiveEmbeddingProfile(
  tx: DbTx,
  s: Scope,
  expected = EMBEDDING_PROFILE,
) {
  profileConfig(expected);
  const active = await getActiveIndex(tx, s);
  if (active.profile !== expected)
    throw new KnowledgeError("ACTIVE_EMBEDDING_PROFILE_MISMATCH");
  return active;
}
export async function listIndexGenerations(tx: DbTx, s: Scope) {
  await getActiveIndex(tx, s);
  return tx.knowledgeIndex.findMany({
    where: where(s),
    orderBy: { generation: "desc" },
  });
}
export async function beginIndexBuild(tx: DbTx, s: Scope, profile: string) {
  const config = profileConfig(profile);
  await getActiveIndex(tx, s);
  const rows = await manifest(tx, s);
  if (!rows.length) throw new KnowledgeError("EMPTY_INDEX_CORPUS");
  if (rows.length > 100000) throw new KnowledgeError("INDEX_CORPUS_LIMIT");
  const previous = await tx.knowledgeIndex.aggregate({
    where: where(s),
    _max: { generation: true },
  });
  const index = await tx.knowledgeIndex.create({
    data: {
      ...where(s),
      generation: previous._max.generation! + 1,
      profile,
      ...config,
      state: "building",
      manifest: json(rows),
      manifestHash: hash(JSON.stringify(rows)),
    },
  });
  await auditIndex(tx, s, "knowledge.index_build_started", index.id, {
    profile,
    generation: index.generation,
    chunks: rows.length,
  });
  return index;
}
async function selectedIndex(tx: DbTx, s: Scope, id: string) {
  const index = await tx.knowledgeIndex.findFirst({
    where: { ...where(s), id },
  });
  if (!index) throw new KnowledgeError("INDEX_UNAVAILABLE");
  return index;
}
async function currentManifest(
  tx: DbTx,
  s: Scope,
  index: Awaited<ReturnType<typeof selectedIndex>>,
) {
  const current = await manifest(tx, s);
  if (hash(JSON.stringify(current)) !== index.manifestHash)
    throw new KnowledgeError("INDEX_CORPUS_CHANGED");
  return current;
}
export async function assertIndexCorpusCurrent(
  tx: DbTx,
  s: Scope,
  indexId: string,
) {
  const index = await selectedIndex(tx, s, indexId);
  if (index.state !== "building")
    throw new KnowledgeError("INDEX_NOT_BUILDING");
  await currentManifest(tx, s, index);
  return index;
}
async function completeIndex(
  tx: DbTx,
  s: Scope,
  index: Awaited<ReturnType<typeof selectedIndex>>,
) {
  const rows = await currentManifest(tx, s, index);
  const count = await tx.chunkEmbedding.count({
    where: {
      ...where(s),
      profile: index.profile,
      indexGeneration: index.generation,
      chunkId: { in: rows.map((r) => r.chunkId) },
    },
  });
  if (count !== rows.length) throw new KnowledgeError("INCOMPLETE_INDEX_BUILD");
  return rows;
}
export async function attachIndexBatch(
  tx: DbTx,
  s: Scope,
  indexId: string,
  vectors: { chunkId: string; vector: number[] }[],
) {
  const index = await selectedIndex(tx, s, indexId);
  if (index.state !== "building")
    throw new KnowledgeError("INDEX_NOT_BUILDING");
  if (
    !vectors.length ||
    vectors.length > 500 ||
    new Set(vectors.map((v) => v.chunkId)).size !== vectors.length
  )
    throw new KnowledgeError("INVALID_INDEX_BATCH");
  const corpus = await currentManifest(tx, s, index);
  const ids = new Set(corpus.map((c) => c.chunkId));
  for (const item of vectors) {
    if (!ids.has(item.chunkId)) throw new KnowledgeError("CHUNK_UNAVAILABLE");
    const vector = validateVector(item.vector, index.dimensions);
    await tx.$executeRaw`INSERT INTO "ChunkEmbedding" (id,"workspaceId","projectId","chunkId",profile,model,dimensions,"indexGeneration",vector) VALUES (${randomUUID()}::uuid,${s.workspaceId}::uuid,${s.projectId}::uuid,${item.chunkId}::uuid,${index.profile},${index.model},${index.dimensions},${index.generation},${vector}::vector) ON CONFLICT ("chunkId",profile,"indexGeneration") DO NOTHING`;
  }
  const stored = await tx.chunkEmbedding.count({
    where: {
      ...where(s),
      profile: index.profile,
      indexGeneration: index.generation,
    },
  });
  await auditIndex(tx, s, "knowledge.index_batch_attached", index.id, {
    chunks: vectors.length,
    stored,
  });
  return { indexId, stored, total: corpus.length };
}
export type IndexEvaluationInput = {
  datasetVersion: string;
  provenance: "live" | "synthetic_test";
  /** Trusted provider adapter receipts; never accept a client assertion that fake vectors are live. */
  budgetReservationIds?: string[];
  cases: {
    id: string;
    queryVector: number[];
    expectedChunkIds: string[];
    forbiddenChunkIds?: string[];
    language?: string;
    purpose?: "public" | "internal";
    at?: Date;
  }[];
};
/** Execute an exact, filtered SQL evaluation. Callers own provider authorization and budget settlement. */
export async function evaluateIndexGeneration(
  tx: DbTx,
  s: Scope,
  indexId: string,
  input: IndexEvaluationInput,
) {
  const index = await selectedIndex(tx, s, indexId);
  if (!["building", "evaluated"].includes(index.state))
    throw new KnowledgeError("INDEX_NOT_EVALUATABLE");
  await completeIndex(tx, s, index);
  if (
    !input.datasetVersion.trim() ||
    input.datasetVersion.length > 120 ||
    input.cases.length < 60 ||
    input.cases.length > 1000 ||
    new Set(input.cases.map((c) => c.id)).size !== input.cases.length
  )
    throw new KnowledgeError("INVALID_INDEX_EVALUATION");
  if (
    input.cases.some(
      (c) =>
        !c.id.trim() ||
        c.expectedChunkIds.length > 100 ||
        (!c.expectedChunkIds.length && !c.forbiddenChunkIds?.length),
    )
  )
    throw new KnowledgeError("INVALID_INDEX_EVALUATION");
  if (input.provenance === "synthetic_test" && process.env.NODE_ENV !== "test")
    throw new KnowledgeError("SYNTHETIC_EVALUATION_TEST_ONLY");
  let cost = 0n;
  if (input.provenance === "live") {
    const ids = [...new Set(input.budgetReservationIds ?? [])];
    const receipts = await tx.budgetReservation.findMany({
      where: {
        ...where(s),
        id: { in: ids },
        state: "settled",
        key: { startsWith: s.projectId + ":index:" + index.id + ":" },
        category: { in: ["reindex", "reindex_evaluation"] },
      },
    });
    if (
      !ids.length ||
      receipts.length !== ids.length ||
      receipts.some((r) => r.settledMicros === null || r.settledMicros <= 0n) ||
      !receipts.some(
        (r) =>
          r.category === "reindex" &&
          r.key.startsWith(s.projectId + ":index:" + index.id + ":build:"),
      ) ||
      !receipts.some(
        (r) =>
          r.category === "reindex_evaluation" &&
          r.key.startsWith(
            s.projectId +
              ":index:" +
              index.id +
              ":evaluation:" +
              input.datasetVersion +
              ":",
          ),
      )
    )
      throw new KnowledgeError("EVALUATION_BUDGET_RECEIPTS_REQUIRED");
    cost = receipts.reduce((sum, r) => sum + r.settledMicros!, 0n);
    if (cost <= 0n)
      throw new KnowledgeError("EVALUATION_BUDGET_RECEIPTS_REQUIRED");
  }
  let answered = 0,
    hits = 0,
    forbiddenHits = 0,
    rr = 0;
  const results: { id: string; rank: number; forbiddenHits: number }[] = [];
  for (const c of input.cases) {
    const v = validateVector(c.queryVector, index.dimensions),
      at = c.at ?? new Date();
    if (!Number.isFinite(at.getTime()))
      throw new KnowledgeError("INVALID_INDEX_EVALUATION");
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`WITH eligible AS MATERIALIZED (SELECT e.vector,c.id FROM "ChunkEmbedding" e JOIN "KnowledgeChunk" c ON c.id=e."chunkId" JOIN "DocumentVersion" v ON v.id=c."documentVersionId" JOIN "KnowledgeDocument" d ON d.id=v."documentId" JOIN "Entity" s ON s.id=d."sourceId" WHERE e."workspaceId"=${s.workspaceId}::uuid AND e."projectId"=${s.projectId}::uuid AND e.profile=${index.profile} AND e."indexGeneration"=${index.generation} AND e.dimensions=${index.dimensions} AND v.state='active' AND d."activeVersionId"=v.id AND s.data->>'status'='active' AND s.data->>'modelUse'='true' AND s.data->>'authority' IN ('official','website','research') AND v."sourceGeneration"=(s.data->>'generation')::int AND c.language=${c.language ?? "en"} AND v."validFrom"<=${at} AND (v."validUntil" IS NULL OR v."validUntil">${at}) AND v."fetchedAt"+((s.data->>'maxAgeHours')::double precision*interval '1 hour')>${at} AND (${c.purpose === "internal"} OR (s.data->>'publicUse'='true' AND (s.data->>'embargoUntil' IS NULL OR (s.data->>'embargoUntil')::timestamptz<=${at})))) SELECT id FROM eligible ORDER BY vector <=> ${v}::vector,id LIMIT 10`;
    const rank = rows.findIndex((r) => c.expectedChunkIds.includes(r.id)) + 1;
    const forbidden = rows.filter((r) =>
      (c.forbiddenChunkIds ?? []).includes(r.id),
    ).length;
    if (c.expectedChunkIds.length) {
      answered++;
      if (rank) {
        hits++;
        rr += 1 / rank;
      }
    }
    forbiddenHits += forbidden;
    results.push({ id: c.id, rank, forbiddenHits: forbidden });
  }
  const recallAt10 = answered ? hits / answered : 0,
    mrr = answered ? rr / answered : 0;
  const passed =
    answered >= 48 &&
    input.cases.length - answered >= 12 &&
    recallAt10 >= 0.9 &&
    forbiddenHits === 0;
  const evaluation = {
    datasetVersion: input.datasetVersion,
    datasetHash: hash(JSON.stringify(input.cases)),
    retrieverVersion: RETRIEVER_VERSION,
    chunkingVersion: CHUNK_VERSION,
    model: index.model,
    dimensions: index.dimensions,
    metric: index.metric,
    provenance: input.provenance,
    executedAt: new Date().toISOString(),
    manifestHash: index.manifestHash,
    profile: index.profile,
    generation: index.generation,
    cases: input.cases.length,
    answered,
    recallAt10,
    mrr,
    forbiddenHits,
    passed,
    providerCostMicros: cost.toString(),
    budgetReservationIds: input.budgetReservationIds ?? [],
    results,
  };
  await tx.knowledgeIndex.update({
    where: { id: index.id },
    data: {
      state: passed ? "evaluated" : "building",
      evaluation: json(evaluation),
    },
  });
  await auditIndex(tx, s, "knowledge.index_evaluated", index.id, {
    passed,
    recallAt10,
    forbiddenHits,
    provenance: input.provenance,
  });
  return evaluation;
}
const EVALUATION_MAX_AGE_MS = 30 * 86400000;
function currentEvaluationConfig(
  index: {
    profile: string;
    model: string;
    dimensions: number;
    metric: string;
    manifestHash: string;
    evaluation: unknown;
  },
  at = new Date(),
) {
  const e = index.evaluation as Record<string, unknown> | null;
  const when =
    typeof e?.executedAt === "string" ? Date.parse(e.executedAt) : NaN;
  return Boolean(
    e?.passed === true &&
    e.profile === index.profile &&
    e.model === index.model &&
    e.dimensions === index.dimensions &&
    e.metric === index.metric &&
    e.manifestHash === index.manifestHash &&
    e.retrieverVersion === RETRIEVER_VERSION &&
    e.chunkingVersion === CHUNK_VERSION &&
    typeof e.datasetHash === "string" &&
    /^[a-f0-9]{64}$/.test(e.datasetHash) &&
    Number.isFinite(when) &&
    when <= at.getTime() + 300000 &&
    at.getTime() - when <= EVALUATION_MAX_AGE_MS,
  );
}
/** Runtime release gate: actual current corpus/config/receipts, never an environment assertion. */
export async function validateActiveIndexEvaluation(
  tx: DbTx,
  s: Scope,
  at = new Date(),
) {
  const index = await getActiveIndex(tx, s),
    e = index.evaluation as Record<string, unknown> | null;
  const reasons: string[] = [];
  if (!currentEvaluationConfig(index, at) || e?.provenance !== "live")
    reasons.push("LIVE_INDEX_EVALUATION_REQUIRED");
  else {
    try {
      await currentManifest(tx, s, index);
    } catch {
      reasons.push("INDEX_EVALUATION_CORPUS_CHANGED");
    }
    const ids = Array.isArray(e.budgetReservationIds)
      ? e.budgetReservationIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    const receipts = await tx.budgetReservation.findMany({
      where: {
        ...where(s),
        id: { in: ids },
        state: "settled",
        key: { startsWith: s.projectId + ":index:" + index.id + ":" },
        category: { in: ["reindex", "reindex_evaluation"] },
      },
    });
    if (
      !ids.length ||
      receipts.length !== ids.length ||
      receipts.some((r) => r.settledMicros === null || r.settledMicros <= 0n) ||
      !receipts.some(
        (r) =>
          r.category === "reindex" &&
          r.key.startsWith(s.projectId + ":index:" + index.id + ":build:"),
      ) ||
      !receipts.some(
        (r) =>
          r.category === "reindex_evaluation" &&
          r.key.startsWith(
            s.projectId +
              ":index:" +
              index.id +
              ":evaluation:" +
              e.datasetVersion +
              ":",
          ),
      )
    )
      reasons.push("INDEX_EVALUATION_RECEIPTS_UNAVAILABLE");
  }
  return { valid: reasons.length === 0, reasons, indexId: index.id };
}
export async function activateIndexGeneration(
  tx: DbTx,
  s: Scope,
  indexId: string,
  options: { allowSyntheticForTest?: boolean } = {},
) {
  const target = await selectedIndex(tx, s, indexId);
  if (!["evaluated", "retired"].includes(target.state))
    throw new KnowledgeError("INDEX_NOT_EVALUATED");
  const e = target.evaluation as {
    passed?: boolean;
    provenance?: string;
    manifestHash?: string;
  } | null;
  if (
    !e?.passed ||
    e.manifestHash !== target.manifestHash ||
    !currentEvaluationConfig(target)
  )
    throw new KnowledgeError("INDEX_EVALUATION_REQUIRED");
  if (e.provenance !== "live") {
    const project = await tx.project.findFirstOrThrow({
      where: { workspaceId: s.workspaceId, id: s.projectId },
    });
    if (
      !options.allowSyntheticForTest ||
      process.env.NODE_ENV !== "test" ||
      !process.env.TEST_DATABASE_URL ||
      project.mode !== "observe" ||
      !project.paused
    )
      throw new KnowledgeError("LIVE_INDEX_EVALUATION_REQUIRED");
  }
  await completeIndex(tx, s, target);
  const current = await getActiveIndex(tx, s);
  const currentEvaluation = current.evaluation as {
    passed?: boolean;
    manifestHash?: string;
  } | null;
  if (
    current.profile !== target.profile &&
    (!currentEvaluation?.passed ||
      currentEvaluation.manifestHash !== current.manifestHash ||
      !currentEvaluationConfig(current))
  )
    throw new KnowledgeError("BASELINE_CHECKPOINT_REQUIRED");
  await tx.knowledgeIndex.update({
    where: { id: current.id },
    data: { state: "retired" },
  });
  const active = await tx.knowledgeIndex.update({
    where: { id: target.id },
    data: { state: "active", activatedAt: new Date() },
  });
  await auditIndex(tx, s, "knowledge.index_activated", target.id, {
    previousIndexId: current.id,
    profile: target.profile,
    generation: target.generation,
  });
  return active;
}
export async function rollbackIndexGeneration(
  tx: DbTx,
  s: Scope,
  indexId: string,
  options: { allowSyntheticForTest?: boolean } = {},
) {
  const target = await selectedIndex(tx, s, indexId);
  if (target.state !== "retired") throw new KnowledgeError("INDEX_NOT_RETIRED");
  return activateIndexGeneration(tx, s, indexId, options);
}

import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  ingest,
  fetchApprovedDocument,
  extractDocument,
  sourceData,
  attachEmbeddingBatch,
  EMBEDDING_PROFILE,
  assertActiveEmbeddingProfile,
} from "../../../../packages/knowledge/src/index.ts";
import { entity, data, DomainError } from "../shared.ts";
import { reserve, settle, markTransmitted } from "./budget.ts";
import { activePolicy } from "./policy.ts";
import { policy } from "../../../../packages/schemas/src/index.ts";
import { embed, estimateCost } from "../../../../packages/ai/src/index.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
import { enqueue } from "./workflow.ts";
function assertEmbeddingDocumentFresh(
  version: {
    fetchedAt: Date;
    validFrom: Date;
    validUntil: Date | null;
  },
  maxAgeHours: number,
) {
  const now = Date.now();
  if (
    version.validFrom.getTime() > now ||
    (version.validUntil && version.validUntil.getTime() <= now) ||
    version.fetchedAt.getTime() + maxAgeHours * 3600000 <= now
  )
    throw new DomainError("DOCUMENT_NOT_FRESH");
}
export async function syncSource(scope: Scope, requestId: string) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const request = await entity(tx, scope, "sync_requests", requestId),
        r = data(request);
      const source = await entity(tx, scope, "sources", r.sourceId),
        s = sourceData(source.data);
      if (s.generation !== r.expectedGeneration)
        throw new DomainError("STALE_SOURCE_GENERATION");
      return { request: r, source: s };
    },
  );
  const doc = await fetchApprovedDocument(prepared.request.url, {
    allowedOrigins: prepared.source.allowedOrigins,
    allowedPaths: prepared.source.allowedPaths,
  });
  const extracted = await extractDocument(doc.bytes, doc.mimeType);
  return scoped(scope.workspaceId, scope.projectId, (tx) =>
    ingest(tx, scope, {
      sourceId: prepared.request.sourceId,
      externalId: doc.url,
      canonicalUrl: doc.url,
      title: new URL(doc.url).pathname,
      text: extracted.text,
      mimeType: doc.mimeType,
      language: prepared.request.language,
      expectedGeneration: prepared.request.expectedGeneration,
    }),
  );
}
export async function queueDocumentEmbedding(
  tx: DbTx,
  scope: Scope,
  documentId: string,
) {
  const document = await tx.knowledgeDocument.findFirst({
    where: { id: documentId, projectId: scope.projectId },
  });
  if (!document?.activeVersionId) throw new DomainError("DOCUMENT_NOT_FOUND");
  const activeIndex = await assertActiveEmbeddingProfile(
    tx,
    scope,
    EMBEDDING_PROFILE,
  );
  const [total, stored, jobs] = await Promise.all([
    tx.knowledgeChunk.count({
      where: { documentVersionId: document.activeVersionId },
    }),
    tx.chunkEmbedding.count({
      where: {
        projectId: scope.projectId,
        profile: EMBEDDING_PROFILE,
        indexGeneration: activeIndex.generation,
        chunk: { documentVersionId: document.activeVersionId },
      },
    }),
    tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind: "jobs",
        data: { path: ["resourceId"], equals: document.id },
      },
    }),
  ]);
  if (stored === total) return { unchanged: true, embedded: stored, total };
  const prefix = `embedding:${document.activeVersionId}:${activeIndex.generation}:${stored}:`;
  const matching = jobs.filter((job) => {
    const value = data(job);
    return (
      value.topic === "embedding" &&
      value.resourceId === document.id &&
      typeof value.idempotencyKey === "string" &&
      value.idempotencyKey.startsWith(prefix)
    );
  });
  const active = matching.find((job) =>
    ["queued", "running", "retry_scheduled"].includes(data(job).status),
  );
  if (active) return active;
  const terminalAttempts = matching.filter((job) =>
    ["failed", "blocked_dependency"].includes(data(job).status),
  ).length;
  return enqueue(
    tx,
    scope,
    "embedding",
    document.id,
    `${prefix}manual:${terminalAttempts}`,
  );
}
export async function embedDocument(
  scope: Scope,
  documentId: string,
  jobId: string,
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const activeIndex = await assertActiveEmbeddingProfile(
        tx,
        scope,
        EMBEDDING_PROFILE,
      );
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) throw new DomainError("PROJECT_PAUSED");
      const doc = await tx.knowledgeDocument.findFirst({
        where: { id: documentId, projectId: scope.projectId },
      });
      if (!doc?.activeVersionId) throw new DomainError("DOCUMENT_NOT_FOUND");
      const source = await entity(tx, scope, "sources", doc.sourceId),
        s = sourceData(source.data);
      if (!s.modelUse) throw new DomainError("MODEL_USE_FORBIDDEN");
      const version = await tx.documentVersion.findFirstOrThrow({
        where: { id: doc.activeVersionId },
        include: { chunks: { orderBy: { position: "asc" } } },
      });
      if (version.sourceGeneration !== s.generation)
        throw new DomainError("STALE_SOURCE_GENERATION");
      assertEmbeddingDocumentFresh(version, s.maxAgeHours);
      const existing = await tx.chunkEmbedding.findMany({
        where: {
          projectId: scope.projectId,
          chunk: { documentVersionId: version.id },
          profile: EMBEDDING_PROFILE,
          indexGeneration: activeIndex.generation,
        },
        select: { chunkId: true },
      });
      const stored = new Set(existing.map((item) => item.chunkId));
      const batch = version.chunks
        .filter((chunk) => !stored.has(chunk.id))
        .slice(0, 32);
      if (!batch.length) return null;
      const p = await activePolicy(tx, scope);
      if (!p) throw new DomainError("POLICY_REQUIRED");
      const approved = policy.parse(
        Object.fromEntries(
          Object.entries(data(p)).filter(
            ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
          ),
        ),
      );
      const texts = batch.map((x) => x.text);
      const ai = await runtimeOpenAiConfiguration(tx, scope);
      const amount = estimateCost(
        "text-embedding-3-small",
        texts.reduce((n, x) => n + Buffer.byteLength(x), 0),
        0,
        ai,
      );
      const reserved = await reserve(
        tx,
        scope,
        jobId,
        "embedding",
        amount,
        approved,
      );
      return {
        doc,
        version,
        batch,
        sourceGeneration: s.generation,
        projectGeneration: project.generation,
        indexGeneration: activeIndex.generation,
        texts,
        reservationId: reserved.id,
        policyId: p.id,
        policyVersion: p.version,
        ai,
      };
    },
  );
  if (!prepared) return { unchanged: true };
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const source = await entity(tx, scope, "sources", prepared.doc.sourceId);
    const s = sourceData(source.data);
    if (!s.modelUse || s.generation !== prepared.sourceGeneration)
      throw new DomainError("SOURCE_RIGHTS_CHANGED");
    assertEmbeddingDocumentFresh(prepared.version, s.maxAgeHours);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    const p = await activePolicy(tx, scope);
    if (
      project.paused ||
      project.generation !== prepared.projectGeneration ||
      p?.id !== prepared.policyId ||
      p?.version !== prepared.policyVersion ||
      Date.now() < Date.parse(data(p).startAt) ||
      Date.now() >= Date.parse(data(p).endAt)
    )
      throw new DomainError("PAID_MANDATE_CHANGED");
    const currentDoc = await tx.knowledgeDocument.findFirst({
      where: { id: prepared.doc.id, projectId: scope.projectId },
    });
    if (currentDoc?.activeVersionId !== prepared.version.id)
      throw new DomainError("EMBEDDING_DEPENDENCY_CHANGED");
    const activeIndex = await assertActiveEmbeddingProfile(
      tx,
      scope,
      EMBEDDING_PROFILE,
    );
    if (activeIndex.generation !== prepared.indexGeneration)
      throw new DomainError("EMBEDDING_DEPENDENCY_CHANGED");
    await markTransmitted(tx, scope, prepared.reservationId);
  });
  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed(
      prepared.texts,
      prepared.reservationId,
      true,
      undefined,
      prepared.ai,
    );
  } catch {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      settle(tx, scope, prepared.reservationId, null),
    );
    throw new DomainError("EMBEDDING_COST_UNKNOWN");
  }
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    settle(tx, scope, prepared.reservationId, result.usage.costMicros),
  );
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      }),
      p = await activePolicy(tx, scope);
    if (
      project.paused ||
      project.generation !== prepared.projectGeneration ||
      p?.id !== prepared.policyId ||
      p.version !== prepared.policyVersion ||
      Date.now() < Date.parse(data(p).startAt) ||
      Date.now() >= Date.parse(data(p).endAt)
    )
      throw new DomainError("EMBEDDING_DEPENDENCY_CHANGED");
    if (result.vectors.length !== prepared.batch.length)
      throw new DomainError("INCOMPLETE_EMBEDDING_RESPONSE");
    const attached = await attachEmbeddingBatch(tx, scope, {
      sourceId: prepared.doc.sourceId,
      versionId: prepared.version.id,
      expectedGeneration: prepared.sourceGeneration,
      expectedIndexGeneration: prepared.indexGeneration,
      vectors: result.vectors.map((vector, i) => ({
        chunkId: prepared.batch[i]!.id,
        vector,
      })),
      profile: EMBEDDING_PROFILE,
    });
    if (!attached.complete)
      return enqueue(
        tx,
        scope,
        "embedding",
        prepared.doc.id,
        `embedding:${prepared.version.id}:${prepared.indexGeneration}:${attached.stored}:chain`,
      );
    return attached;
  });
}

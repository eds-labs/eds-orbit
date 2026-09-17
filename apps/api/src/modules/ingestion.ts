import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  ingest,
  fetchApprovedDocument,
  extractDocument,
  sourceData,
  chunkText,
  attachEmbeddings,
  EMBEDDING_PROFILE,
  assertActiveEmbeddingProfile,
} from "../../../../packages/knowledge/src/index.ts";
import { entity, data, DomainError, update, audit } from "../shared.ts";
import { reserve, settle, markTransmitted } from "./budget.ts";
import { activePolicy } from "./policy.ts";
import { policy } from "../../../../packages/schemas/src/index.ts";
import { embed, estimateCost } from "../../../../packages/ai/src/index.ts";
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
      const existing = await tx.chunkEmbedding.count({
        where: {
          projectId: scope.projectId,
          chunk: { documentVersionId: version.id },
          profile: EMBEDDING_PROFILE,
          indexGeneration: activeIndex.generation,
        },
      });
      if (existing === version.chunks.length) return null;
      if (version.chunks.length > 32)
        throw new DomainError("EMBEDDING_BATCH_LIMIT");
      const p = await activePolicy(tx, scope);
      if (!p) throw new DomainError("POLICY_REQUIRED");
      const approved = policy.parse(
        Object.fromEntries(
          Object.entries(data(p)).filter(
            ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
          ),
        ),
      );
      const texts = version.chunks.map((x) => x.text);
      const amount = estimateCost(
        "text-embedding-3-small",
        texts.reduce((n, x) => n + Buffer.byteLength(x), 0),
        0,
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
        sourceGeneration: s.generation,
        projectGeneration: project.generation,
        texts,
        reservationId: reserved.id,
        policyId: p.id,
        policyVersion: p.version,
      };
    },
  );
  if (!prepared) return { unchanged: true };
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const source = await entity(tx, scope, "sources", prepared.doc.sourceId);
    const s = sourceData(source.data);
    if (!s.modelUse || s.generation !== prepared.sourceGeneration)
      throw new DomainError("SOURCE_RIGHTS_CHANGED");
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
    await markTransmitted(tx, scope, prepared.reservationId);
  });
  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed(prepared.texts, prepared.reservationId, true);
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
      Date.now() >= Date.parse(data(p).endAt)
    )
      throw new DomainError("EMBEDDING_DEPENDENCY_CHANGED");
    return attachEmbeddings(tx, scope, {
      sourceId: prepared.doc.sourceId,
      versionId: prepared.version.id,
      expectedGeneration: prepared.sourceGeneration,
      vectors: result.vectors.map((vector, i) => ({
        chunkId: prepared.version.chunks[i]!.id,
        vector,
      })),
      profile: EMBEDDING_PROFILE,
    });
  });
}

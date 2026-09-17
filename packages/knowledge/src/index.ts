import { Prisma, type DbTx } from "@orbit/db";
import { randomUUID } from "node:crypto";
import {
  chunkText,
  diverseContext,
  hash,
  normalizeText,
  overlap,
  rrf,
  tokenEstimate,
  validAt,
  validateVector,
} from "./algorithms.js";
import {
  EMBEDDING_PROFILE,
  KnowledgeError,
  LIMITS,
  RETRIEVER_VERSION,
  type EvidenceData,
  type EvidenceFact,
  type EvidenceItem,
  type FactData,
  type FactInput,
  type IngestInput,
  type RetrieveInput,
  type Scope,
  type SourceData,
} from "./types.js";
export * from "./types.js";
export * from "./algorithms.js";
export * from "./safe-fetch.js";
export * from "./extract.js";
export * from "./indexes.js";
import { getActiveIndex, assertActiveEmbeddingProfile } from "./indexes.js";
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const where = (s: Scope) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
});
export function sourceData(value: unknown): SourceData {
  const d = value as SourceData;
  if (
    !d ||
    d.status !== "active" ||
    !Number.isInteger(d.generation) ||
    d.generation < 1
  )
    throw new KnowledgeError("SOURCE_UNAVAILABLE");
  if (
    !["official", "website", "research", "generated"].includes(d.authority) ||
    !Number.isFinite(d.maxAgeHours) ||
    d.maxAgeHours <= 0
  )
    throw new KnowledgeError("INVALID_SOURCE_POLICY");
  return d;
}
async function getSource(tx: DbTx, s: Scope, id: string) {
  const source = await tx.entity.findFirst({
    where: { ...where(s), id, kind: "sources" },
  });
  if (!source) throw new KnowledgeError("SOURCE_UNAVAILABLE");
  return { source, data: sourceData(source.data) };
}
async function revise(tx: DbTx, s: Scope, id: string, data: unknown) {
  const old = await tx.entity.findFirst({ where: { ...where(s), id } });
  if (!old) throw new KnowledgeError("NOT_FOUND");
  await tx.entityVersion.createMany({
    data: [
      {
        ...where(s),
        entityId: id,
        version: old.version,
        data: old.data as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return tx.entity.update({
    where: { id },
    data: { version: { increment: 1 }, data: json(data) },
  });
}
async function audit(
  tx: DbTx,
  s: Scope,
  action: string,
  id: string,
  metadata: unknown = {},
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
async function invalidate(
  tx: DbTx,
  s: Scope,
  sourceId: string,
  reason: string,
  factId?: string,
  purge = false,
) {
  const all = await tx.entity.findMany({
    where: {
      ...where(s),
      kind: {
        in: [
          "evidence",
          "content",
          "approvals",
          "publications",
          "insights",
          "jobs",
        ],
      },
    },
  });
  const evidenceIds = new Set<string>();
  for (const e of all.filter((e) => e.kind === "evidence")) {
    const d = e.data as unknown as EvidenceData;
    if (
      d.items?.some((i) => i.sourceId === sourceId) ||
      d.facts?.some((f) => (factId ? f.id === factId : f.sourceId === sourceId))
    ) {
      evidenceIds.add(e.id);
      await revise(tx, s, e.id, {
        ...d,
        status: "invalidated",
        gaps: [...new Set([...(d.gaps ?? []), reason])],
        ...(purge
          ? { items: [], facts: [], query: "[removed with source]" }
          : {}),
      });
      if (purge)
        await tx.entityVersion.deleteMany({
          where: { ...where(s), entityId: e.id },
        });
    }
  }
  const contentIds = new Set(
    all
      .filter(
        (e) =>
          e.kind === "content" &&
          evidenceIds.has(
            String((e.data as Record<string, unknown>).evidenceId),
          ),
      )
      .map((e) => e.id),
  );
  for (const e of all.filter((e) => e.kind !== "evidence")) {
    const d = e.data as Record<string, unknown>;
    const related =
      d.sourceId === sourceId ||
      d.resourceId === sourceId ||
      contentIds.has(String(d.resourceId)) ||
      evidenceIds.has(String(d.resourceId)) ||
      evidenceIds.has(String(d.evidenceId)) ||
      contentIds.has(e.id) ||
      contentIds.has(String(d.contentId)) ||
      (Array.isArray(d.sourceIds) && d.sourceIds.includes(sourceId));
    if (!related) continue;
    let status =
      e.kind === "content"
        ? "needs_review"
        : e.kind === "approvals"
          ? "invalidated"
          : e.kind === "insights"
            ? "retracted"
            : "blocked_dependency";
    const needsRemoteReconcile =
      e.kind === "publications" &&
      [
        "sending",
        "outcome_unknown",
        "scheduled_remote",
        "published",
        "reconciliation_required",
        "cancellation_required",
      ].includes(String(d.status));
    const terminalReceipt =
      e.kind === "publications" &&
      [
        "published_test",
        "published",
        "cancelled",
        "canceled",
        "deleted",
      ].includes(String(d.status));
    if (
      e.kind === "publications" &&
      [
        "sending",
        "outcome_unknown",
        "scheduled_remote",
        "published",
        "reconciliation_required",
        "cancellation_required",
      ].includes(String(d.status))
    )
      status = "reconciliation_required";
    if (terminalReceipt) status = String(d.status);
    if (
      e.kind === "jobs" &&
      ["completed", "cancelled", "canceled"].includes(String(d.status))
    )
      status = String(d.status);
    await revise(tx, s, e.id, {
      ...d,
      status,
      invalidationReason: reason,
      dependencyInvalidated: true,
      ...(needsRemoteReconcile ? { reconciliationStatus: "required" } : {}),
      ...(purge && ["content", "insights"].includes(e.kind)
        ? {
            text: "",
            body: "",
            title: "Removed source dependency",
            claims: [],
            sources: [],
            outline: [],
            description: "",
            altText: "",
            subject: "",
            previewText: "",
            summary: "",
            rationale: "",
          }
        : {}),
    });
    if (purge && ["content", "insights"].includes(e.kind))
      await tx.entityVersion.deleteMany({
        where: { ...where(s), entityId: e.id },
      });
    if (needsRemoteReconcile) {
      const idempotencyKey =
        "knowledge-reconcile:" + e.id + ":" + (e.version + 1);
      const existing = await tx.entity.findFirst({
        where: {
          ...where(s),
          kind: "jobs",
          data: { path: ["idempotencyKey"], equals: idempotencyKey },
        },
      });
      if (!existing) {
        const job = await tx.entity.create({
          data: {
            ...where(s),
            kind: "jobs",
            data: {
              topic: "reconciliation",
              resourceId: e.id,
              status: "queued",
              attempts: 0,
              maxAttempts: 3,
              idempotencyKey,
              reason,
            },
          },
        });
        await tx.outbox.create({
          data: {
            ...where(s),
            topic: "reconciliation",
            entityId: job.id,
            payload: { jobId: job.id },
          },
        });
      }
    }
  }
  return { evidenceIds: [...evidenceIds], contentIds: [...contentIds] };
}
export async function ingest(tx: DbTx, s: Scope, input: IngestInput) {
  const { data: source } = await getSource(tx, s, input.sourceId);
  const expected = input.expectedGeneration ?? source.generation;
  if (expected !== source.generation)
    throw new KnowledgeError("STALE_SOURCE_GENERATION");
  if (input.embeddings && !source.modelUse)
    throw new KnowledgeError("MODEL_USE_FORBIDDEN");
  const embeddingIndex = input.embeddings
    ? await assertActiveEmbeddingProfile(
        tx,
        s,
        input.profile ?? EMBEDDING_PROFILE,
      )
    : null;
  if (input.profile && input.profile !== EMBEDDING_PROFILE && !input.embeddings)
    throw new KnowledgeError("UNSUPPORTED_EMBEDDING_PROFILE");
  const text = normalizeText(input.text),
    chunks = chunkText(text),
    contentHash = hash(
      JSON.stringify({
        text,
        title: input.title,
        language: input.language,
        mimeType: input.mimeType,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        chunkingVersion: "structure-v1",
      }),
    );
  const now = new Date();
  const tombstones = await tx.entity.findMany({
    where: { ...where(s), kind: "revocations" },
  });
  if (
    tombstones.some((t) => {
      const d = t.data as Record<string, unknown>;
      return d.sourceId === input.sourceId && d.externalId === input.externalId;
    })
  )
    throw new KnowledgeError("DOCUMENT_REVOKED");
  if (
    (input.validFrom && !Number.isFinite(Date.parse(input.validFrom))) ||
    (input.validUntil && !Number.isFinite(Date.parse(input.validUntil))) ||
    (input.sourceUpdatedAt &&
      !Number.isFinite(Date.parse(input.sourceUpdatedAt)))
  )
    throw new KnowledgeError("INVALID_VALIDITY");
  if (
    input.validUntil &&
    new Date(input.validUntil) <= new Date(input.validFrom ?? now)
  )
    throw new KnowledgeError("INVALID_VALIDITY");
  if (input.embeddings) {
    if (input.embeddings.length !== chunks.length)
      throw new KnowledgeError("INCOMPLETE_EMBEDDINGS");
    input.embeddings.forEach((v) =>
      validateVector(v, embeddingIndex!.dimensions),
    );
  }
  let doc = await tx.knowledgeDocument.findUnique({
    where: {
      workspaceId_projectId_sourceId_externalId: {
        ...where(s),
        sourceId: input.sourceId,
        externalId: input.externalId,
      },
    },
  });
  if (doc?.activeVersionId) {
    const active = await tx.documentVersion.findFirst({
      where: { ...where(s), id: doc.activeVersionId },
    });
    if (
      active?.contentHash === contentHash &&
      active.sourceGeneration === expected
    ) {
      await tx.documentVersion.update({
        where: { id: active.id },
        data: { fetchedAt: now },
      });
      const sourceRow = await tx.entity.findFirstOrThrow({
        where: { id: input.sourceId, ...where(s) },
      });
      await tx.entity.update({
        where: { id: sourceRow.id },
        data: {
          data: json({
            ...(sourceRow.data as object),
            lastSuccessfulSyncAt: now.toISOString(),
          }),
        },
      });
      return {
        documentId: doc.id,
        versionId: active.id,
        unchanged: true,
        chunks: await tx.knowledgeChunk.count({
          where: { ...where(s), documentVersionId: active.id },
        }),
        embedded: await tx.chunkEmbedding.count({
          where: { ...where(s), chunk: { documentVersionId: active.id } },
        }),
      };
    }
  }
  if (!doc)
    doc = await tx.knowledgeDocument.create({
      data: {
        ...where(s),
        sourceId: input.sourceId,
        externalId: input.externalId,
        canonicalUrl: input.canonicalUrl,
      },
    });
  const last = await tx.documentVersion.aggregate({
    where: { ...where(s), documentId: doc.id },
    _max: { version: true },
  });
  const version = await tx.documentVersion.create({
    data: {
      ...where(s),
      documentId: doc.id,
      version: (last._max.version ?? 0) + 1,
      title: input.title,
      language: input.language,
      contentHash,
      text,
      mimeType: input.mimeType,
      extractorVersion:
        input.mimeType === "application/pdf"
          ? "pdfjs-6-process-v1"
          : input.mimeType ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ? "mammoth-1-v1"
            : "safe-text-v1",
      sourceGeneration: expected,
      sourceUpdatedAt: input.sourceUpdatedAt
        ? new Date(input.sourceUpdatedAt)
        : null,
      validFrom: input.validFrom ? new Date(input.validFrom) : now,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      state: "prepared",
    },
  });
  for (const c of chunks) {
    const chunk = await tx.knowledgeChunk.create({
      data: {
        ...where(s),
        documentVersionId: version.id,
        ...c,
        heading: c.heading ? input.title + " — " + c.heading : input.title,
        language: input.language,
      },
    });
    if (input.embeddings) {
      const vector = validateVector(
        input.embeddings[c.position]!,
        embeddingIndex!.dimensions,
      );
      await tx.$executeRaw`INSERT INTO "ChunkEmbedding" ("id","workspaceId","projectId","chunkId","profile","model","dimensions","indexGeneration","vector") VALUES (${randomUUID()}::uuid,${s.workspaceId}::uuid,${s.projectId}::uuid,${chunk.id}::uuid,${embeddingIndex!.profile},${embeddingIndex!.model},${embeddingIndex!.dimensions},${embeddingIndex!.generation},${vector}::vector)`;
    }
  }
  // Caller holds the project transaction lock; stale external jobs must carry expectedGeneration.
  const checked = await getSource(tx, s, input.sourceId);
  if (checked.data.generation !== expected)
    throw new KnowledgeError("STALE_SOURCE_GENERATION");
  if (doc.activeVersionId) {
    await tx.documentVersion.update({
      where: { id: doc.activeVersionId },
      data: { state: "superseded" },
    });
    const dependentFacts = await tx.entity.findMany({
      where: { ...where(s), kind: "facts" },
    });
    for (const fact of dependentFacts) {
      const fd = fact.data as unknown as FactData;
      if (fd.sourceId === input.sourceId && fd.status === "verified")
        await revise(tx, s, fact.id, {
          ...fd,
          status: "candidate",
          reviewReason: "source_changed",
        });
    }
  }
  await tx.documentVersion.update({
    where: { id: version.id },
    data: { state: "active" },
  });
  await tx.knowledgeDocument.update({
    where: { id: doc.id },
    data: {
      activeVersionId: version.id,
      canonicalUrl: input.canonicalUrl ?? doc.canonicalUrl,
    },
  });
  const impact = await invalidate(tx, s, input.sourceId, "source_changed");
  await tx.entity.update({
    where: { id: input.sourceId },
    data: {
      data: json({
        ...(checked.source.data as object),
        lastSuccessfulSyncAt: now.toISOString(),
      }),
    },
  });
  await audit(tx, s, "knowledge.ingested", doc.id, {
    versionId: version.id,
    chunks: chunks.length,
    embedded: Boolean(input.embeddings),
  });
  return {
    documentId: doc.id,
    versionId: version.id,
    unchanged: false,
    chunks: chunks.length,
    embedded: input.embeddings ? chunks.length : 0,
    impact,
  };
}
export async function setFact(tx: DbTx, s: Scope, input: FactInput) {
  const { data: source } = await getSource(tx, s, input.sourceId);
  if (source.authority === "generated")
    throw new KnowledgeError("GENERATED_CONTENT_NOT_AUTHORITY");
  if (
    !input.key ||
    !input.value ||
    !Number.isFinite(Date.parse(input.validFrom)) ||
    (input.validUntil &&
      new Date(input.validUntil) <= new Date(input.validFrom))
  )
    throw new KnowledgeError("INVALID_FACT");
  if (input.validUntil && !Number.isFinite(Date.parse(input.validUntil)))
    throw new KnowledgeError("INVALID_FACT");
  if (input.valueType === "decimal" && !/^-?\d+(\.\d+)?$/.test(input.value))
    throw new KnowledgeError("INVALID_DECIMAL");
  if (input.valueType === "decimal" && !input.currency && !input.unit)
    throw new KnowledgeError("FACT_UNIT_REQUIRED");
  if (
    input.valueType === "date" &&
    (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.value) ||
      !Number.isFinite(Date.parse(input.value)))
  )
    throw new KnowledgeError("INVALID_FACT_DATE");
  if (
    input.valueType === "status" &&
    !["available", "beta", "planned", "discontinued"].includes(input.value)
  )
    throw new KnowledgeError("INVALID_PRODUCT_STATUS");
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency))
    throw new KnowledgeError("INVALID_CURRENCY");
  if (
    (input.publicUse && !source.publicUse) ||
    (input.modelUse && !source.modelUse)
  )
    throw new KnowledgeError("FACT_RIGHTS_EXCEED_SOURCE");
  const all = await tx.entity.findMany({
    where: { ...where(s), kind: "facts" },
  });
  const peers = all.filter((f) => {
    const d = f.data as unknown as FactData;
    return (
      f.id !== input.id &&
      d.key === input.key &&
      d.language === input.language &&
      (d.market ?? "global") === (input.market ?? "global") &&
      ["verified", "conflicting"].includes(d.status) &&
      overlap(d, input)
    );
  });
  const replacing = new Set(input.resolveConflictIds ?? []);
  if (input.resolveConflictIds !== undefined) {
    if (
      input.status !== "verified" ||
      replacing.size === 0 ||
      replacing.size > 50 ||
      replacing.size !== input.resolveConflictIds.length ||
      replacing.size !== peers.length ||
      !peers.every((f) => replacing.has(f.id)) ||
      (input.supersedesId && !replacing.has(input.supersedesId))
    )
      throw new KnowledgeError("INCOMPLETE_CONFLICT_RESOLUTION");
  }
  if (input.supersedesId) replacing.add(input.supersedesId);
  const conflicts = peers.filter(
    (f) =>
      !replacing.has(f.id) &&
      (f.data as unknown as FactData).value !== input.value,
  );
  for (const id of replacing) {
    const old = all.find((f) => f.id === id);
    if (!old) throw new KnowledgeError("FACT_NOT_FOUND");
    const prior = old.data as unknown as FactData;
    if (
      old.id === input.id ||
      old.id === input.id ||
      prior.key !== input.key ||
      prior.language !== input.language ||
      (prior.market ?? "global") !== (input.market ?? "global")
    )
      throw new KnowledgeError("INVALID_SUPERSESSION");
    await revise(tx, s, old.id, { ...prior, status: "superseded" });
    await invalidate(tx, s, prior.sourceId, "fact_superseded", old.id);
  }
  const data = {
    ...input,
    status: conflicts.length ? "conflicting" : input.status,
    verifiedAt: input.status === "verified" ? new Date().toISOString() : null,
    verifiedBy: input.status === "verified" ? s.userId : null,
    recordedAt: new Date().toISOString(),
    sourceGeneration: source.generation,
  };
  for (const old of conflicts) {
    await revise(tx, s, old.id, {
      ...(old.data as object),
      status: "conflicting",
    });
    await invalidate(
      tx,
      s,
      (old.data as unknown as FactData).sourceId,
      "fact_conflict",
      old.id,
    );
  }
  if (input.id && !all.some((f) => f.id === input.id))
    throw new KnowledgeError("FACT_NOT_FOUND");
  const fact = input.id
    ? await revise(tx, s, input.id, data)
    : await tx.entity.create({
        data: { ...where(s), kind: "facts", data: json(data) },
      });
  await invalidate(tx, s, input.sourceId, "fact_changed", fact.id);
  await audit(tx, s, "fact.versioned", fact.id, {
    version: fact.version,
    status: data.status,
  });
  return fact;
}
type Candidate = {
  id: string;
  documentVersionId: string;
  sourceId: string;
  sourceGeneration: number;
  authority: string;
  title: string;
  text: string;
  heading: string;
  anchor: string;
  canonicalUrl: string | null;
  chunkHash: string;
  fetchedAt: Date;
  validUntil: Date | null;
  publicUse: boolean;
  modelUse: boolean;
  rank: number;
};
export async function retrieve(tx: DbTx, s: Scope, input: RetrieveInput) {
  const start = performance.now(),
    at = new Date(input.at ?? Date.now());
  if (
    !Number.isFinite(at.getTime()) ||
    !input.query.trim() ||
    input.query.length > 2000
  )
    throw new KnowledgeError("INVALID_QUERY");
  const activeIndex =
    input.queryVector || input.profile
      ? await assertActiveEmbeddingProfile(
          tx,
          s,
          input.profile ?? EMBEDDING_PROFILE,
        )
      : await getActiveIndex(tx, s);
  const language = input.language ?? "en",
    config = language === "de" ? "german" : "english",
    profile = activeIndex.profile;
  const forModel = input.forModel ?? false;
  const sources = await tx.entity.findMany({
    where: { ...where(s), kind: "sources" },
  });
  const allowed = new Map<string, SourceData>();
  const excluded: EvidenceData["excluded"] = [];
  for (const source of sources) {
    if (input.sourceIds?.length && !input.sourceIds.includes(source.id))
      continue;
    try {
      const d = sourceData(source.data);
      if (d.authority === "generated")
        throw new KnowledgeError("generated_derived");
      if (
        input.purpose === "public" &&
        (!d.publicUse || (d.embargoUntil && new Date(d.embargoUntil) > at))
      )
        throw new KnowledgeError("public_use_forbidden");
      if (forModel && !d.modelUse)
        throw new KnowledgeError("model_use_forbidden");
      allowed.set(source.id, d);
    } catch (e) {
      excluded.push({
        sourceId: source.id,
        reason: e instanceof KnowledgeError ? e.code : "source_unavailable",
      });
    }
  }
  const gaps: string[] = [];
  for (const id of input.sourceIds ?? [])
    if (!allowed.has(id)) gaps.push("required_source_unavailable:" + id);
  const factRows = await tx.entity.findMany({
    where: { ...where(s), kind: "facts" },
  });
  const facts: EvidenceFact[] = [];
  for (const f of factRows) {
    const d = f.data as unknown as FactData;
    if (
      !allowed.has(d.sourceId) ||
      d.language !== language ||
      (d.market ?? "global") !== (input.market ?? "global") ||
      !validAt(d.validFrom, d.validUntil, at)
    )
      continue;
    const relevant = input.factKeys?.length
      ? input.factKeys.includes(d.key)
      : input.query.toLowerCase().includes(d.key.toLowerCase()) ||
        d.key
          .toLowerCase()
          .split(/[._-]/)
          .some((k) => k.length >= 3 && input.query.toLowerCase().includes(k));
    if (!relevant) continue;
    if (
      d.sourceGeneration !== allowed.get(d.sourceId)!.generation ||
      (input.purpose === "public" && !d.publicUse) ||
      (forModel && !d.modelUse)
    )
      continue;
    if (d.status === "conflicting") {
      gaps.push("conflicting_fact:" + d.key);
      continue;
    }
    if (d.status !== "verified") continue;
    if (tokenEstimate(JSON.stringify(facts)) + tokenEstimate(d.value) > 2000) {
      gaps.push("fact_context_limit");
      continue;
    }
    facts.push({
      id: f.id,
      version: f.version,
      key: d.key,
      value: d.value,
      valueType: d.valueType,
      currency: d.currency,
      unit: d.unit,
      sourceId: d.sourceId,
      sourceGeneration: d.sourceGeneration,
      validFrom: d.validFrom,
      validUntil: d.validUntil,
      publicUse: d.publicUse,
      modelUse: d.modelUse,
    });
  }
  for (const key of input.factKeys ?? [])
    if (!facts.some((f) => f.key === key)) gaps.push("missing_fact:" + key);
  const versions = await tx.documentVersion.findMany({
    where: { ...where(s), state: "active" },
    select: {
      id: true,
      fetchedAt: true,
      validFrom: true,
      validUntil: true,
      document: { select: { sourceId: true } },
    },
    take: 500,
  });
  for (const v of versions) {
    const policy = allowed.get(v.document.sourceId);
    if (!policy) continue;
    if (v.fetchedAt.getTime() + policy.maxAgeHours * 3600000 <= at.getTime())
      excluded.push({
        sourceId: v.document.sourceId,
        reason: "stale_document:" + v.id,
      });
    else if (!validAt(v.validFrom, v.validUntil, at))
      excluded.push({
        sourceId: v.document.sourceId,
        reason: "document_outside_validity:" + v.id,
      });
  }
  const sourceFilter = input.sourceIds?.length
    ? Prisma.sql`AND s.id IN (${Prisma.join(input.sourceIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const eligible = Prisma.sql`FROM "KnowledgeChunk" c JOIN "DocumentVersion" v ON v.id=c."documentVersionId" AND v."workspaceId"=c."workspaceId" AND v."projectId"=c."projectId" JOIN "KnowledgeDocument" d ON d.id=v."documentId" AND d."workspaceId"=v."workspaceId" AND d."projectId"=v."projectId" JOIN "Entity" s ON s.id=d."sourceId" AND s."workspaceId"=d."workspaceId" AND s."projectId"=d."projectId" WHERE c."workspaceId"=${s.workspaceId}::uuid AND c."projectId"=${s.projectId}::uuid ${sourceFilter} AND s.kind='sources' AND s.data->>'status'='active' AND s.data->>'authority' IN ('official','website','research') AND v.state='active' AND d."activeVersionId"=v.id AND v."sourceGeneration"=(s.data->>'generation')::int AND v."validFrom"<=${at} AND (v."validUntil" IS NULL OR v."validUntil">${at}) AND v."fetchedAt"+((s.data->>'maxAgeHours')::double precision*interval '1 hour')>${at} AND c.language=${language} AND (${input.purpose !== "public"} OR (s.data->>'publicUse'='true' AND (s.data->>'embargoUntil' IS NULL OR (s.data->>'embargoUntil')::timestamptz<=${at}))) AND (${!forModel} OR s.data->>'modelUse'='true')`;
  const columns = Prisma.sql`c.id,c."documentVersionId",d."sourceId",v."sourceGeneration",s.data->>'authority' AS authority,v.title,c.text,c.heading,c.anchor,d."canonicalUrl",c."chunkHash",v."fetchedAt",v."validUntil",(s.data->>'publicUse'='true') AS "publicUse",(s.data->>'modelUse'='true') AS "modelUse"`;
  const lexical = await tx.$queryRaw<Candidate[]>(
    Prisma.sql`SELECT ${columns},ts_rank_cd(c."searchVector",websearch_to_tsquery(${config}::regconfig,${input.query}))+ts_rank_cd(c."identifierVector",websearch_to_tsquery('simple',${input.query})) AS rank ${eligible} AND (c."searchVector" @@ websearch_to_tsquery(${config}::regconfig,${input.query}) OR c."identifierVector" @@ websearch_to_tsquery('simple',${input.query}) OR position(lower(${input.query}) in lower(c.text))>0) ORDER BY CASE s.data->>'authority' WHEN 'official' THEN 0 WHEN 'website' THEN 1 ELSE 2 END,rank DESC,c.id LIMIT ${LIMITS.candidates}`,
  );
  let semantic: Candidate[] = [];
  if (input.queryVector) {
    const vector = validateVector(input.queryVector, activeIndex.dimensions);
    semantic = await tx.$queryRaw<Candidate[]>(
      Prisma.sql`WITH compatible AS MATERIALIZED (SELECT "chunkId",vector FROM "ChunkEmbedding" WHERE "workspaceId"=${s.workspaceId}::uuid AND "projectId"=${s.projectId}::uuid AND profile=${profile} AND dimensions=${activeIndex.dimensions} AND "indexGeneration"=${activeIndex.generation}) SELECT ${columns},(SELECT 1-(e.vector <=> ${vector}::vector) FROM compatible e WHERE e."chunkId"=c.id LIMIT 1) AS rank ${eligible} AND EXISTS(SELECT 1 FROM compatible e WHERE e."chunkId"=c.id) ORDER BY CASE s.data->>'authority' WHEN 'official' THEN 0 WHEN 'website' THEN 1 ELSE 2 END,rank DESC,c.id LIMIT ${LIMITS.candidates}`,
    );
  }
  const priority: Record<string, number> = {
    official: 0,
    website: 1,
    research: 2,
  };
  const fused = rrf(lexical, semantic, LIMITS.candidates * 2).sort(
    (a, b) =>
      (priority[a.authority] ?? 9) - (priority[b.authority] ?? 9) ||
      b.score - a.score ||
      a.id.localeCompare(b.id),
  );
  const selected = diverseContext(
    fused,
    Math.min(input.topK ?? LIMITS.topK, 10),
    LIMITS.contextTokens - tokenEstimate(JSON.stringify(facts)),
  );
  const items: EvidenceItem[] = selected.map((c) => ({
    chunkId: c.id,
    documentVersionId: c.documentVersionId,
    sourceId: c.sourceId,
    sourceGeneration: c.sourceGeneration,
    authority: c.authority,
    title: c.title,
    text: c.text,
    anchor: c.anchor,
    canonicalUrl: safeCitation(c.canonicalUrl),
    score: c.score,
    reasons: c.reasons,
    publicUse: c.publicUse,
    modelUse: c.modelUse,
    fetchedAt: c.fetchedAt.toISOString(),
    validUntil: c.validUntil?.toISOString() ?? null,
  }));
  if (!facts.length && !items.length) gaps.push("insufficient_evidence");
  const project = await tx.project.findFirstOrThrow({
    where: { workspaceId: s.workspaceId, id: s.projectId },
  });
  const data: EvidenceData = {
    status: gaps.length ? "insufficient_evidence" : "ready",
    purpose: input.purpose,
    forModel,
    query: input.query,
    language,
    at: at.toISOString(),
    createdAt: new Date().toISOString(),
    generation: project.generation,
    retrieverVersion: RETRIEVER_VERSION,
    indexProfile: profile,
    indexId: activeIndex.id,
    indexGeneration: activeIndex.generation,
    mode: input.queryVector ? "hybrid" : "lexical_degraded",
    facts,
    items,
    gaps: [...new Set(gaps)],
    excluded,
    hash: "",
    durationMs: Math.round(performance.now() - start),
    estimatedTokens:
      tokenEstimate(items.map((c) => c.text).join("\n")) +
      tokenEstimate(JSON.stringify(facts)),
  };
  data.hash = hash(JSON.stringify({ ...data, durationMs: undefined }));
  return tx.entity.create({
    data: { ...where(s), kind: "evidence", data: json(data) },
  });
}
export function safeCitation(value: string | null) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
export async function validateEvidence(
  tx: DbTx,
  s: Scope,
  evidenceId: string,
  at: Date | string = new Date(),
) {
  const e = await tx.entity.findFirst({
    where: { ...where(s), id: evidenceId, kind: "evidence" },
  });
  if (!e) return { valid: false, reasons: ["evidence_unavailable"] };
  const d = e.data as unknown as EvidenceData;
  const reasons: string[] = [];
  const point = new Date(at);
  if (d.indexId && (await getActiveIndex(tx, s)).id !== d.indexId)
    reasons.push("index_generation_changed");
  if (d.status !== "ready" || d.purpose !== "public")
    reasons.push("evidence_not_public_ready");
  const all = [...d.facts, ...d.items];
  if (!all.length) reasons.push("insufficient_evidence");
  for (const item of all) {
    try {
      const { data: source } = await getSource(tx, s, item.sourceId);
      if (
        !source.publicUse ||
        (d.forModel && !source.modelUse) ||
        source.generation !== item.sourceGeneration ||
        (source.embargoUntil && new Date(source.embargoUntil) > point)
      )
        reasons.push("source_rights_changed");
    } catch {
      reasons.push("source_unavailable");
    }
  }
  for (const fact of d.facts) {
    const f = await tx.entity.findFirst({
      where: { ...where(s), id: fact.id, kind: "facts" },
    });
    const data = f?.data as unknown as FactData | undefined;
    if (
      !f ||
      f.version !== fact.version ||
      data?.status !== "verified" ||
      !data.publicUse ||
      (d.forModel && !data.modelUse) ||
      !validAt(data.validFrom, data.validUntil, point)
    )
      reasons.push("fact_changed_or_expired");
  }
  for (const item of d.items) {
    const v = await tx.documentVersion.findFirst({
      where: { ...where(s), id: item.documentVersionId, state: "active" },
      include: { document: true },
    });
    if (
      !v ||
      v.document.activeVersionId !== v.id ||
      !validAt(v.validFrom, v.validUntil, point)
    ) {
      reasons.push("document_changed_or_expired");
      continue;
    }
    const source = await tx.entity.findFirst({
      where: { ...where(s), id: item.sourceId, kind: "sources" },
    });
    const maxAge = (source?.data as unknown as SourceData)?.maxAgeHours ?? 0;
    if (v.fetchedAt.getTime() + maxAge * 3600000 <= point.getTime())
      reasons.push("source_stale");
    const chunk = await tx.knowledgeChunk.findFirst({
      where: { ...where(s), id: item.chunkId, documentVersionId: v.id },
    });
    if (!chunk) reasons.push("chunk_unavailable");
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}
export async function withdrawFact(
  tx: DbTx,
  s: Scope,
  id: string,
  expectedVersion: number,
) {
  const fact = await tx.entity.findFirst({
    where: { ...where(s), id, kind: "facts" },
  });
  if (!fact) throw new KnowledgeError("FACT_NOT_FOUND");
  if (fact.version !== expectedVersion)
    throw new KnowledgeError("VERSION_CONFLICT");
  const d = fact.data as unknown as FactData;
  if (d.status === "revoked")
    return {
      fact,
      unchanged: true,
      impact: { evidenceIds: [], contentIds: [] },
    };
  const revoked = await revise(tx, s, id, {
    ...d,
    status: "revoked",
    revokedAt: new Date().toISOString(),
    revokedBy: s.userId,
  });
  const impact = await invalidate(tx, s, d.sourceId, "fact_revoked", id);
  await audit(tx, s, "fact.withdrawn", id, { version: revoked.version });
  return { fact: revoked, unchanged: false, impact };
}
export async function revokeSource(tx: DbTx, s: Scope, sourceId: string) {
  const source = await tx.entity.findFirst({
    where: { ...where(s), id: sourceId, kind: "sources" },
  });
  if (!source) throw new KnowledgeError("SOURCE_UNAVAILABLE");
  const d = source.data as unknown as SourceData;
  if (d.status === "revoked") return { revoked: true, unchanged: true };
  await revise(tx, s, sourceId, {
    ...d,
    status: "revoked",
    generation: d.generation + 1,
    revokedAt: new Date().toISOString(),
    publicUse: false,
    modelUse: false,
  });
  const impact = await invalidate(
    tx,
    s,
    sourceId,
    "source_revoked",
    undefined,
    true,
  );
  const facts = await tx.entity.findMany({
    where: { ...where(s), kind: "facts" },
  });
  for (const f of facts) {
    if ((f.data as unknown as FactData).sourceId === sourceId) {
      await revise(tx, s, f.id, {
        sourceId,
        status: "revoked",
        value: "[removed]",
        key: (f.data as unknown as FactData).key,
      });
      await tx.entityVersion.deleteMany({
        where: { ...where(s), entityId: f.id },
      });
    }
  }
  const removed = await tx.knowledgeDocument.deleteMany({
    where: { ...where(s), sourceId },
  });
  await audit(tx, s, "knowledge.revoked", sourceId, {
    generation: d.generation + 1,
    documentsRemoved: removed.count,
  });
  return { revoked: true, documentsRemoved: removed.count, impact };
}
export async function setSourceRights(
  tx: DbTx,
  s: Scope,
  id: string,
  changes: { publicUse?: boolean; modelUse?: boolean; paused?: boolean },
) {
  const source = await tx.entity.findFirst({
    where: { ...where(s), id, kind: "sources" },
  });
  if (!source) throw new KnowledgeError("SOURCE_UNAVAILABLE");
  const old = source.data as unknown as SourceData;
  if (old.status === "revoked") throw new KnowledgeError("SOURCE_REVOKED");
  const next = {
    ...old,
    ...(changes.publicUse === undefined
      ? {}
      : { publicUse: changes.publicUse }),
    ...(changes.modelUse === undefined ? {} : { modelUse: changes.modelUse }),
    status:
      changes.paused === undefined
        ? old.status
        : changes.paused
          ? "paused"
          : "active",
    generation: old.generation + 1,
  };
  await revise(tx, s, id, next);
  const impact = await invalidate(tx, s, id, "source_permissions_changed");
  await audit(tx, s, "knowledge.rights_changed", id, {
    generation: next.generation,
  });
  return {
    sourceId: id,
    generation: next.generation,
    impact,
    reindexRequired: true,
  };
}
export async function revokeDocument(
  tx: DbTx,
  s: Scope,
  documentId: string,
  versionId?: string,
) {
  const document = await tx.knowledgeDocument.findFirst({
    where: { ...where(s), id: documentId },
  });
  if (!document) throw new KnowledgeError("DOCUMENT_UNAVAILABLE");
  if (
    versionId &&
    !(await tx.documentVersion.findFirst({
      where: { ...where(s), id: versionId, documentId },
    }))
  )
    throw new KnowledgeError("DOCUMENT_UNAVAILABLE");
  // Fence all previously prepared work for the source, including duplicate outbox deliveries.
  const source = await tx.entity.findFirstOrThrow({
    where: { ...where(s), id: document.sourceId, kind: "sources" },
  });
  const d = source.data as unknown as SourceData;
  await revise(tx, s, source.id, { ...d, generation: d.generation + 1 });
  const impact = await invalidate(
    tx,
    s,
    source.id,
    "document_revoked",
    undefined,
    true,
  );
  if (versionId) {
    if (document.activeVersionId === versionId)
      await tx.knowledgeDocument.update({
        where: { id: documentId },
        data: { activeVersionId: null },
      });
    await tx.documentVersion.delete({ where: { id: versionId } });
  } else await tx.knowledgeDocument.delete({ where: { id: documentId } });
  const tombstone = await tx.entity.create({
    data: {
      ...where(s),
      kind: "revocations",
      data: {
        sourceId: source.id,
        externalId: document.externalId,
        documentId,
        versionId: versionId ?? null,
        generation: d.generation + 1,
        revokedAt: new Date().toISOString(),
        reason: "owner_document_revocation",
      },
    },
  });
  await audit(tx, s, "knowledge.document_revoked", documentId, {
    versionId: versionId ?? null,
    tombstoneId: tombstone.id,
  });
  return { revoked: true, impact, tombstoneId: tombstone.id };
}
export async function attachEmbeddings(
  tx: DbTx,
  s: Scope,
  input: {
    sourceId: string;
    versionId: string;
    expectedGeneration: number;
    profile: string;
    vectors: { chunkId: string; vector: number[] }[];
  },
) {
  const { data: source } = await getSource(tx, s, input.sourceId);
  if (!source.modelUse) throw new KnowledgeError("MODEL_USE_FORBIDDEN");
  if (source.generation !== input.expectedGeneration)
    throw new KnowledgeError("STALE_SOURCE_GENERATION");
  const activeIndex = await assertActiveEmbeddingProfile(tx, s, input.profile);
  const version = await tx.documentVersion.findFirst({
    where: {
      ...where(s),
      id: input.versionId,
      state: "active",
      sourceGeneration: source.generation,
    },
    include: { document: true, chunks: true },
  });
  if (
    !version ||
    version.document.sourceId !== input.sourceId ||
    version.document.activeVersionId !== version.id
  )
    throw new KnowledgeError("STALE_DOCUMENT_VERSION");
  if (
    input.vectors.length !== version.chunks.length ||
    new Set(input.vectors.map((v) => v.chunkId)).size !== version.chunks.length
  )
    throw new KnowledgeError("INCOMPLETE_EMBEDDINGS");
  for (const item of input.vectors) {
    if (!version.chunks.some((c) => c.id === item.chunkId))
      throw new KnowledgeError("CHUNK_UNAVAILABLE");
    const vector = validateVector(item.vector, activeIndex.dimensions);
    await tx.$executeRaw`INSERT INTO "ChunkEmbedding" ("id","workspaceId","projectId","chunkId","profile","model","dimensions","indexGeneration","vector") VALUES (${randomUUID()}::uuid,${s.workspaceId}::uuid,${s.projectId}::uuid,${item.chunkId}::uuid,${activeIndex.profile},${activeIndex.model},${activeIndex.dimensions},${activeIndex.generation},${vector}::vector) ON CONFLICT ("chunkId","profile","indexGeneration") DO NOTHING`;
  }
  await audit(tx, s, "knowledge.embedded", version.id, {
    profile: input.profile,
    chunks: input.vectors.length,
  });
  return { embedded: input.vectors.length };
}

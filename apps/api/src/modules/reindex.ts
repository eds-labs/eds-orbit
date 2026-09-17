import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { policy } from "../../../../packages/schemas/src/index.ts";
import {
  attachIndexBatch,
  sourceData,
  assertIndexCorpusCurrent,
} from "../../../../packages/knowledge/src/index.ts";
import { embed, estimateCost } from "../../../../packages/ai/src/index.ts";
import { reserve, markTransmitted, settle } from "./budget.ts";
import { activePolicy } from "./policy.ts";
import { enqueue } from "./workflow.ts";
import { data, entity, DomainError } from "../shared.ts";
/** One bounded batch per durable job. It never activates its own index. */
export async function buildIndexBatch(
  scope: Scope,
  indexId: string,
  jobId: string,
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const index = await assertIndexCorpusCurrent(tx, scope, indexId);
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) throw new DomainError("PROJECT_PAUSED");
      const existing = await tx.chunkEmbedding.findMany({
        where: {
          projectId: scope.projectId,
          profile: index.profile,
          indexGeneration: index.generation,
        },
        select: { chunkId: true },
      });
      const stored = new Set(existing.map((c) => c.chunkId));
      const manifest = index.manifest as unknown as {
        chunkId: string;
        versionId: string;
        sourceId: string;
        sourceGeneration: number;
        chunkHash: string;
      }[];
      const batch = manifest.filter((c) => !stored.has(c.chunkId)).slice(0, 32);
      if (!batch.length) return null;
      const texts: string[] = [];
      for (const item of batch) {
        const source = await entity(tx, scope, "sources", item.sourceId),
          s = sourceData(source.data);
        if (!s.modelUse || s.generation !== item.sourceGeneration)
          throw new DomainError("INDEX_SOURCE_RIGHTS_CHANGED");
        const chunk = await tx.knowledgeChunk.findFirst({
          where: {
            id: item.chunkId,
            projectId: scope.projectId,
            documentVersionId: item.versionId,
            chunkHash: item.chunkHash,
          },
        });
        if (!chunk) throw new DomainError("INDEX_CORPUS_CHANGED");
        texts.push(chunk.text);
      }
      const p = await activePolicy(tx, scope);
      if (!p) throw new DomainError("POLICY_REQUIRED");
      const approved = policy.parse(
        Object.fromEntries(
          Object.entries(data(p)).filter(
            ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
          ),
        ),
      );
      const amount = estimateCost(
        index.model,
        texts.reduce((n, t) => n + Buffer.byteLength(t), 0),
        0,
      );
      const reservation = await reserve(
        tx,
        scope,
        `index:${indexId}:build:${jobId}`,
        "reindex",
        amount,
        approved,
        new Date(),
        `index:${indexId}:build`,
      );
      return {
        index,
        batch,
        texts,
        projectGeneration: project.generation,
        reservationId: reservation.id,
        policyId: p.id,
        policyVersion: p.version,
      };
    },
  );
  if (!prepared) return { complete: true };
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
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
      throw new DomainError("PAID_MANDATE_CHANGED");
    await assertIndexCorpusCurrent(tx, scope, indexId);
    for (const item of prepared.batch) {
      const source = sourceData(
        (await entity(tx, scope, "sources", item.sourceId)).data,
      );
      if (!source.modelUse || source.generation !== item.sourceGeneration)
        throw new DomainError("INDEX_SOURCE_RIGHTS_CHANGED");
    }
    await markTransmitted(tx, scope, prepared.reservationId);
  });
  let output: Awaited<ReturnType<typeof embed>>;
  try {
    output = await embed(prepared.texts, prepared.reservationId, true, {
      model: prepared.index.model,
      dimensions: prepared.index.dimensions,
    });
  } catch {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      settle(tx, scope, prepared.reservationId, null),
    );
    throw new DomainError("REINDEX_COST_UNKNOWN");
  }
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    settle(tx, scope, prepared.reservationId, output.usage.costMicros),
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
      throw new DomainError("PAID_MANDATE_CHANGED");
    const result = await attachIndexBatch(
      tx,
      scope,
      indexId,
      prepared.batch.map((c, i) => ({
        chunkId: c.chunkId,
        vector: output.vectors[i]!,
      })),
    );
    if (result.stored < result.total)
      await enqueue(
        tx,
        scope,
        "reindex",
        indexId,
        `reindex:${indexId}:${result.stored}`,
      );
    return result;
  });
}

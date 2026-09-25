import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import { policy, type Scope } from "../../../../packages/schemas/src/index.ts";
import {
  assertIndexCorpusCurrent,
  evaluateIndexGeneration,
} from "../../../../packages/knowledge/src/index.ts";
import { embed, estimateCost } from "../../../../packages/ai/src/index.ts";
import { create, data, entity, update, DomainError } from "../shared.ts";
import { activePolicy } from "./policy.ts";
import { reserve, markTransmitted, settle } from "./budget.ts";
import { enqueue } from "./workflow.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
export const indexEvaluationRequest = z
  .object({
    indexId: z.uuid(),
    datasetVersion: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9._-]+$/),
    confirmQueriesMayBeSentToOpenAI: z.literal(true),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            query: z.string().min(1).max(2000),
            expectedChunkIds: z.array(z.string()).max(100),
            forbiddenChunkIds: z.array(z.string()).max(100).default([]),
            language: z.enum(["en", "de"]).default("en"),
            purpose: z.enum(["public", "internal"]).default("public"),
            at: z.iso.datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .min(60)
      .max(120),
  })
  .strict();
export async function queueIndexEvaluation(
  tx: DbTx,
  s: Scope,
  raw: z.input<typeof indexEvaluationRequest>,
) {
  if (s.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = indexEvaluationRequest.parse(raw);
  if (
    new Set(input.cases.map((c) => c.id)).size !== input.cases.length ||
    input.cases.filter((c) => c.expectedChunkIds.length).length < 48 ||
    input.cases.filter(
      (c) => !c.expectedChunkIds.length && c.forbiddenChunkIds.length,
    ).length < 12
  )
    throw new DomainError("EVALUATION_CASE_COVERAGE_REQUIRED");
  const index = await assertIndexCorpusCurrent(tx, s, input.indexId);
  const manifest = index.manifest as unknown as { chunkId: string }[];
  if (
    (await tx.chunkEmbedding.count({
      where: {
        projectId: s.projectId,
        profile: index.profile,
        indexGeneration: index.generation,
      },
    })) !== manifest.length
  )
    throw new DomainError("INDEX_BUILD_INCOMPLETE");
  for (const c of input.cases)
    for (const id of c.expectedChunkIds)
      if (!manifest.some((m) => m.chunkId === id))
        throw new DomainError("EXPECTED_CHUNK_NOT_IN_INDEX");
  const request = await create(tx, s, "index_evaluations", {
    ...input,
    status: "queued",
    batch: 0,
    budgetReservationIds: [],
    results: [],
    createdBy: s.userId,
  });
  return enqueue(
    tx,
    s,
    "index_evaluation",
    request.id,
    "index-evaluation:" + request.id + ":0",
  );
}
/** At most 32 authorized queries per durable job; retries reuse results, never a paid reservation. */
export async function runIndexEvaluation(
  s: Scope,
  requestId: string,
  jobId: string,
) {
  const run = <T>(f: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, f);
  const prepared = await run(async (tx) => {
    const request = await entity(tx, s, "index_evaluations", requestId),
      r = data(request);
    if (r.status === "completed") return null;
    const index = await assertIndexCorpusCurrent(tx, s, r.indexId);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: s.projectId },
    });
    if (project.paused) throw new DomainError("PROJECT_PAUSED");
    const p = await activePolicy(tx, s);
    if (!p) throw new DomainError("POLICY_REQUIRED");
    const approved = policy.parse(
      Object.fromEntries(
        Object.entries(data(p)).filter(
          ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
        ),
      ),
    );
    const cases = r.cases.slice(r.batch * 32, (r.batch + 1) * 32);
    if (!cases.length) throw new DomainError("EVALUATION_BATCH_INVALID");
    const ai = await runtimeOpenAiConfiguration(tx, s);
    const amount = estimateCost(
      index.model,
      cases.reduce((n: number, c: any) => n + Buffer.byteLength(c.query), 0),
      0,
      ai,
    );
    const reservation = await reserve(
      tx,
      s,
      `index:${index.id}:evaluation:${r.datasetVersion}:${jobId}`,
      "reindex_evaluation",
      amount,
      approved,
      new Date(),
      `index-evaluation:${requestId}`,
    );
    await markTransmitted(tx, s, reservation.id);
    return {
      request,
      index,
      cases,
      projectGeneration: project.generation,
      policyId: p.id,
      policyVersion: p.version,
      reservationId: reservation.id,
      ai,
    };
  });
  if (!prepared) return { unchanged: true };
  let response: Awaited<ReturnType<typeof embed>>;
  try {
    response = await embed(
      prepared.cases.map((c: any) => c.query),
      prepared.reservationId,
      true,
      { model: prepared.index.model, dimensions: prepared.index.dimensions },
      prepared.ai,
    );
  } catch {
    await run((tx) => settle(tx, s, prepared.reservationId, null));
    throw new DomainError("INDEX_EVALUATION_COST_UNKNOWN");
  }
  await run((tx) =>
    settle(tx, s, prepared.reservationId, response.usage.costMicros),
  );
  return run(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
        where: { id: s.projectId },
      }),
      p = await activePolicy(tx, s);
    if (
      project.paused ||
      project.generation !== prepared.projectGeneration ||
      p?.id !== prepared.policyId ||
      p.version !== prepared.policyVersion ||
      Date.now() < Date.parse(data(p).startAt) ||
      Date.now() >= Date.parse(data(p).endAt)
    )
      throw new DomainError("INDEX_EVALUATION_POLICY_CHANGED");
    await assertIndexCorpusCurrent(tx, s, prepared.index.id);
    const request = await entity(tx, s, "index_evaluations", requestId);
    if (request.version !== prepared.request.version)
      throw new DomainError("EVALUATION_REQUEST_CHANGED");
    const r = data(request),
      results = [
        ...r.results,
        ...prepared.cases.map((c: any, i: number) => ({
          id: c.id,
          expectedChunkIds: c.expectedChunkIds,
          forbiddenChunkIds: c.forbiddenChunkIds,
          language: c.language,
          purpose: c.purpose,
          at: c.at,
          queryVector: response.vectors[i],
        })),
      ],
      budgetReservationIds = [
        ...r.budgetReservationIds,
        prepared.reservationId,
      ];
    if (results.length < r.cases.length) {
      await update(tx, s, request, {
        ...r,
        batch: r.batch + 1,
        results,
        budgetReservationIds,
        status: "running",
      });
      return enqueue(
        tx,
        s,
        "index_evaluation",
        request.id,
        `index-evaluation:${request.id}:${r.batch + 1}`,
      );
    }
    const builds = await tx.budgetReservation.findMany({
      where: {
        projectId: s.projectId,
        state: "settled",
        category: "reindex",
        key: {
          startsWith: s.projectId + ":index:" + prepared.index.id + ":build:",
        },
      },
      select: { id: true },
    });
    const evaluation = await evaluateIndexGeneration(tx, s, prepared.index.id, {
      datasetVersion: r.datasetVersion,
      provenance: "live",
      budgetReservationIds: [
        ...budgetReservationIds,
        ...builds.map((b) => b.id),
      ],
      cases: results.map((c: any) => ({
        ...c,
        at: c.at ? new Date(c.at) : undefined,
      })),
    });
    return update(tx, s, request, {
      ...r,
      status: "completed",
      results: [],
      budgetReservationIds,
      evaluation,
      completedAt: new Date().toISOString(),
    });
  });
}

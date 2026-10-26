import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  assertIndexCorpusCurrent,
  describeIndexGenerations,
  KnowledgeError,
  sourceData,
} from "../../../../../packages/knowledge/src/index.ts";
import {
  estimateCost,
  resolveRoute,
} from "../../../../../packages/ai/src/index.ts";
import { create, data, DomainError, entity, list, update } from "../shared.ts";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { runStructured } from "../agents/structured-run.ts";
import { runtimeOpenAiConfiguration } from "../ai/openai-configuration.ts";
import { assertEvaluationCases } from "./index-evaluation.ts";

// Orbit writes the test questions of a live index evaluation itself, so an
// owner never has to supply chunk ids. One model run per batch of passages
// asks for questions each passage answers; the negative cases need no model:
// an internal passage must never be found by a public question, otherwise a
// question in another language must not find its passage. The owner reviews
// the set, may drop questions, and starts the normal paid evaluation. The
// set is an `index_evaluations` record with `origin: "generated"`:
// generating → review → queued/running/completed (the evaluation), or failed.

export const EVALUATION_SET_QUEUE = "index_evaluation_set";
const TASK_CLASS = "knowledge_evaluation" as const;
const PASSAGES_PER_BATCH = 15;
const MAX_POSITIVES = 100;
const MAX_NEGATIVES = 20;
const MIN_POSITIVES = 48;
const MIN_NEGATIVES = 12;
// Passage text sent to the model, per passage.
const PASSAGE_CHARS = 1500;
// Fixed request part: instructions, schema and the passage wrapper.
const REQUEST_OVERHEAD_BYTES = 3000;
const LIMITS = {
  maxModelCalls: 1,
  maxToolCalls: 0,
  maxWebSearches: 0,
  timeoutMs: 150_000,
  maxInputBytes: 64_000,
};
export const EVALUATION_SET_INSTRUCTIONS =
  'Write test questions for a retrieval evaluation of this project\'s knowledge. For each numbered passage, write exactly the requested number of different questions that a member of the project could ask and that this passage answers. Write each question in the passage\'s language. Paraphrase: do not copy sentences, headings or rare identifiers from the passage, and never include the answer. Each question has at most 200 characters. Return {"questions":[{"passage":<number>,"question":"..."}]}.';

const questionsOutput = z
  .object({
    questions: z
      .array(
        z.object({ passage: z.number().int(), question: z.string() }).strict(),
      )
      .max(PASSAGES_PER_BATCH * 3),
  })
  .strict();

export type Passage = {
  chunkId: string;
  title: string;
  heading: string;
  text: string;
  language: string;
  /** Found by public questions now (public use, no embargo). */
  publicEligible: boolean;
};
export type GeneratedQuestion = { chunkId: string; question: string };
export type EvaluationCase = {
  id: string;
  query: string;
  expectedChunkIds: string[];
  forbiddenChunkIds: string[];
  language: string;
  purpose: "public" | "internal";
};
export type CaseKind = "positive" | "public_leak" | "language";

/** Passages to ask about, spread evenly over the corpus, and questions per passage. */
export function selectPassages<T>(passages: T[]) {
  const perPassage =
    passages.length >= MIN_POSITIVES
      ? 1
      : Math.min(3, Math.ceil(MIN_POSITIVES / Math.max(1, passages.length)));
  const count = Math.min(
    passages.length,
    Math.floor(MAX_POSITIVES / perPassage),
  );
  const step = passages.length / Math.max(1, count);
  const selected = Array.from(
    { length: count },
    (_, i) => passages[Math.floor(i * step)]!,
  );
  return { selected, perPassage };
}

/** The evaluation cases of the generated questions, positives first. */
export function buildEvaluationCases(
  passages: Passage[],
  questions: GeneratedQuestion[],
): { cases: EvaluationCase[]; kinds: Record<string, CaseKind> } {
  const byId = new Map(passages.map((p) => [p.chunkId, p]));
  const cases: EvaluationCase[] = [];
  const kinds: Record<string, CaseKind> = {};
  const add = (kind: CaseKind, c: Omit<EvaluationCase, "id">) => {
    const id = `${kind === "positive" ? "q" : "n"}${cases.length + 1}`;
    cases.push({ id, ...c });
    kinds[id] = kind;
  };
  const usable = questions.filter((q) => byId.has(q.chunkId));
  for (const q of usable.slice(0, MAX_POSITIVES)) {
    const p = byId.get(q.chunkId)!;
    // Internal questions see every model-usable passage.
    add("positive", {
      query: q.question,
      expectedChunkIds: [p.chunkId],
      forbiddenChunkIds: [],
      language: p.language,
      purpose: "internal",
    });
  }
  // One question per passage for the negatives.
  const first = new Map<string, string>();
  for (const q of usable)
    if (!first.has(q.chunkId)) first.set(q.chunkId, q.question);
  const asked = [...first.entries()].map(([chunkId, query]) => ({
    passage: byId.get(chunkId)!,
    query,
  }));
  let negatives = 0;
  for (const { passage, query } of asked.filter(
    (a) => !a.passage.publicEligible,
  )) {
    if (negatives >= MAX_NEGATIVES) break;
    add("public_leak", {
      query,
      expectedChunkIds: [],
      forbiddenChunkIds: [passage.chunkId],
      language: passage.language,
      purpose: "public",
    });
    negatives++;
  }
  for (const { passage, query } of asked.filter(
    (a) => a.passage.publicEligible,
  )) {
    if (negatives >= MIN_NEGATIVES) break;
    add("language", {
      query,
      expectedChunkIds: [],
      forbiddenChunkIds: [passage.chunkId],
      language: passage.language === "en" ? "de" : "en",
      purpose: "internal",
    });
    negatives++;
  }
  return { cases, kinds };
}

/** The passages of a generation that its evaluation can find now. */
async function indexPassages(tx: DbTx, s: Scope, indexId: string) {
  const index = await assertIndexCorpusCurrent(tx, s, indexId);
  const manifest = index.manifest as unknown as {
    chunkId: string;
    sourceId: string;
  }[];
  const chunks = await tx.knowledgeChunk.findMany({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      id: { in: manifest.map((m) => m.chunkId) },
    },
    include: { documentVersion: true },
    orderBy: [{ documentVersionId: "asc" }, { position: "asc" }],
  });
  const sources = new Map<string, ReturnType<typeof sourceData>>();
  for (const id of new Set(manifest.map((m) => m.sourceId)))
    sources.set(id, sourceData(data(await entity(tx, s, "sources", id))));
  const sourceOf = new Map(manifest.map((m) => [m.chunkId, m.sourceId]));
  const now = Date.now();
  const passages: Passage[] = [];
  for (const chunk of chunks) {
    const source = sources.get(sourceOf.get(chunk.id)!)!;
    const version = chunk.documentVersion;
    // The evaluation's own eligibility: valid now and not stale.
    if (
      version.validFrom.getTime() > now ||
      (version.validUntil && version.validUntil.getTime() <= now) ||
      version.fetchedAt.getTime() + source.maxAgeHours * 3600_000 <= now ||
      chunk.text.trim().length < 40
    )
      continue;
    passages.push({
      chunkId: chunk.id,
      title: version.title,
      heading: chunk.heading,
      text: chunk.text,
      language: chunk.language,
      publicEligible:
        source.publicUse === true &&
        (!source.embargoUntil || Date.parse(source.embargoUntil) <= now),
    });
  }
  return { index, passages };
}

function batchesOf<T>(items: T[]) {
  return Array.from(
    { length: Math.ceil(items.length / PASSAGES_PER_BATCH) },
    (_, i) => items.slice(i * PASSAGES_PER_BATCH, (i + 1) * PASSAGES_PER_BATCH),
  );
}
const passageInput = (batch: Passage[], perPassage: number) => ({
  questionsPerPassage: perPassage,
  passages: batch.map((p, i) => ({
    passage: i + 1,
    language: p.language,
    title: p.title,
    heading: p.heading,
    text: p.text.slice(0, PASSAGE_CHARS),
  })),
});

/** The estimated model cost of generating the set, or null without a priced route. */
export async function evaluationSetEstimate(
  tx: DbTx,
  s: Scope,
  indexId: string,
) {
  try {
    const { passages } = await indexPassages(tx, s, indexId);
    const { selected, perPassage } = selectPassages(passages);
    const runtime = await runtimeOpenAiConfiguration(tx, s);
    const route = resolveRoute(TASK_CLASS, runtime);
    return batchesOf(selected).reduce(
      (sum, batch) =>
        sum +
        estimateCost(
          route.model,
          Buffer.byteLength(JSON.stringify(passageInput(batch, perPassage))) +
            REQUEST_OVERHEAD_BYTES,
          route.maxOutputTokens,
          runtime,
        ),
      0,
    );
  } catch {
    return null;
  }
}

/** Owner action: start generating the test questions of a complete build. */
export async function queueEvaluationSet(tx: DbTx, s: Scope, indexId: string) {
  authorize(s, PROJECT_OWN, "OWNER_REQUIRED");
  const generation = (await describeIndexGenerations(tx, s)).find(
    (g) => g.id === indexId,
  );
  if (!generation) throw new DomainError("INDEX_UNAVAILABLE", 404);
  if (!["ready_for_evaluation", "evaluation_failed"].includes(generation.phase))
    throw new DomainError("INDEX_NOT_READY_FOR_EVALUATION", 409);
  const busy = (await list(tx, s, "index_evaluations")).some(
    (r) =>
      data(r).indexId === indexId &&
      ["generating", "queued", "running"].includes(data(r).status),
  );
  if (busy) throw new DomainError("EVALUATION_IN_PROGRESS", 409);
  const request = await create(tx, s, "index_evaluations", {
    indexId,
    origin: "generated",
    status: "generating",
    datasetVersion: `orbit-generated-${new Date().toISOString().slice(0, 10)}`,
    questions: [],
    batchesDone: 0,
    costMicros: 0,
    cases: [],
    batch: 0,
    budgetReservationIds: [],
    results: [],
    createdBy: s.userId,
  });
  // Unique per set: the dataset version names its evaluation receipts.
  const saved = await update(tx, s, request, {
    ...data(request),
    datasetVersion: `${data(request).datasetVersion}-${request.id.slice(0, 8)}`,
  });
  await enqueue(
    tx,
    s,
    EVALUATION_SET_QUEUE,
    saved.id,
    `evaluation-set:${saved.id}:0`,
  );
  return saved;
}

async function failSet(s: Scope, requestId: string, code: string) {
  await scoped(s.workspaceId, s.projectId, async (tx) => {
    const request = await entity(tx, s, "index_evaluations", requestId);
    if (data(request).status !== "generating") return;
    await update(tx, s, request, {
      ...data(request),
      status: "failed",
      errorCode: code,
    });
  });
}

/** Job: one batch of questions; the last batch builds the cases for review. */
export async function generateEvaluationSet(
  s: Scope,
  requestId: string,
  jobId: string,
) {
  try {
    await generateBatch(s, requestId, jobId);
  } catch (error) {
    // A refusal ends the set with its code; anything else retries the job.
    if (error instanceof DomainError || error instanceof KnowledgeError) {
      await failSet(s, requestId, error.code);
      return;
    }
    throw error;
  }
}

async function generateBatch(s: Scope, requestId: string, _jobId: string) {
  const prepared = await scoped(s.workspaceId, s.projectId, async (tx) => {
    const request = await entity(tx, s, "index_evaluations", requestId);
    const r = data(request);
    if (r.status !== "generating") return null;
    const { passages } = await indexPassages(tx, s, r.indexId);
    const { selected, perPassage } = selectPassages(passages);
    if (selected.length * perPassage < MIN_POSITIVES)
      throw new DomainError("EVALUATION_SET_TOO_SMALL", 409);
    return { r, passages, selected, perPassage, batches: batchesOf(selected) };
  });
  if (!prepared) return;
  const { r, passages, selected, perPassage, batches } = prepared;
  const batchIndex = Number(r.batchesDone ?? 0);
  const batch = batches[batchIndex];
  let questions = r.questions as GeneratedQuestion[];
  let costMicros = Number(r.costMicros ?? 0);
  if (batch) {
    const key = `knowledge_evaluation:${requestId}`;
    const result = await runStructured(s, {
      agentName: "knowledge.evaluation_questions",
      taskClass: TASK_CLASS,
      kind: "evaluation",
      subject: { type: "index_evaluation", id: requestId },
      instructions: EVALUATION_SET_INSTRUCTIONS,
      input: passageInput(batch, perPassage),
      tools: [],
      outputSchema: questionsOutput,
      limits: LIMITS,
      budget: {
        category: "knowledge_evaluation",
        runKey: key,
        callKey: `${key}:${batchIndex}`,
      },
      guard: async (tx, scope) => {
        const current = data(
          await entity(tx, scope, "index_evaluations", requestId),
        );
        if (
          current.status !== "generating" ||
          current.batchesDone !== batchIndex
        )
          throw new DomainError("EVALUATION_SET_CHANGED", 409);
      },
    });
    costMicros += result.costMicros;
    if (result.status !== "ok") {
      await scoped(s.workspaceId, s.projectId, async (tx) => {
        const request = await entity(tx, s, "index_evaluations", requestId);
        await update(tx, s, request, {
          ...data(request),
          status: "failed",
          errorCode: result.code,
          costMicros,
        });
      });
      return;
    }
    const seen = new Map<number, Set<string>>();
    const fresh: GeneratedQuestion[] = [];
    for (const q of result.output.questions) {
      const passage = batch[q.passage - 1];
      const text = q.question.trim();
      if (!passage || text.length < 8 || text.length > 300) continue;
      const own = seen.get(q.passage) ?? new Set<string>();
      if (own.size >= perPassage || own.has(text.toLowerCase())) continue;
      own.add(text.toLowerCase());
      seen.set(q.passage, own);
      fresh.push({ chunkId: passage.chunkId, question: text });
    }
    questions = [...questions, ...fresh];
  }
  await scoped(s.workspaceId, s.projectId, async (tx) => {
    const request = await entity(tx, s, "index_evaluations", requestId);
    const current = data(request);
    if (current.status !== "generating" || current.batchesDone !== batchIndex)
      throw new DomainError("EVALUATION_SET_CHANGED", 409);
    const done = batchIndex + 1;
    if (done < batches.length) {
      await update(tx, s, request, {
        ...current,
        questions,
        batchesDone: done,
        costMicros,
      });
      await enqueue(
        tx,
        s,
        EVALUATION_SET_QUEUE,
        requestId,
        `evaluation-set:${requestId}:${done}`,
      );
      return;
    }
    const selectedIds = new Set(selected.map((p) => p.chunkId));
    const { cases, kinds } = buildEvaluationCases(
      passages.filter((p) => selectedIds.has(p.chunkId)),
      questions,
    );
    const positives = cases.filter((c) => c.expectedChunkIds.length).length;
    const negatives = cases.length - positives;
    await update(tx, s, request, {
      ...current,
      questions,
      batchesDone: done,
      costMicros,
      cases,
      kinds,
      ...(positives < MIN_POSITIVES || negatives < MIN_NEGATIVES
        ? { status: "failed", errorCode: "EVALUATION_SET_TOO_SMALL" }
        : { status: "review" }),
    });
  });
}

export const startEvaluationInput = z
  .object({
    evaluationId: z.uuid(),
    excludedCaseIds: z.array(z.string().max(20)).max(120).default([]),
    confirmQueriesMayBeSentToOpenAI: z.literal(true),
  })
  .strict();

/** Owner action: run the paid evaluation of a reviewed set, without the dropped cases. */
export async function startEvaluationSet(tx: DbTx, s: Scope, raw: unknown) {
  authorize(s, PROJECT_OWN, "OWNER_REQUIRED");
  const input = startEvaluationInput.parse(raw);
  const request = await entity(tx, s, "index_evaluations", input.evaluationId);
  const r = data(request);
  if (r.origin !== "generated" || r.status !== "review")
    throw new DomainError("EVALUATION_SET_NOT_IN_REVIEW", 409);
  const excluded = new Set(input.excludedCaseIds);
  const cases = (r.cases as EvaluationCase[]).filter(
    (c) => !excluded.has(c.id),
  );
  await assertEvaluationCases(tx, s, { indexId: r.indexId, cases });
  const saved = await update(tx, s, request, {
    ...r,
    cases,
    excludedCaseIds: [...excluded],
    confirmQueriesMayBeSentToOpenAI: true,
    status: "queued",
    batch: 0,
    results: [],
    budgetReservationIds: [],
  });
  return enqueue(
    tx,
    s,
    "index_evaluation",
    saved.id,
    `index-evaluation:${saved.id}:0`,
  );
}

/** The newest evaluation record of each generation, with its review list while in review. */
export async function latestEvaluations(tx: DbTx, s: Scope) {
  const records = await list(tx, s, "index_evaluations");
  const jobs = await tx.entity.findMany({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      kind: "jobs",
    },
    select: { data: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const latest = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const indexId = String(data(record).indexId);
    if (!latest.has(indexId)) latest.set(indexId, record);
  }
  const views = new Map<string, Record<string, unknown>>();
  for (const [indexId, record] of latest) {
    const r = data(record);
    // A job that gave up leaves the record queued or running: show its code.
    const job = jobs
      .map((j) => j.data as Record<string, unknown>)
      .find(
        (j) => j.resourceId === record.id && j.status === "blocked_dependency",
      );
    const evaluation = r.evaluation ?? null;
    const view: Record<string, unknown> = {
      id: record.id,
      origin: r.origin ?? "supplied",
      status:
        job && ["generating", "queued", "running"].includes(r.status)
          ? "failed"
          : r.status,
      errorCode:
        r.errorCode ??
        (job && typeof job.error === "string" ? job.error : null),
      datasetVersion: r.datasetVersion,
      costMicros: r.costMicros ?? null,
      batchesDone: r.batchesDone ?? null,
      cases: Array.isArray(r.cases) ? r.cases.length : 0,
      evaluation: evaluation
        ? {
            passed: evaluation.passed === true,
            answered: evaluation.answered,
            recallAt10: evaluation.recallAt10,
            forbiddenHits: evaluation.forbiddenHits,
            missed: Array.isArray(evaluation.results)
              ? evaluation.results.filter(
                  (x: any) => x.rank === 0 && x.forbiddenHits === 0,
                ).length
              : null,
          }
        : null,
    };
    if (r.status === "review" && Array.isArray(r.cases)) {
      const ids = [
        ...new Set(
          (r.cases as EvaluationCase[]).flatMap((c) => [
            ...c.expectedChunkIds,
            ...c.forbiddenChunkIds,
          ]),
        ),
      ];
      const chunks = await tx.knowledgeChunk.findMany({
        where: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          id: { in: ids },
        },
        include: { documentVersion: { select: { title: true } } },
      });
      const byId = new Map(chunks.map((c) => [c.id, c]));
      view.items = (r.cases as EvaluationCase[]).map((c) => {
        const chunk = byId.get(
          c.expectedChunkIds[0] ?? c.forbiddenChunkIds[0]!,
        );
        return {
          id: c.id,
          query: c.query,
          kind:
            (r.kinds as Record<string, CaseKind> | undefined)?.[c.id] ??
            "positive",
          title: chunk?.documentVersion.title ?? null,
          heading: chunk?.heading ?? null,
          snippet: chunk ? chunk.text.slice(0, 240) : null,
        };
      });
    }
    views.set(indexId, view);
  }
  return views;
}

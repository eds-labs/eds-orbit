import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The provider calls are scripted: `respond` writes the questions from the
// passages it receives, `embed` maps each text to its document's one-hot
// vector. Budget, settlement, telemetry, jobs and the SQL evaluation are real.
const DIMENSIONS = 1536;
const SHARED_ANSWER =
  "Family members can open the shared shopping list from the household dashboard.";
const oneHot = (position: number) =>
  Array.from({ length: DIMENSIONS }, (_, i) => (i === position ? 1 : 0));
const mocked = vi.hoisted(() => ({
  invalid: false,
  respondCalls: 0,
  embedCalls: 0,
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.respondCalls++;
    const input = JSON.parse(request.input[0].content);
    const questions = input.passages.flatMap((p: any) =>
      Array.from({ length: input.questionsPerPassage }, (_, n) => ({
        passage: p.passage,
        // "Doc 7" in the title: the question finds document 7's vector.
        question: [1, 2].some((doc) => p.title === `Doc ${doc}`)
          ? `Where is the household shopping list (${p.title}, variant ${n + 1})?`
          : `What does ${p.title} say, variant ${n + 1}?`,
        answerQuote: p.text.includes(SHARED_ANSWER) ? SHARED_ANSWER : p.text,
      })),
    );
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: mocked.invalid ? "not json" : JSON.stringify({ questions }),
            },
          ],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
        costMicros: 9,
      },
      responseId: `resp_${randomUUID()}`,
    };
  }),
  embed: vi.fn(async (texts: string[]) => {
    mocked.embedCalls++;
    return {
      vectors: texts.map((text) => {
        const doc = Number(/Doc (\d+)/.exec(text)?.[1] ?? 1500);
        if (doc !== 1) return oneHot(doc);
        // Doc 2 gives the same answer and ranks first. Doc 1 ranks below
        // every unrelated passage, so only the equivalent answer can score.
        return oneHot(2).map((value, dimension) =>
          dimension === 1 ? -1 : value,
        );
      }),
      usage: {
        model: "text-embedding-3-small",
        inputTokens: texts.length * 10,
        outputTokens: 0,
        costMicros: 3,
      },
    };
  }),
}));

import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  attachIndexBatch,
  beginIndexBuild,
  EMBEDDING_PROFILE,
} from "../../../packages/knowledge/src/index.ts";
import { ingest } from "../src/platform/knowledge/engine.ts";
import {
  generateEvaluationSet,
  latestEvaluations,
  queueEvaluationSet,
  startEvaluationSet,
  type EvaluationCase,
} from "../src/platform/knowledge/evaluation-set.ts";
import { runIndexEvaluation } from "../src/platform/knowledge/index-evaluation.ts";
import { create, data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createPackageProject } from "./support/package-project.ts";

registerModules();

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("generated index evaluation sets", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let indexId = "";
  const scope = () => project.owner;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope().workspaceId, scope().projectId, fn);
  const record = (id: string) =>
    run(async (tx) => data(await entity(tx, scope(), "index_evaluations", id)));
  // Runs the record's question jobs until it leaves `generating`.
  const generate = async (id: string) => {
    for (let i = 0; i < 10 && (await record(id)).status === "generating"; i++)
      await generateEvaluationSet(scope(), id, `job-${i}`);
    return record(id);
  };

  beforeAll(async () => {
    project = await createPackageProject({ name: "Synthetic evaluation set" });
    const past = new Date(Date.now() - 3600000).toISOString();
    await run(async (tx) => {
      const internal = await create(tx, scope(), "sources", {
        name: "Synthetic internal source",
        status: "active",
        publicUse: false,
        modelUse: true,
        authority: "official",
        generation: 1,
        maxAgeHours: 168,
      });
      // 20 public and 5 internal documents of one chunk each.
      for (let n = 1; n <= 25; n++)
        await ingest(tx, scope(), {
          sourceId: n <= 20 ? project.sourceId : internal.id,
          externalId: `synthetic-doc-${n}`,
          title: `Doc ${n}`,
          text:
            `Document number ${n} explains one synthetic topic of the product in a full sentence.` +
            (n <= 2 ? ` ${SHARED_ANSWER}` : ""),
          mimeType: "text/plain",
          language: "en",
          validFrom: past,
          embeddings: [oneHot(n)],
        });
      const index = await beginIndexBuild(tx, scope(), EMBEDDING_PROFILE);
      indexId = index.id;
      const manifest = index.manifest as unknown as { chunkId: string }[];
      const chunks = await tx.knowledgeChunk.findMany({
        where: { id: { in: manifest.map((m) => m.chunkId) } },
        include: { documentVersion: true },
      });
      await attachIndexBatch(
        tx,
        scope(),
        index.id,
        chunks.map((c) => ({
          chunkId: c.id,
          vector: oneHot(
            Number(/Doc (\d+)/.exec(c.documentVersion.title)?.[1] ?? 0),
          ),
        })),
      );
      // The build's settled receipt, as the reindex job leaves it.
      await tx.budgetReservation.create({
        data: {
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          key: `${scope().projectId}:index:${index.id}:build:fixture`,
          category: "reindex",
          state: "settled",
          amountMicros: 10n,
          settledMicros: 7n,
        },
      });
    });
  });
  beforeEach(() => {
    mocked.invalid = false;
    mocked.respondCalls = 0;
    mocked.embedCalls = 0;
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  it("refuses a set for a generation that is not fully embedded", async () => {
    const other = await run((tx) =>
      beginIndexBuild(tx, scope(), EMBEDDING_PROFILE),
    );
    await expect(
      run((tx) => queueEvaluationSet(tx, scope(), other.id)),
    ).rejects.toThrow("INDEX_NOT_READY_FOR_EVALUATION");
    // Not left behind: a later begin would supersede it anyway.
    await run((tx) => tx.knowledgeIndex.delete({ where: { id: other.id } }));
  });

  it("ends the set with the code of an invalid model answer, with its cost settled", async () => {
    mocked.invalid = true;
    const queued = await run((tx) => queueEvaluationSet(tx, scope(), indexId));
    const done = await generate(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      errorCode: "AGENT_OUTPUT_INVALID",
    });
    expect(done.costMicros).toBe(9);
    expect(mocked.respondCalls).toBe(1);
  });

  it("writes questions in batches, reviews them, evaluates without the dropped ones and passes", async () => {
    const queued = await run((tx) => queueEvaluationSet(tx, scope(), indexId));
    // A second set waits for this one.
    await expect(
      run((tx) => queueEvaluationSet(tx, scope(), indexId)),
    ).rejects.toThrow("EVALUATION_IN_PROGRESS");
    const reviewed = await generate(queued.id);
    // 25 passages (the package project's 38-character fixture is too short):
    // two questions each in two batches of 15 and 10 passages.
    expect(mocked.respondCalls).toBe(2);
    expect(reviewed).toMatchObject({
      status: "review",
      batchesDone: 2,
      costMicros: 18,
    });
    const kinds = Object.values(reviewed.kinds as Record<string, string>);
    expect(kinds.filter((k) => k === "positive")).toHaveLength(50);
    expect(kinds.filter((k) => k === "public_leak")).toHaveLength(5);
    expect(kinds.filter((k) => k === "language")).toHaveLength(7);
    // The review list names each question's passage.
    const view = (await run((tx) => latestEvaluations(tx, scope()))).get(
      indexId,
    )!;
    const items = view.items as Array<Record<string, unknown>>;
    expect(view).toMatchObject({
      status: "review",
      origin: "generated",
      cases: 62,
    });
    expect(items[0]).toMatchObject({
      id: "q1",
      kind: "positive",
      title: expect.stringMatching(/^Doc \d+$/),
      snippet: expect.stringContaining("synthetic topic"),
    });
    const equivalentCases = (reviewed.cases as EvaluationCase[]).filter(
      (c) => c.expectedChunkIds.length && c.query.includes("(Doc 1,"),
    );
    expect(equivalentCases).toHaveLength(2);
    expect(equivalentCases.every((c) => c.expectedChunkIds.length === 2)).toBe(
      true,
    );
    // Dropping two positives still meets the coverage rules.
    const excluded = (reviewed.cases as EvaluationCase[])
      .filter((c) => c.expectedChunkIds.length && !equivalentCases.includes(c))
      .slice(0, 2);
    await run((tx) =>
      startEvaluationSet(tx, scope(), {
        evaluationId: queued.id,
        excludedCaseIds: excluded.map((c) => c.id),
        confirmQueriesMayBeSentToOpenAI: true,
      }),
    );
    expect((await record(queued.id)).cases).toHaveLength(60);
    await runIndexEvaluation(scope(), queued.id, randomUUID());
    await runIndexEvaluation(scope(), queued.id, randomUUID());
    const evaluated = await record(queued.id);
    expect(evaluated.status).toBe("completed");
    expect(evaluated.evaluation).toMatchObject({
      passed: true,
      recallAt10: 1,
      forbiddenHits: 0,
      provenance: "live",
      cases: 60,
    });
    for (const c of equivalentCases)
      expect(evaluated.evaluation.results).toContainEqual({
        id: c.id,
        rank: 1,
        forbiddenHits: 0,
      });
    const index = await run((tx) =>
      tx.knowledgeIndex.findUniqueOrThrow({ where: { id: indexId } }),
    );
    expect(index.state).toBe("evaluated");
    // The panel's count: answered questions only, never the control questions.
    const result = (await run((tx) => latestEvaluations(tx, scope()))).get(
      indexId,
    )!;
    expect(result.evaluation).toEqual({
      passed: true,
      answered: 48,
      found: 48,
      recallAt10: 1,
      forbiddenHits: 0,
    });
  });
});

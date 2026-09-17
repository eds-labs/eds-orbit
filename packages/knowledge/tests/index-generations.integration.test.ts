import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, scoped, type PrismaClient } from "@orbit/db";
import {
  beginIndexBuild,
  attachIndexBatch,
  evaluateIndexGeneration,
  activateIndexGeneration,
  rollbackIndexGeneration,
  getActiveIndex,
  assertActiveEmbeddingProfile,
  listIndexGenerations,
  ingest,
  retrieve,
  validateEvidence,
  revokeSource,
  EMBEDDING_PROFILE,
  type Scope,
  type EvidenceData,
  type IndexEvaluationInput,
} from "../src/index.js";
const suite =
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL
    ? describe
    : describe.skip;
const LARGE = "openai:text-embedding-3-large:3072:chunk-v1";
suite("isolated index generations / synthetic SQL mechanics only", () => {
  let app: PrismaClient,
    auth: PrismaClient,
    s: Scope,
    publicSource: string,
    privateSource: string,
    publicChunk: string,
    privateChunk: string;
  let smallId: string, largeId: string;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn, app);
  const vector = (dimensions: number, position = 0) => {
    const v = Array(dimensions).fill(0);
    v[position] = 1;
    return v;
  };
  const evaluation = (dimensions: number): IndexEvaluationInput => ({
    datasetVersion: "index-mechanics-synthetic-v1",
    provenance: "synthetic_test",
    cases: [
      ...Array.from({ length: 48 }, (_, i) => ({
        id: "positive-" + i,
        queryVector: vector(dimensions),
        expectedChunkIds: [publicChunk],
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        id: "permission-" + i,
        queryVector: vector(dimensions, 1),
        expectedChunkIds: [],
        forbiddenChunkIds: [privateChunk],
      })),
    ],
  });
  beforeAll(async () => {
    app = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const workspace = await auth.workspace.create({
      data: { name: "Synthetic index generations" },
    });
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic index owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    await auth.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "owner" },
    });
    const project = await auth.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Synthetic generation tests",
        paused: true,
        mode: "observe",
      },
    });
    s = { workspaceId: workspace.id, projectId: project.id, userId: user.id };
    for (const publicUse of [true, false]) {
      const created = await run((tx) =>
        tx.entity.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            kind: "sources",
            data: {
              name: publicUse ? "Public fixture" : "Internal fixture",
              type: "file",
              status: "active",
              generation: 1,
              publicUse,
              modelUse: true,
              authority: "official",
              maxAgeHours: 720,
              allowedOrigins: [],
              allowedPaths: [],
            },
          },
        }),
      );
      const imported = await run((tx) =>
        ingest(tx, s, {
          sourceId: created.id,
          externalId: randomUUID(),
          title: "INDEXGEN728 fixture",
          text: publicUse
            ? "Public fixture for index generation testing."
            : "Internal secret fixture must not appear in public evaluation.",
          mimeType: "text/plain",
          language: "en",
          validFrom: new Date(Date.now() - 3600000).toISOString(),
          embeddings: [vector(1536, publicUse ? 0 : 1)],
        }),
      );
      const chunk = await run((tx) =>
        tx.knowledgeChunk.findFirstOrThrow({
          where: { documentVersionId: imported.versionId },
        }),
      );
      if (publicUse) {
        publicSource = created.id;
        publicChunk = chunk.id;
      } else {
        privateSource = created.id;
        privateChunk = chunk.id;
      }
    }
  });
  afterAll(async () => {
    await app?.$disconnect();
    await auth?.$disconnect();
  });
  it("requires an evaluated baseline checkpoint before the first alternate profile", async () => {
    const alternate = await run((tx) => beginIndexBuild(tx, s, LARGE));
    await run((tx) =>
      attachIndexBatch(tx, s, alternate.id, [
        { chunkId: publicChunk, vector: vector(3072) },
        { chunkId: privateChunk, vector: vector(3072, 1) },
      ]),
    );
    await run((tx) =>
      evaluateIndexGeneration(tx, s, alternate.id, evaluation(3072)),
    );
    await expect(
      run((tx) =>
        activateIndexGeneration(tx, s, alternate.id, {
          allowSyntheticForTest: true,
        }),
      ),
    ).rejects.toThrow("BASELINE_CHECKPOINT_REQUIRED");
    expect((await run((tx) => getActiveIndex(tx, s))).generation).toBe(1);
  });
  it("keeps building generations separate and forbids premature/incomplete activation", async () => {
    const previous = await run((tx) => getActiveIndex(tx, s));
    const small = await run((tx) => beginIndexBuild(tx, s, EMBEDDING_PROFILE));
    smallId = small.id;
    expect(small.generation).toBeGreaterThan(1);
    expect((await run((tx) => getActiveIndex(tx, s))).id).toBe(previous.id);
    await expect(
      run((tx) => activateIndexGeneration(tx, s, small.id)),
    ).rejects.toThrow("INDEX_NOT_EVALUATED");
    await run((tx) =>
      attachIndexBatch(tx, s, smallId, [
        { chunkId: publicChunk, vector: vector(1536) },
      ]),
    );
    await expect(
      run((tx) => evaluateIndexGeneration(tx, s, smallId, evaluation(1536))),
    ).rejects.toThrow("INCOMPLETE_INDEX_BUILD");
    await run((tx) =>
      attachIndexBatch(tx, s, smallId, [
        { chunkId: privateChunk, vector: vector(1536, 1) },
      ]),
    );
    const result = await run((tx) =>
      evaluateIndexGeneration(tx, s, smallId, evaluation(1536)),
    );
    expect(result).toMatchObject({
      passed: true,
      recallAt10: 1,
      forbiddenHits: 0,
      provenance: "synthetic_test",
      providerCostMicros: "0",
    });
    await expect(
      run((tx) => activateIndexGeneration(tx, s, smallId)),
    ).rejects.toThrow("LIVE_INDEX_EVALUATION_REQUIRED");
    await run((tx) =>
      activateIndexGeneration(tx, s, smallId, { allowSyntheticForTest: true }),
    );
  });
  it("requires real budget receipts for a live evaluation and immutable profile metadata", async () => {
    const large = await run((tx) => beginIndexBuild(tx, s, LARGE));
    largeId = large.id;
    await expect(
      run((tx) =>
        tx.knowledgeIndex.update({
          where: { id: large.id },
          data: { dimensions: 1536 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      run((tx) =>
        attachIndexBatch(tx, s, large.id, [
          { chunkId: publicChunk, vector: vector(1536) },
        ]),
      ),
    ).rejects.toThrow("INVALID_EMBEDDING");
    await run((tx) =>
      attachIndexBatch(tx, s, large.id, [
        { chunkId: publicChunk, vector: vector(3072) },
        { chunkId: privateChunk, vector: vector(3072, 1) },
      ]),
    );
    await expect(
      run((tx) =>
        evaluateIndexGeneration(tx, s, large.id, {
          ...evaluation(3072),
          provenance: "live",
        }),
      ),
    ).rejects.toThrow("EVALUATION_BUDGET_RECEIPTS_REQUIRED");
    const unrelated = await run((tx) =>
      tx.budgetReservation.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          key: s.projectId + ":unrelated-paid-query",
          category: "query_embedding",
          state: "settled",
          amountMicros: 10n,
          settledMicros: 7n,
        },
      }),
    );
    await expect(
      run((tx) =>
        evaluateIndexGeneration(tx, s, large.id, {
          ...evaluation(3072),
          provenance: "live",
          budgetReservationIds: [unrelated.id],
        }),
      ),
    ).rejects.toThrow("EVALUATION_BUDGET_RECEIPTS_REQUIRED");
    const wrongDataset = await run(async (tx) =>
      Promise.all([
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key: s.projectId + ":index:" + large.id + ":build:fixture",
            category: "reindex",
            state: "settled",
            amountMicros: 10n,
            settledMicros: 7n,
          },
        }),
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key:
              s.projectId +
              ":index:" +
              large.id +
              ":evaluation:wrong-dataset:fixture",
            category: "reindex_evaluation",
            state: "settled",
            amountMicros: 10n,
            settledMicros: 7n,
          },
        }),
      ]),
    );
    await expect(
      run((tx) =>
        evaluateIndexGeneration(tx, s, large.id, {
          ...evaluation(3072),
          provenance: "live",
          budgetReservationIds: wrongDataset.map((r) => r.id),
        }),
      ),
    ).rejects.toThrow("EVALUATION_BUDGET_RECEIPTS_REQUIRED");
    await run((tx) =>
      evaluateIndexGeneration(tx, s, large.id, evaluation(3072)),
    );
  });
  it("atomically changes dimensions without mixing vectors and supports evaluated rollback", async () => {
    const oldEvidence = await run((tx) =>
      retrieve(tx, s, {
        query: "INDEXGEN728",
        purpose: "public",
        queryVector: vector(1536),
        profile: EMBEDDING_PROFILE,
      }),
    );
    await run((tx) =>
      activateIndexGeneration(tx, s, largeId, { allowSyntheticForTest: true }),
    );
    expect((await run((tx) => getActiveIndex(tx, s))).dimensions).toBe(3072);
    await expect(
      run((tx) => assertActiveEmbeddingProfile(tx, s, EMBEDDING_PROFILE)),
    ).rejects.toThrow("ACTIVE_EMBEDDING_PROFILE_MISMATCH");
    await expect(
      run((tx) =>
        retrieve(tx, s, {
          query: "INDEXGEN728",
          purpose: "public",
          queryVector: vector(1536),
        }),
      ),
    ).rejects.toThrow("ACTIVE_EMBEDDING_PROFILE_MISMATCH");
    const e = await run((tx) =>
      retrieve(tx, s, {
        query: "INDEXGEN728",
        purpose: "public",
        queryVector: vector(3072),
        profile: LARGE,
      }),
    );
    expect(
      (e.data as unknown as EvidenceData).items.map((i) => i.chunkId),
    ).toEqual([publicChunk]);
    expect((e.data as unknown as EvidenceData).indexId).toBe(largeId);
    expect(
      (await run((tx) => validateEvidence(tx, s, oldEvidence.id))).reasons,
    ).toContain("index_generation_changed");
    await run((tx) =>
      rollbackIndexGeneration(tx, s, smallId, { allowSyntheticForTest: true }),
    );
    expect((await run((tx) => getActiveIndex(tx, s))).id).toBe(smallId);
    expect(
      (await run((tx) => listIndexGenerations(tx, s))).filter(
        (i) => i.state === "active",
      ),
    ).toHaveLength(1);
    const back = await run((tx) =>
      retrieve(tx, s, {
        query: "INDEXGEN728",
        purpose: "public",
        queryVector: vector(1536),
        profile: EMBEDDING_PROFILE,
      }),
    );
    expect((back.data as unknown as EvidenceData).items[0]?.chunkId).toBe(
      publicChunk,
    );
  });
  it("revocation purges every vector generation and prevents stale build activation or rollback", async () => {
    const building = await run((tx) => beginIndexBuild(tx, s, LARGE));
    await run((tx) => revokeSource(tx, s, publicSource));
    expect(
      await run((tx) =>
        tx.chunkEmbedding.count({ where: { chunkId: publicChunk } }),
      ),
    ).toBe(0);
    await expect(
      run((tx) =>
        attachIndexBatch(tx, s, building.id, [
          { chunkId: publicChunk, vector: vector(3072) },
        ]),
      ),
    ).rejects.toThrow("INDEX_CORPUS_CHANGED");
    await expect(
      run((tx) =>
        rollbackIndexGeneration(tx, s, largeId, {
          allowSyntheticForTest: true,
        }),
      ),
    ).rejects.toThrow("INDEX_CORPUS_CHANGED");
    expect((await run((tx) => getActiveIndex(tx, s))).id).toBe(smallId);
    expect(await app.knowledgeIndex.count()).toBe(0);
    expect(privateSource).not.toBe(publicSource);
  });
});

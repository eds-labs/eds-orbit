import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  closeDatabase,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import {
  ingest,
  setSourceRights,
  revokeSource,
  beginIndexBuild,
  EMBEDDING_PROFILE,
  getActiveIndex,
  activateIndexGeneration,
  validateActiveIndexEvaluation,
} from "../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, update } from "../src/shared.ts";
import {
  assertContentCampaignContext,
  profileGuardrailProblems,
} from "../src/modules/marketing-profile.ts";
const provider = vi.hoisted(() => ({ generate: vi.fn(), embed: vi.fn() }));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../packages/ai/src/index.ts")
  >()),
  generate: provider.generate,
  embed: provider.embed,
  route: () => "synthetic-test-model",
  estimateCost: () => 1000,
}));
import { generateMissionLive } from "../src/modules/generation.ts";
import { retrieveHybrid } from "../src/modules/retrieval.ts";
import {
  embedDocument,
  queueDocumentEmbedding,
} from "../src/modules/ingestion.ts";
import { buildIndexBatch } from "../src/modules/reindex.ts";
import {
  queueIndexEvaluation,
  runIndexEvaluation,
} from "../src/modules/index-evaluation.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Paid call races / real SQL cost journal / mocked provider only",
  () => {
    let auth: PrismaClient,
      s: Scope,
      sourceId: string,
      documentId: string,
      missionId: string;
    const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
      scoped(s.workspaceId, s.projectId, fn);
    const embedding = () => ({
      vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 20,
        outputTokens: 0,
        costMicros: 7,
      },
    });
    const generated = () => ({
      output: {
        title: "Synthetic output",
        body: "Approved fixture content.",
        claims: [{ text: "Fixture style", kind: "style" }],
      },
      usage: {
        model: "synthetic-test-model",
        inputTokens: 40,
        outputTokens: 20,
        costMicros: 77,
      },
    });
    beforeAll(() => {
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    });
    beforeEach(async () => {
      provider.generate.mockReset().mockResolvedValue(generated());
      provider.embed.mockReset().mockResolvedValue(embedding());
      const user = await auth.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic paid-race owner",
          email: randomUUID() + "@example.invalid",
        },
      });
      const workspace = await auth.workspace.create({
        data: {
          name: "Synthetic paid-race",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await auth.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Isolated mocked-provider race",
          mode: "observe",
        },
      });
      s = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      const past = new Date(Date.now() - 3600000).toISOString(),
        future = new Date(Date.now() + 86400000).toISOString();
      await run(async (tx) => {
        sourceId = (
          await create(tx, s, "sources", {
            name: "Approved synthetic source",
            type: "manual",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: true,
            authority: "official",
            maxAgeHours: 168,
            allowedOrigins: [],
            allowedPaths: [],
          })
        ).id;
        const doc = await ingest(tx, s, {
          sourceId,
          externalId: "paid-race-fixture",
          title: "PAIDRACE529",
          text: "PAIDRACE529 verified project guidance for a local fixture.",
          mimeType: "text/plain",
          language: "en",
          validFrom: past,
        });
        documentId = doc.documentId;
        await create(tx, s, "policies", {
          mode: "observe",
          channels: ["test"],
          contentTypes: ["social"],
          allowedOrigins: [],
          startAt: past,
          endAt: future,
          maxPerDay: 3,
          minIntervalMinutes: 1,
          dailyBudgetMicros: 100000,
          monthlyBudgetMicros: 1000000,
          perRunBudgetMicros: 10000,
          approvedPaidTests: true,
          active: true,
        });
        missionId = (
          await create(tx, s, "missions", {
            title: "Synthetic paid race",
            goal: "PAIDRACE529",
            audience: "Test",
            language: "en",
            channels: ["test"],
            startAt: past,
            endAt: future,
            maxContents: 10,
            targetAction: "read",
            sourceIds: [sourceId],
            contentType: "social",
            status: "ready",
          })
        ).id;
      });
    });
    afterAll(async () => {
      await auth?.$disconnect();
      await closeDatabase();
    });
    async function settled(category: string, cost: bigint) {
      const rows = await run((tx) =>
        tx.budgetReservation.findMany({ where: { category } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "settled", settledMicros: cost });
    }
    async function largeDocument(chunkCount: number) {
      return run((tx) =>
        ingest(tx, s, {
          sourceId,
          externalId: "embedding-batches-" + randomUUID(),
          title: "Bounded embedding batches",
          text: Array.from(
            { length: chunkCount },
            (_, index) =>
              `# Batch ${index + 1}\n${`passage-${index + 1} `.repeat(24)}`,
          ).join("\n\n"),
          mimeType: "text/markdown",
          language: "en",
          validFrom: new Date(Date.now() - 3600000).toISOString(),
        }),
      );
    }
    async function setCampaign(campaignType: "product" | "presale") {
      const targetUrl = "https://official.example.invalid/learn";
      await run(async (tx) => {
        const link = await create(tx, s, "facts", {
          key: "official.link",
          value: targetUrl,
          valueType: "url",
          language: "en",
          sourceId,
          validFrom: new Date(Date.now() - 3600000).toISOString(),
          status: "verified",
          publicUse: true,
          modelUse: true,
        });
        await tx.projectMarketingProfile.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            version: 1,
            data: {
              productName: "Approved product",
              contentLanguage: "en",
              internalLanguage: "en",
              audience: "Approved audience",
              positioning: "Evidence-led explanation",
              productStrategy: "Explain the product workflow",
              presaleStrategy: "State only verified presale facts",
              voice: ["Clear and natural"],
              guardrails: ["No guaranteed returns"],
              primaryCtas: ["Learn more."],
              channelPriority: ["test"],
              notificationPreference: "none",
              officialLinks: [
                { label: "Official", url: targetUrl, factId: link.id },
              ],
              assetPolicy: "approved_only",
            },
          },
        });
        await create(tx, s, "connectors", {
          provider: "postiz",
          status: "read_verified",
          channels: [{ id: "test", name: "Synthetic X", identifier: "x" }],
          assignedIntegrationIds: ["test"],
        });
        const currentPolicy = await tx.entity.findFirstOrThrow({
          where: { projectId: s.projectId, kind: "policies" },
        });
        await update(tx, s, currentPolicy, {
          ...data(currentPolicy),
          allowedOrigins: ["https://official.example.invalid"],
        });
        const mission = await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        });
        await update(tx, s, mission, {
          ...data(mission),
          campaignType,
          profileVersion: 1,
          targetAction: "Learn more.",
          targetUrl,
        });
      });
      return targetUrl;
    }
    it.each(["product", "presale"] as const)(
      "%s generation uses the current profile, intended CTA and official link",
      async (campaignType) => {
        const targetUrl = await setCampaign(campaignType);
        const content = await generateMissionLive(s, missionId, randomUUID());
        const goal = JSON.parse(provider.generate.mock.calls[0]![0].goal);
        expect(goal.campaign).toMatchObject({
          profileVersion: 1,
          campaignType,
          product: "Approved product",
          language: "en",
          intendedPrimaryCta: "Learn more.",
          officialTargetUrl: targetUrl,
          targetChannel: "test",
          channelProvider: "x",
          voice: ["Clear and natural"],
          guardrails: ["No guaranteed returns"],
          strategy:
            campaignType === "presale"
              ? "State only verified presale facts"
              : "Explain the product workflow",
        });
        expect(goal).toMatchObject({
          missionId,
          evidenceId: data(content).evidenceId,
          channel: "test",
          contentType: "social",
          channelConstraints: {
            approvedChannels: ["test"],
            approvedContentTypes: ["social"],
            characterLimit: null,
          },
        });
        expect(data(content).targetUrl).toBe(targetUrl);
        await expect(
          run((tx) =>
            assertContentCampaignContext(tx, s, {
              ...data(content),
              targetUrl: "https://other.example.invalid",
            }),
          ),
        ).rejects.toThrow("CONTENT_TARGET_URL_MISMATCH");
        expect(
          await run((tx) => profileGuardrailProblems(tx, s, data(content))),
        ).toContain("PRIMARY_CTA_REQUIRED");
      },
    );
    it("rejects a stale profile before any paid query or text call", async () => {
      await setCampaign("product");
      await run((tx) =>
        tx.projectMarketingProfile.updateMany({
          where: { projectId: s.projectId },
          data: { version: 2 },
        }),
      );
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("MARKETING_PROFILE_VERSION_REQUIRED");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("rejects a non-official target URL before any paid call", async () => {
      await setCampaign("product");
      await run(async (tx) => {
        const mission = await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        });
        await update(tx, s, mission, {
          ...data(mission),
          targetUrl: "https://unapproved.example.invalid",
        });
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("TARGET_URL_NOT_OFFICIAL");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("rejects a channel outside the policy before any paid call", async () => {
      await setCampaign("product");
      await run(async (tx) => {
        const current = await tx.entity.findFirstOrThrow({
          where: { projectId: s.projectId, kind: "policies" },
        });
        await update(tx, s, current, {
          ...data(current),
          channels: ["different"],
        });
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("SCOPE_NOT_ALLOWED");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("rejects a policy-disallowed official link before any paid call", async () => {
      await setCampaign("product");
      await run(async (tx) => {
        const current = await tx.entity.findFirstOrThrow({
          where: { projectId: s.projectId, kind: "policies" },
        });
        await update(tx, s, current, {
          ...data(current),
          allowedOrigins: [],
        });
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("LINK_NOT_ALLOWED");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("rejects a withdrawn official-link source before any paid call", async () => {
      await setCampaign("product");
      await run((tx) => setSourceRights(tx, s, sourceId, { modelUse: false }));
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("OFFICIAL_LINK_FACT_MODEL_USE_REQUIRED");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("settles model cost and refuses output when the profile changes in flight", async () => {
      await setCampaign("product");
      provider.generate.mockImplementation(async () => {
        await run((tx) =>
          tx.projectMarketingProfile.updateMany({
            where: { projectId: s.projectId },
            data: { version: 2 },
          }),
        );
        return generated();
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("MARKETING_PROFILE_VERSION_REQUIRED");
      await settled("text", 77n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(0);
    });
    it("rejects output when the assigned channel changes during generation", async () => {
      await setCampaign("product");
      provider.generate.mockImplementation(async () => {
        await run(async (tx) => {
          const connector = await tx.entity.findFirstOrThrow({
            where: { projectId: s.projectId, kind: "connectors" },
          });
          await update(tx, s, connector, {
            ...data(connector),
            assignedIntegrationIds: [],
          });
        });
        return generated();
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("GENERATION_DEPENDENCY_CHANGED");
      await settled("text", 77n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(0);
    });
    it("A12/SR01: source withdrawal after model response records cost, refuses content, and retry makes no paid call", async () => {
      const jobId = randomUUID();
      provider.generate.mockImplementation(async () => {
        await run((tx) =>
          setSourceRights(tx, s, sourceId, { modelUse: false }),
        );
        return generated();
      });
      await expect(generateMissionLive(s, missionId, jobId)).rejects.toThrow(
        "GENERATION_DEPENDENCY_CHANGED",
      );
      await settled("text", 77n);
      await settled("query_embedding", 7n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(0);
      await expect(generateMissionLive(s, missionId, jobId)).rejects.toThrow(
        "RESERVATION_ALREADY_USED",
      );
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("pause during model response refuses output after settling actual usage", async () => {
      provider.generate.mockImplementation(async () => {
        await run((tx) =>
          tx.project.update({
            where: { id: s.projectId },
            data: { paused: true, generation: { increment: 1 } },
          }),
        );
        return generated();
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("GENERATION_DEPENDENCY_CHANGED");
      await settled("text", 77n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(0);
    });
    it("mission and paid mandate expiry during a response refuse output after settling", async () => {
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      provider.generate.mockImplementation(async () => {
        clock = vi
          .spyOn(Date, "now")
          .mockReturnValue(Date.now() + 2 * 86400000);
        return generated();
      });
      try {
        await expect(
          generateMissionLive(s, missionId, randomUUID()),
        ).rejects.toThrow("GENERATION_DEPENDENCY_CHANGED");
      } finally {
        clock?.mockRestore();
      }
      await settled("text", 77n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(0);
    });
    it("query and text share the owner per-run budget instead of each spending the full cap", async () => {
      await run(async (tx) => {
        const p = await tx.entity.findFirstOrThrow({
          where: { kind: "policies" },
        });
        await update(tx, s, p, { ...data(p), perRunBudgetMicros: 1000 });
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("RUN_BUDGET_EXCEEDED");
      await settled("query_embedding", 7n);
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(provider.generate).not.toHaveBeenCalled();
      expect(
        await run((tx) =>
          tx.budgetReservation.count({ where: { category: "text" } }),
        ),
      ).toBe(0);
    });
    it("an unresolved prior work package cannot start another paid generation", async () => {
      await run(async (tx) => {
        const mission = await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        });
        await update(tx, s, mission, {
          ...data(mission),
          status: "awaiting_followup",
          completedRuns: 1,
        });
      });
      await expect(
        generateMissionLive(s, missionId, randomUUID()),
      ).rejects.toThrow("MISSION_NOT_READY");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    });
    it("unknown provider outcome holds reservation and cannot be silently retried", async () => {
      provider.generate.mockRejectedValue(
        new Error("Synthetic transport uncertainty"),
      );
      const jobId = randomUUID();
      await expect(generateMissionLive(s, missionId, jobId)).rejects.toThrow(
        "MODEL_OUTCOME_OR_COST_UNKNOWN",
      );
      const row = await run((tx) =>
        tx.budgetReservation.findFirstOrThrow({ where: { category: "text" } }),
      );
      expect(row).toMatchObject({
        state: "unknown",
        settledMicros: null,
        amountMicros: 1000n,
      });
      await expect(generateMissionLive(s, missionId, jobId)).rejects.toThrow(
        "RESERVATION_ALREADY_USED",
      );
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("query policy pause preserves cost and refuses the now-unapproved evidence result", async () => {
      provider.embed.mockImplementation(async () => {
        await run((tx) =>
          tx.project.update({
            where: { id: s.projectId },
            data: { paused: true },
          }),
        );
        return embedding();
      });
      await expect(
        retrieveHybrid(s, {
          query: "PAIDRACE529",
          sourceIds: [sourceId],
          purpose: "public",
          forModel: true,
        }),
      ).rejects.toThrow("QUERY_POLICY_CHANGED");
      await settled("query_embedding", 7n);
    });
    it("K17/K29: revoked source quarantines a successful document embedding result with its cost", async () => {
      provider.embed.mockImplementation(async () => {
        await run((tx) => revokeSource(tx, s, sourceId));
        return embedding();
      });
      const jobId = randomUUID();
      await expect(embedDocument(s, documentId, jobId)).rejects.toThrow(
        "SOURCE_UNAVAILABLE",
      );
      await settled("embedding", 7n);
      expect(await run((tx) => tx.chunkEmbedding.count())).toBe(0);
      await expect(embedDocument(s, documentId, jobId)).rejects.toThrow(
        "DOCUMENT_NOT_FOUND",
      );
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("K17/K29: persists and resumes a document larger than 32 chunks in bounded paid jobs", async () => {
      const document = await largeDocument(65);
      expect(document.chunks).toBe(65);
      provider.embed.mockImplementation(async (texts: string[]) => ({
        ...embedding(),
        vectors: texts.map(() => embedding().vectors[0]!),
      }));

      const secondJob = await embedDocument(
        s,
        document.documentId,
        randomUUID(),
      );
      expect(data(secondJob as { data: unknown })).toMatchObject({
        topic: "embedding",
        resourceId: document.documentId,
        status: "queued",
      });
      expect(
        await run((tx) =>
          tx.chunkEmbedding.count({
            where: { chunk: { documentVersionId: document.versionId } },
          }),
        ),
      ).toBe(32);

      const thirdJob = await embedDocument(
        s,
        document.documentId,
        (secondJob as { id: string }).id,
      );
      expect(data(thirdJob as { data: unknown })).toMatchObject({
        topic: "embedding",
        resourceId: document.documentId,
        status: "queued",
      });
      const completed = await embedDocument(
        s,
        document.documentId,
        (thirdJob as { id: string }).id,
      );

      expect(completed).toMatchObject({
        embedded: 1,
        stored: 65,
        total: 65,
        complete: true,
      });
      expect(provider.embed).toHaveBeenCalledTimes(3);
      expect(
        provider.embed.mock.calls.map((call) => (call[0] as string[]).length),
      ).toEqual([32, 32, 1]);
      expect(
        await run((tx) =>
          tx.chunkEmbedding.count({
            where: { chunk: { documentVersionId: document.versionId } },
          }),
        ),
      ).toBe(65);
      expect(
        await run((tx) =>
          tx.budgetReservation.findMany({
            where: { category: "embedding" },
            select: { state: true, settledMicros: true },
          }),
        ),
      ).toEqual([
        { state: "settled", settledMicros: 7n },
        { state: "settled", settledMicros: 7n },
        { state: "settled", settledMicros: 7n },
      ]);
      await embedDocument(s, document.documentId, randomUUID());
      expect(provider.embed).toHaveBeenCalledTimes(3);
    });
    it("K17: rechecks source rights before a chained embedding batch", async () => {
      const document = await largeDocument(33);
      provider.embed.mockImplementation(async (texts: string[]) => ({
        ...embedding(),
        vectors: texts.map(() => embedding().vectors[0]!),
      }));
      const nextJob = await embedDocument(s, document.documentId, randomUUID());
      expect(provider.embed).toHaveBeenCalledTimes(1);
      await run((tx) => setSourceRights(tx, s, sourceId, { modelUse: false }));
      await expect(
        embedDocument(s, document.documentId, (nextJob as { id: string }).id),
      ).rejects.toThrow(/MODEL_USE_FORBIDDEN|STALE_SOURCE_GENERATION/);
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("K17: rechecks document freshness before a chained embedding batch", async () => {
      const document = await largeDocument(33);
      provider.embed.mockImplementation(async (texts: string[]) => ({
        ...embedding(),
        vectors: texts.map(() => embedding().vectors[0]!),
      }));
      const nextJob = await embedDocument(s, document.documentId, randomUUID());
      expect(provider.embed).toHaveBeenCalledTimes(1);
      await run((tx) =>
        tx.documentVersion.update({
          where: { id: document.versionId },
          data: { validUntil: new Date(Date.now() - 1000) },
        }),
      );
      await expect(
        embedDocument(s, document.documentId, (nextJob as { id: string }).id),
      ).rejects.toThrow("DOCUMENT_NOT_FRESH");
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("resumes persisted progress after a terminal embedding batch", async () => {
      const document = await largeDocument(33);
      provider.embed.mockImplementation(async (texts: string[]) => ({
        ...embedding(),
        vectors: texts.map(() => embedding().vectors[0]!),
      }));
      const failedBatch = await embedDocument(
        s,
        document.documentId,
        randomUUID(),
      );
      await run((tx) =>
        tx.entity.update({
          where: { id: (failedBatch as { id: string }).id },
          data: {
            data: {
              ...data(failedBatch as { data: unknown }),
              status: "blocked_dependency",
              attempts: 3,
            },
          },
        }),
      );

      const resumed = await run((tx) =>
        queueDocumentEmbedding(tx, s, document.documentId),
      );
      expect((resumed as { id: string }).id).not.toBe(
        (failedBatch as { id: string }).id,
      );
      expect(data(resumed as { data: unknown })).toMatchObject({
        status: "queued",
        topic: "embedding",
      });
      const duplicateConfirmation = await run((tx) =>
        queueDocumentEmbedding(tx, s, document.documentId),
      );
      expect((duplicateConfirmation as { id: string }).id).toBe(
        (resumed as { id: string }).id,
      );
      await embedDocument(
        s,
        document.documentId,
        (resumed as { id: string }).id,
      );
      expect(provider.embed).toHaveBeenCalledTimes(2);
      expect(
        await run((tx) =>
          tx.chunkEmbedding.count({
            where: { chunk: { documentVersionId: document.versionId } },
          }),
        ),
      ).toBe(33);
    });
    it("K18/K29: changed source rights quarantine reindex response, preserve charge, and block retry", async () => {
      const index = await run((tx) =>
        beginIndexBuild(tx, s, EMBEDDING_PROFILE),
      );
      const jobId = randomUUID();
      provider.embed.mockImplementation(async () => {
        await run((tx) =>
          setSourceRights(tx, s, sourceId, { modelUse: false }),
        );
        return embedding();
      });
      await expect(buildIndexBatch(s, index.id, jobId)).rejects.toThrow(
        "INDEX_CORPUS_CHANGED",
      );
      await settled("reindex", 7n);
      expect(
        await run((tx) =>
          tx.chunkEmbedding.count({
            where: { indexGeneration: index.generation },
          }),
        ),
      ).toBe(0);
      await expect(buildIndexBatch(s, index.id, jobId)).rejects.toThrow(
        "INDEX_CORPUS_CHANGED",
      );
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(
        data(
          await run((tx) =>
            tx.entity.findUniqueOrThrow({ where: { id: sourceId } }),
          ),
        ).modelUse,
      ).toBe(false);
    });
    async function evaluationFixture() {
      const privateDoc = await run(async (tx) => {
        const source = await create(tx, s, "sources", {
          name: "Internal evaluation fixture",
          type: "manual",
          status: "active",
          generation: 1,
          publicUse: false,
          modelUse: true,
          authority: "official",
          maxAgeHours: 168,
          allowedOrigins: [],
          allowedPaths: [],
        });
        return ingest(tx, s, {
          sourceId: source.id,
          externalId: "internal-eval",
          title: "Private evaluation",
          text: "Internal fixture document.",
          mimeType: "text/plain",
          language: "en",
          validFrom: new Date(Date.now() - 3600000).toISOString(),
        });
      });
      const ids = await run(async (tx) => ({
        public: (
          await tx.knowledgeChunk.findFirstOrThrow({
            where: { documentVersion: { documentId } },
          })
        ).id,
        private: (
          await tx.knowledgeChunk.findFirstOrThrow({
            where: { documentVersionId: privateDoc.versionId },
          })
        ).id,
      }));
      const index = await run((tx) =>
        beginIndexBuild(tx, s, EMBEDDING_PROFILE),
      );
      provider.embed.mockImplementation(async (texts: string[]) => ({
        ...embedding(),
        vectors: texts.map(() => embedding().vectors[0]!),
      }));
      await buildIndexBatch(s, index.id, randomUUID());
      provider.embed.mockClear();
      const input = {
        indexId: index.id,
        datasetVersion: "mocked-provider-evaluation-v1",
        confirmQueriesMayBeSentToOpenAI: true as const,
        cases: [
          ...Array.from({ length: 48 }, (_, i) => ({
            id: "answer-" + i,
            query: "Synthetic public query " + i,
            expectedChunkIds: [ids.public],
            forbiddenChunkIds: [],
            language: "en" as const,
            purpose: "public" as const,
          })),
          ...Array.from({ length: 16 }, (_, i) => ({
            id: "deny-" + i,
            query: "Synthetic private query " + i,
            expectedChunkIds: [],
            forbiddenChunkIds: [ids.private],
            language: "en" as const,
            purpose: "public" as const,
          })),
        ],
      };
      return { index, input };
    }
    it("index evaluation rejects insufficient negative coverage and denied budget before query transmission", async () => {
      const { input } = await evaluationFixture();
      await expect(
        run((tx) =>
          queueIndexEvaluation(tx, s, {
            ...input,
            cases: input.cases.map((c) => ({ ...c, forbiddenChunkIds: [] })),
          }),
        ),
      ).rejects.toThrow("EVALUATION_CASE_COVERAGE_REQUIRED");
      const job = await run((tx) => queueIndexEvaluation(tx, s, input));
      await run(async (tx) => {
        const policy = await tx.entity.findFirstOrThrow({
          where: { kind: "policies" },
        });
        await update(tx, s, policy, {
          ...data(policy),
          approvedPaidTests: false,
        });
      });
      await expect(
        runIndexEvaluation(s, data(job).resourceId, job.id),
      ).rejects.toThrow("BUDGET_NOT_APPROVED");
      expect(provider.embed).not.toHaveBeenCalled();
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { category: "reindex_evaluation" },
          }),
        ),
      ).toBe(0);
    });
    it("64-query mocked evaluation uses two bounded paid batches, persists quality results, and never auto-activates", async () => {
      const { index, input } = await evaluationFixture();
      const active = await run((tx) => getActiveIndex(tx, s));
      const first = await run((tx) => queueIndexEvaluation(tx, s, input));
      const next = await runIndexEvaluation(
        s,
        data(first).resourceId,
        first.id,
      );
      expect(data(next as { data: unknown }).topic).toBe("index_evaluation");
      const completed = await runIndexEvaluation(
        s,
        data(first).resourceId,
        (next as { id: string }).id,
      );
      expect(data(completed as { data: unknown })).toMatchObject({
        status: "completed",
        results: [],
        evaluation: {
          passed: true,
          cases: 64,
          recallAt10: 1,
          forbiddenHits: 0,
          providerCostMicros: "21",
        },
      });
      expect(provider.embed).toHaveBeenCalledTimes(2);
      expect(
        provider.embed.mock.calls.map((c) => (c[0] as string[]).length),
      ).toEqual([32, 32]);
      expect((await run((tx) => getActiveIndex(tx, s))).id).toBe(active.id);
      expect(
        (
          await run((tx) =>
            tx.knowledgeIndex.findUniqueOrThrow({ where: { id: index.id } }),
          )
        ).state,
      ).toBe("evaluated");
      await runIndexEvaluation(s, data(first).resourceId, first.id);
      expect(provider.embed).toHaveBeenCalledTimes(2);
      vi.stubEnv("LIVE_RAG_EVAL_PASSED", "true");
      try {
        expect(
          (await run((tx) => validateActiveIndexEvaluation(tx, s))).valid,
        ).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
      await run((tx) => activateIndexGeneration(tx, s, index.id));
      expect(
        (await run((tx) => validateActiveIndexEvaluation(tx, s))).valid,
      ).toBe(true);
      expect(
        (
          await run((tx) =>
            validateActiveIndexEvaluation(
              tx,
              s,
              new Date(Date.now() + 31 * 86400000),
            ),
          )
        ).valid,
      ).toBe(false);
      await run((tx) => setSourceRights(tx, s, sourceId, { publicUse: false }));
      expect(
        (await run((tx) => validateActiveIndexEvaluation(tx, s))).reasons,
      ).toContain("INDEX_EVALUATION_CORPUS_CHANGED");
    });
    it("passes an independently chosen historical cutoff through durable evaluation batches", async () => {
      const { input } = await evaluationFixture();
      const publicChunkId = input.cases[0]!.expectedChunkIds[0]!;
      const beforeSource = new Date(Date.now() - 3 * 3600000).toISOString();
      const cases = input.cases.map((c) =>
        c.expectedChunkIds.length
          ? c
          : {
              ...c,
              forbiddenChunkIds: [publicChunkId],
              at: beforeSource,
            },
      );
      const job = await run((tx) =>
        queueIndexEvaluation(tx, s, {
          ...input,
          datasetVersion: "historical-cutoff-v1",
          cases,
        }),
      );
      const next = await runIndexEvaluation(s, data(job).resourceId, job.id);
      const completed = await runIndexEvaluation(
        s,
        data(job).resourceId,
        (next as { id: string }).id,
      );
      const evaluation = data(completed as { data: unknown }).evaluation as {
        passed: boolean;
        forbiddenHits: number;
        results: { id: string; forbiddenHits: number }[];
      };
      expect(evaluation.passed).toBe(true);
      expect(evaluation.forbiddenHits).toBe(0);
      expect(
        evaluation.results.filter((r) => r.id.startsWith("deny-")),
      ).toHaveLength(16);
      expect(
        evaluation.results
          .filter((r) => r.id.startsWith("deny-"))
          .every((r) => r.forbiddenHits === 0),
      ).toBe(true);
    });
    it("index evaluation quarantines successful query responses after source rights change and preserves cost", async () => {
      const { index, input } = await evaluationFixture();
      const job = await run((tx) => queueIndexEvaluation(tx, s, input));
      provider.embed.mockImplementation(async (texts: string[]) => {
        await run((tx) =>
          setSourceRights(tx, s, sourceId, { modelUse: false }),
        );
        return {
          ...embedding(),
          vectors: texts.map(() => embedding().vectors[0]!),
        };
      });
      await expect(
        runIndexEvaluation(s, data(job).resourceId, job.id),
      ).rejects.toThrow("INDEX_CORPUS_CHANGED");
      await settled("reindex_evaluation", 7n);
      expect(
        (
          await run((tx) =>
            tx.knowledgeIndex.findUniqueOrThrow({ where: { id: index.id } }),
          )
        ).evaluation,
      ).toBeNull();
      await expect(
        runIndexEvaluation(s, data(job).resourceId, job.id),
      ).rejects.toThrow("INDEX_CORPUS_CHANGED");
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
    it("a completed generation job resumes the same content without another charge or work package", async () => {
      const jobId = randomUUID();
      const original = await generateMissionLive(s, missionId, jobId);
      const completedMission = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      expect(data(completedMission)).toMatchObject({
        completedRuns: 1,
        status: "awaiting_followup",
      });
      const resumed = await generateMissionLive(s, missionId, jobId);
      expect(resumed).toEqual(original);
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(provider.generate).toHaveBeenCalledTimes(1);
      await settled("query_embedding", 7n);
      await settled("text", 77n);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "content" } })),
      ).toBe(1);
      expect(
        await run((tx) =>
          tx.entity.count({ where: { kind: "work_packages" } }),
        ),
      ).toBe(1);
      expect(
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
        ),
      ).toEqual(completedMission);
    });
    it("duplicate concurrent generation job cannot pay for the query embedding twice", async () => {
      const jobId = randomUUID();
      const results = await Promise.allSettled([
        generateMissionLive(s, missionId, jobId),
        generateMissionLive(s, missionId, jobId),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(provider.generate).toHaveBeenCalledTimes(1);
      await settled("query_embedding", 7n);
      await settled("text", 77n);
    });
  },
);

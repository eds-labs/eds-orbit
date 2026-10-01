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
  type DbTx,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import { ingest } from "../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, update } from "../src/shared.ts";
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  // Route and cost tests switch to the real implementations.
  actualRouting: false,
}));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    resolveRoute: ((...args: Parameters<typeof actual.resolveRoute>) =>
      provider.actualRouting
        ? actual.resolveRoute(...args)
        : (args[1].taskRoutes?.[args[0]] ?? {
            model: "synthetic-test-model",
            maxOutputTokens: 1800,
          })) as typeof actual.resolveRoute,
    estimateCost: ((...args: Parameters<typeof actual.estimateCost>) =>
      provider.actualRouting
        ? actual.estimateCost(...args)
        : 1000) as typeof actual.estimateCost,
  };
});
import { generateMissionLive } from "../src/modules/generation.ts";
import { enqueue, planMission } from "../src/modules/workflow.ts";
import { checkClaims } from "../src/modules/policy.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import {
  resumeLiveDraftBatch,
  startApprovedLiveDraftBatch,
} from "../src/modules/draft-batch.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const bodies = [
  "BATCHFIX users keep control of every exchange account they connect.",
  "BATCHFIX paper trading lets strategies run without touching real funds.",
  "BATCHFIX market data charts and news share one focused workspace.",
  "BATCHFIX notifications arrive in app, on Telegram or through webhooks.",
  "BATCHFIX the AI workbench assists while every decision stays with you.",
];

describe.skipIf(!enabled)(
  "approved sequential draft batch / real SQL / mocked provider",
  () => {
    let auth: PrismaClient;
    let s: Scope;
    let missionId: string;
    let firstJobId: string;
    let calls: number;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(s.workspaceId, s.projectId, fn);

    beforeAll(() => {
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    });
    beforeEach(async () => {
      vi.stubEnv("EXECUTION_MODE", "test");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "false");
      calls = 0;
      provider.generate.mockReset().mockImplementation(async () => {
        const body = bodies[calls++ % bodies.length]!;
        return {
          output: {
            title: "Batch draft " + calls,
            body,
            claims: [{ text: body, kind: "style" }],
          },
          usage: {
            model: "synthetic-test-model",
            inputTokens: 40,
            outputTokens: 20,
            costMicros: 77,
          },
        };
      });
      provider.embed.mockReset().mockResolvedValue({
        vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
        usage: {
          model: "text-embedding-3-small",
          inputTokens: 20,
          outputTokens: 0,
          costMicros: 7,
        },
      });
      const user = await auth.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic batch owner",
          email: randomUUID() + "@example.invalid",
        },
      });
      const workspace = await auth.workspace.create({
        data: {
          name: "Isolated draft batch",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await auth.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Isolated draft batch fixture",
          mode: "observe",
        },
      });
      s = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      await createMission(3);
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await auth?.$disconnect();
      await closeDatabase();
    });

    async function createMission(maxContents: number) {
      const past = new Date(Date.now() - 3600_000).toISOString(),
        tomorrow = new Date(Date.now() + 24 * 3600_000),
        later = new Date(Date.now() + 48 * 3600_000).toISOString();
      await run(async (tx) => {
        const sourceId = (
          await create(tx, s, "sources", {
            name: "Approved batch source",
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
        await ingest(tx, s, {
          sourceId,
          externalId: "batch-fixture-" + randomUUID(),
          title: "BATCHFIX",
          text: "BATCHFIX verified project guidance for a local batch fixture.",
          mimeType: "text/plain",
          language: "en",
          validFrom: past,
        });
        if (
          !(await tx.entity.count({
            where: { projectId: s.projectId, kind: "policies" },
          }))
        )
          await create(tx, s, "policies", {
            mode: "observe",
            channels: ["test"],
            contentTypes: ["social"],
            allowedOrigins: [],
            startAt: past,
            endAt: later,
            maxPerDay: 3,
            minIntervalMinutes: 1,
            dailyBudgetMicros: 100_000,
            monthlyBudgetMicros: 1_000_000,
            perRunBudgetMicros: 10_000,
            approvedPaidTests: true,
            active: true,
          });
        const mission = await create(tx, s, "missions", {
          title: "Synthetic batch",
          goal: "BATCHFIX",
          audience: "Test",
          language: "en",
          channels: ["test"],
          startAt: tomorrow.toISOString(),
          endAt: later,
          maxContents,
          completedRuns: 0,
          targetAction: "read",
          sourceIds: [sourceId],
          contentType: "social",
          allowedActions: ["draft"],
          status: "ready",
          chatProposalId: randomUUID(),
          chatCostCeilingMicros: 3000,
        });
        missionId = mission.id;
        const job = await enqueue(
          tx,
          s,
          "generation",
          mission.id,
          "mission:" + mission.id + ":" + mission.version,
          tomorrow,
        );
        firstJobId = job.id;
        await tx.$executeRaw`SELECT set_config('app.user_id',${s.userId},true)`;
        const conversation = await tx.chatConversation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            userId: s.userId,
          },
        });
        await tx.chatProposal.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            userId: s.userId,
            conversationId: conversation.id,
            groupId: randomUUID(),
            version: 1,
            payload: { missionId: mission.id },
            payloadHash: "a".repeat(64),
            status: "confirmed",
            missionId: mission.id,
            jobId: job.id,
          },
        });
      });
    }
    const missionRow = () =>
      run((tx) => tx.entity.findUniqueOrThrow({ where: { id: missionId } }));
    const jobs = () =>
      run((tx) =>
        tx.entity.findMany({
          where: { projectId: s.projectId, kind: "jobs" },
          orderBy: { createdAt: "asc" },
        }),
      );
    const contents = () =>
      run((tx) =>
        tx.entity.findMany({
          where: { projectId: s.projectId, kind: "content" },
          orderBy: { createdAt: "asc" },
        }),
      );
    async function approve() {
      return run(async (tx) =>
        startApprovedLiveDraftBatch(
          tx,
          s,
          missionId,
          (await tx.entity.findUniqueOrThrow({ where: { id: missionId } }))
            .version,
        ),
      );
    }
    /** Mirrors the worker: run the single queued job and record its outcome. */
    async function workNext() {
      const queued = (await jobs()).filter(
        (job) => data(job).status === "queued",
      );
      expect(queued).toHaveLength(1);
      const job = queued[0]!;
      expect(data(job)).toMatchObject({ liveDraftOnce: true, maxAttempts: 1 });
      try {
        await generateMissionLive(s, missionId, job.id);
        await setJob(job.id, { status: "succeeded", attempts: 1 });
      } catch (error) {
        await setJob(job.id, {
          status: "blocked_dependency",
          attempts: 1,
          error: (error as Error).message,
        });
        throw error;
      }
      return job;
    }
    async function setJob(id: string, fields: Record<string, unknown>) {
      await run(async (tx) => {
        const job = await tx.entity.findUniqueOrThrow({ where: { id } });
        await update(tx, s, job, { ...data(job), ...fields });
      });
    }

    it("creates exactly the approved number of sequential single-attempt drafts", async () => {
      const approved = await approve();
      expect(approved).toMatchObject({
        jobId: firstJobId,
        size: 3,
        costCeilingMicros: 9000,
      });
      for (let i = 1; i <= 3; i++) {
        const job = await workNext();
        expect(data(job).batchRun).toBe(i);
      }
      const mission = await missionRow();
      expect(data(mission)).toMatchObject({
        status: "completed",
        completedRuns: 3,
        batch: { status: "completed", size: 3 },
      });
      expect(await jobs()).toHaveLength(3);
      expect(
        (await jobs()).every((job) => data(job).status === "succeeded"),
      ).toBe(true);
      const drafts = await contents();
      expect(drafts.map((c) => data(c).body)).toEqual(bodies.slice(0, 3));
      expect(drafts.every((c) => data(c).status === "draft")).toBe(true);
      const third = JSON.parse(provider.generate.mock.calls[2]![0].goal);
      expect(third.batch).toMatchObject({ run: 3, size: 3 });
      expect(third.batch.previousDrafts).toHaveLength(2);
      await run((tx) => sweepProject(tx, s));
      expect(await jobs()).toHaveLength(3);
    });

    it("keeps worker sweeps and manual runs from adding jobs to a batch", async () => {
      await approve();
      await run((tx) => sweepProject(tx, s));
      expect(await jobs()).toHaveLength(1);
      await expect(run((tx) => planMission(tx, s, missionId))).rejects.toThrow(
        "MISSION_BATCH_ACTIVE",
      );
      await workNext();
      await run((tx) => sweepProject(tx, s));
      expect(
        (await jobs()).filter((job) => data(job).status === "queued"),
      ).toHaveLength(1);
    });

    it("stops at the batch cost ceiling and resumes only an uncharged run", async () => {
      await approve();
      await workNext();
      await run(async (tx) => {
        const mission = await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        });
        await update(tx, s, mission, {
          ...data(mission),
          batch: { ...data(mission).batch, costCeilingMicros: 500 },
        });
      });
      await expect(workNext()).rejects.toThrow("BATCH_BUDGET_EXHAUSTED");
      expect(provider.generate).toHaveBeenCalledTimes(1);
      const resume = async () =>
        run(async (tx) =>
          resumeLiveDraftBatch(
            tx,
            s,
            missionId,
            (await tx.entity.findUniqueOrThrow({ where: { id: missionId } }))
              .version,
          ),
        );
      await expect(resume()).rejects.toThrow("BATCH_BUDGET_EXHAUSTED");
      await run(async (tx) => {
        const mission = await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        });
        await update(tx, s, mission, {
          ...data(mission),
          batch: { ...data(mission).batch, costCeilingMicros: 9000 },
        });
      });
      const resumed = await resume();
      expect(resumed.run).toBe(2);
      await expect(resume()).rejects.toThrow("BATCH_RUN_IN_PROGRESS");
      expect(
        data((await jobs()).find((job) => job.id === resumed.jobId)!),
      ).toMatchObject({
        batchRun: 2,
        maxAttempts: 1,
        liveDraftOnce: true,
        resumeOfJobId: resumed.blockedJobId,
      });
      await workNext();
      await workNext();
      expect(data(await missionRow()).batch.status).toBe("completed");
      expect(await contents()).toHaveLength(3);
    });

    it("refuses to resume a run that may have been charged", async () => {
      await approve();
      await workNext();
      const second = (await jobs()).find(
        (job) => data(job).status === "queued",
      )!;
      await setJob(second.id, {
        status: "blocked_dependency",
        attempts: 1,
        error: "MODEL_OUTCOME_OR_COST_UNKNOWN",
      });
      await run((tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key: s.projectId + ":" + second.id,
            category: "text",
            amountMicros: 1000n,
            state: "unknown",
          },
        }),
      );
      await expect(
        run(async (tx) =>
          resumeLiveDraftBatch(
            tx,
            s,
            missionId,
            (await tx.entity.findUniqueOrThrow({ where: { id: missionId } }))
              .version,
          ),
        ),
      ).rejects.toThrow("RESERVATION_ALREADY_USED");
    });

    it("flags a near-identical batch draft for review", async () => {
      provider.generate.mockImplementation(async () => ({
        output: {
          title: "Repeated",
          body: bodies[0],
          claims: [{ text: bodies[0], kind: "style" }],
        },
        usage: {
          model: "synthetic-test-model",
          inputTokens: 40,
          outputTokens: 20,
          costMicros: 77,
        },
      }));
      await approve();
      await workNext();
      await workNext();
      const [first, second] = await contents();
      expect(
        (await run((tx) => checkClaims(tx, s, first!.id))).problems,
      ).not.toContain("DUPLICATE_MISSION_DRAFT");
      expect(
        (await run((tx) => checkClaims(tx, s, second!.id))).problems,
      ).toContain("DUPLICATE_MISSION_DRAFT");
    });

    it("allows only batches of two to five drafts", async () => {
      for (const size of [1, 6]) {
        await createMission(size);
        await expect(approve()).rejects.toThrow("BATCH_SIZE_NOT_ALLOWED");
      }
    });
  },
);

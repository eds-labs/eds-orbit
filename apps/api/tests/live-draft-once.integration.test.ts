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
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, update } from "../src/shared.ts";
import {
  enqueue,
  planMission,
  startApprovedLiveDraftOnce,
} from "../src/modules/workflow.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "one approved live draft from a confirmed future mission",
  () => {
    let auth: PrismaClient;
    let scope: Scope;
    let missionId: string;
    let jobId: string;
    let policyId: string;
    let conversationId: string;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, fn);

    beforeAll(() => {
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    });
    beforeEach(async () => {
      vi.stubEnv("EXECUTION_MODE", "test");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "false");
      const user = await auth.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic owner",
          email: randomUUID() + "@example.invalid",
        },
      });
      const workspace = await auth.workspace.create({
        data: {
          name: "Isolated one-draft test",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await auth.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Isolated uLiquid fixture",
          mode: "observe",
        },
      });
      scope = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      const later = new Date(Date.now() + 48 * 3600_000);
      await run(async (tx) => {
        const policy = await create(tx, scope, "policies", {
          active: true,
          mode: "observe",
          startAt: new Date(Date.now() - 3600_000).toISOString(),
          endAt: later.toISOString(),
          channels: ["telegram"],
          contentTypes: ["social"],
          approvedPaidTests: true,
          perRunBudgetMicros: 10_000_000,
          dailyBudgetMicros: 10_000_000,
          monthlyBudgetMicros: 10_000_000,
        });
        policyId = policy.id;
        const mission = await create(tx, scope, "missions", {
          title: "Synthetic confirmed draft",
          status: "ready",
          startAt: tomorrow.toISOString(),
          endAt: later.toISOString(),
          maxContents: 1,
          completedRuns: 0,
          allowedActions: ["draft"],
          channels: ["telegram"],
          contentType: "social",
          assetIds: [],
        });
        missionId = mission.id;
        const job = await enqueue(
          tx,
          scope,
          "generation",
          mission.id,
          "mission:" + mission.id + ":" + mission.version,
          tomorrow,
        );
        jobId = job.id;
        await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
        const conversation = await tx.chatConversation.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            userId: scope.userId,
          },
        });
        conversationId = conversation.id;
        await tx.chatProposal.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            userId: scope.userId,
            conversationId,
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
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await auth?.$disconnect();
      await closeDatabase();
    });

    it("advances only the confirmed job, preserves the end date and blocks a second queue", async () => {
      const before = await run(async (tx) => ({
        mission: await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        }),
        outbox: await tx.outbox.findFirstOrThrow({
          where: { entityId: jobId },
        }),
      }));
      const result = await run((tx) =>
        startApprovedLiveDraftOnce(
          tx,
          scope,
          missionId,
          before.mission.version,
        ),
      );
      expect(result.jobId).toBe(jobId);
      const after = await run(async (tx) => ({
        mission: await tx.entity.findUniqueOrThrow({
          where: { id: missionId },
        }),
        job: await tx.entity.findUniqueOrThrow({ where: { id: jobId } }),
        outbox: await tx.outbox.findFirstOrThrow({
          where: { entityId: jobId },
        }),
        reservations: await tx.budgetReservation.count({
          where: { projectId: scope.projectId },
        }),
        content: await tx.entity.count({
          where: { projectId: scope.projectId, kind: "content" },
        }),
        jobs: await tx.entity.count({
          where: { projectId: scope.projectId, kind: "jobs" },
        }),
      }));
      expect(data(after.mission).endAt).toBe(data(before.mission).endAt);
      expect(Date.parse(data(after.mission).startAt)).toBeLessThan(
        Date.parse(data(before.mission).startAt),
      );
      expect(data(after.job)).toMatchObject({
        status: "queued",
        attempts: 0,
        maxAttempts: 1,
        liveDraftOnce: true,
      });
      expect(after.outbox.id).toBe(before.outbox.id);
      expect(after.outbox.dispatchedAt).toBeNull();
      expect(after.outbox.availableAt.getTime()).toBeLessThan(
        before.outbox.availableAt.getTime(),
      );
      expect(after.reservations).toBe(0);
      expect(after.content).toBe(0);
      expect(after.jobs).toBe(1);
      expect((await run((tx) => planMission(tx, scope, missionId))).id).toBe(
        jobId,
      );
      await expect(
        run((tx) =>
          startApprovedLiveDraftOnce(
            tx,
            scope,
            missionId,
            before.mission.version,
          ),
        ),
      ).rejects.toThrow("VERSION_CONFLICT");
      expect(
        await run((tx) =>
          tx.entity.count({
            where: { projectId: scope.projectId, kind: "jobs" },
          }),
        ),
      ).toBe(1);
    });

    it("rejects editor approval and budgets above the owner's ten-dollar ceiling", async () => {
      const version = (
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
        )
      ).version;
      await expect(
        run((tx) =>
          startApprovedLiveDraftOnce(
            tx,
            { ...scope, role: "editor" },
            missionId,
            version,
          ),
        ),
      ).rejects.toThrow("FORBIDDEN");
      await run(async (tx) => {
        const policy = await tx.entity.findUniqueOrThrow({
          where: { id: policyId },
        });
        await update(tx, scope, policy, {
          ...data(policy),
          perRunBudgetMicros: 10_000_001,
        });
      });
      await expect(
        run((tx) => startApprovedLiveDraftOnce(tx, scope, missionId, version)),
      ).rejects.toThrow("PAID_MANDATE_REQUIRED");
      const job = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: jobId } }),
      );
      expect(data(job).maxAttempts).toBe(3);
      expect(data(job).liveDraftOnce).toBeUndefined();
    });

    it("requires a future draft-only mission and leaves the queued job unchanged", async () => {
      const original = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      await run((tx) =>
        update(tx, scope, original, {
          ...data(original),
          allowedActions: ["draft", "publish_test"],
        }),
      );
      const changed = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      await expect(
        run((tx) =>
          startApprovedLiveDraftOnce(tx, scope, missionId, changed.version),
        ),
      ).rejects.toThrow("MISSION_NOT_READY");
      await run((tx) =>
        update(tx, scope, changed, {
          ...data(changed),
          allowedActions: ["draft"],
          startAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const active = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      await expect(
        run((tx) =>
          startApprovedLiveDraftOnce(tx, scope, missionId, active.version),
        ),
      ).rejects.toThrow("MISSION_ALREADY_ACTIVE");
      const job = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: jobId } }),
      );
      expect(data(job).maxAttempts).toBe(3);
      expect(data(job).liveDraftOnce).toBeUndefined();
    });

    it("does not advance a job without the exact confirmed proposal", async () => {
      await run(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
        return tx.chatProposal.updateMany({
          where: { projectId: scope.projectId, conversationId },
          data: { status: "proposed" },
        });
      });
      const version = (
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
        )
      ).version;
      await expect(
        run((tx) => startApprovedLiveDraftOnce(tx, scope, missionId, version)),
      ).rejects.toThrow("CONFIRMED_PROPOSAL_REQUIRED");
    });

    it("creates one new single-attempt job after the original evidence failure", async () => {
      const mission = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      await run(async (tx) => {
        await update(tx, scope, mission, {
          ...data(mission),
          startAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const original = await tx.entity.findUniqueOrThrow({
          where: { id: jobId },
        });
        await update(tx, scope, original, {
          ...data(original),
          status: "blocked_dependency",
          attempts: 1,
          error: "INSUFFICIENT_EVIDENCE",
        });
        await tx.outbox.updateMany({
          where: { entityId: jobId },
          data: { dispatchedAt: new Date() },
        });
      });
      const version = (
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
        )
      ).version;
      const result = await run((tx) =>
        startApprovedLiveDraftOnce(tx, scope, missionId, version),
      );
      expect(result.jobId).not.toBe(jobId);
      expect(result.blockedJobId).toBe(jobId);
      const state = await run(async (tx) => ({
        old: await tx.entity.findUniqueOrThrow({ where: { id: jobId } }),
        next: await tx.entity.findUniqueOrThrow({
          where: { id: result.jobId },
        }),
        outbox: await tx.outbox.findMany({
          where: { entityId: result.jobId },
        }),
      }));
      expect(data(state.old)).toMatchObject({
        status: "blocked_dependency",
        attempts: 1,
        error: "INSUFFICIENT_EVIDENCE",
      });
      expect(data(state.next)).toMatchObject({
        status: "queued",
        attempts: 0,
        maxAttempts: 1,
        liveDraftOnce: true,
        recoveryOfJobId: jobId,
      });
      expect(state.outbox).toHaveLength(1);
      await expect(
        run((tx) => startApprovedLiveDraftOnce(tx, scope, missionId, version)),
      ).rejects.toThrow("MISSION_JOB_ALREADY_EXISTS");
    });

    it("refuses recovery when the original run may have incurred a charge", async () => {
      const mission = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
      );
      await run(async (tx) => {
        await update(tx, scope, mission, {
          ...data(mission),
          startAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const original = await tx.entity.findUniqueOrThrow({
          where: { id: jobId },
        });
        await update(tx, scope, original, {
          ...data(original),
          status: "blocked_dependency",
          attempts: 1,
          error: "INSUFFICIENT_EVIDENCE",
        });
        await tx.outbox.updateMany({
          where: { entityId: jobId },
          data: { dispatchedAt: new Date() },
        });
        await tx.budgetReservation.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            key: scope.projectId + ":" + jobId,
            category: "generation",
            amountMicros: 1n,
            state: "reserved",
          },
        });
      });
      const version = (
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: missionId } }),
        )
      ).version;
      await expect(
        run((tx) => startApprovedLiveDraftOnce(tx, scope, missionId, version)),
      ).rejects.toThrow("RESERVATION_ALREADY_USED");
    });
  },
);

import {createPostizClient} from "../../../packages/connectors/src/index.ts";
import {exception} from "../src/shared.ts";
import { blockCalendar, unblockCalendar } from "../src/modules/calendar.ts";
import { prepareFollowup } from "../src/modules/planning.ts";
import { finishPublication } from "../src/modules/workflow.ts";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type PrismaClient,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, update, data, entity } from "../src/shared.ts";
import { ingest, setFact } from "../../../packages/knowledge/src/index.ts";
import {
  deterministicDraft,
  reviewContent,
  publishIntent,
  claimPublication,
  enqueue,
  analyze,
} from "../src/modules/workflow.ts";
import { packageFor, approve } from "../src/modules/policy.ts";
import { reserve, markTransmitted, settle } from "../src/modules/budget.ts";
import {
  correctMetric,
  memoryLifecycle,
  evaluateExperiment,
  sweepProject,
} from "../src/modules/lifecycle.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Safety regressions against restricted PostgreSQL roles",
  () => {
    let db: PrismaClient,
      auth: PrismaClient,
      scope: Scope,
      workspaceId: string,
      userId: string,
      sourceId: string;
    const past = new Date(Date.now() - 86400000).toISOString(),
      future = new Date(Date.now() + 30 * 86400000).toISOString();
    const policy = {
      mode: "autopilot" as const,
      channels: ["test-social"],
      contentTypes: ["social" as const],
      allowedOrigins: [],
      startAt: past,
      endAt: future,
      maxPerDay: 3,
      minIntervalMinutes: 1,
      dailyBudgetMicros: 100,
      monthlyBudgetMicros: 200,
      perRunBudgetMicros: 100,
      approvedPaidTests: true,
    };
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, fn, db);
    beforeAll(async () => {
      db = createClient(process.env.TEST_DATABASE_URL!);
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
      userId = randomUUID();
      await auth.user.create({
        data: {
          id: userId,
          name: "Synthetic safety owner",
          email: userId + "@example.invalid",
        },
      });
      const w = await auth.workspace.create({
        data: {
          name: "Synthetic safety suite",
          members: { create: { userId, role: "owner" } },
        },
      });
      workspaceId = w.id;
    });
    beforeEach(async () => {
      const p = await auth.project.create({
        data: {
          workspaceId,
          name: "Regression fixture",
          timezone: "Europe/Berlin",
          mode: "autopilot",
        },
      });
      scope = { workspaceId, projectId: p.id, userId, role: "owner" };
      await run(async (tx) => {
        const s = await create(tx, scope, "sources", {
          status: "active",
          generation: 1,
          publicUse: true,
          modelUse: false,
          authority: "official",
          maxAgeHours: 168,
          allowedOrigins: [],
          allowedPaths: ["/"],
        });
        sourceId = s.id;
        await ingest(tx, scope, {
          sourceId,
          externalId: "fixture",
          title: "Price",
          text: "Confirmed Orbit fixture calendar.",
          mimeType: "text/plain",
          language: "en",
          expectedGeneration: 1,
        });
        await setFact(tx, scope, {
          key: "price",
          value: "19",
          valueType: "decimal",
          currency: "EUR",
          language: "en",
          sourceId,
          validFrom: past,
          validUntil: future,
          status: "verified",
          publicUse: true,
          modelUse: false,
        });
        await create(tx, scope, "policies", { ...policy, active: true });
      });
    });
    afterAll(async () => {
      await auth?.workspace.delete({ where: { id: workspaceId } });
      await auth?.user.delete({ where: { id: userId } });
      await db?.$disconnect();
      await auth?.$disconnect();
    });
    async function draft() {
      return run(async (tx) => {
        const m = await create(tx, scope, "missions", {
          title: "Price",
          goal: "price",
          audience: "Synthetic",
          language: "en",
          channels: ["test-social"],
          startAt: past,
          endAt: future,
          maxContents: 1,
          targetAction: "read",
          sourceIds: [sourceId],
          contentType: "social",
          status: "ready",
        });
        const [c] = await deterministicDraft(tx, scope, m.id);
        return reviewContent(tx, scope, c!.id, c!.version);
      });
    }
    it("SR02/A11: omitted publish date inherits the saved approved schedule and cannot run early", async () => {
      const c = await draft();
      const scheduledAt = new Date(Date.now() + 86400000).toISOString();
      const saved = await run((tx) =>
        update(tx, scope, c, { ...data(c), scheduledAt }),
      );
      const p = await run((tx) =>
        publishIntent(tx, scope, { contentId: c.id, version: saved.version }),
      );
      expect(data(p).scheduledAt).toBe(scheduledAt);
      await expect(
        run((tx) => claimPublication(tx, scope, p.id)),
      ).rejects.toThrow("NOT_DUE");
    });
    it("SR03/A21: oldest idempotency key remains effective beyond 500 jobs", async () => {
      const first = await run((tx) =>
        enqueue(tx, scope, "analytics", randomUUID(), "oldest"),
      );
      await run((tx) =>
        tx.entity.createMany({
          data: Array.from({ length: 501 }, (_, i) => ({
            workspaceId,
            projectId: scope.projectId,
            kind: "jobs",
            data: { idempotencyKey: "later-" + i },
          })),
        }),
      );
      expect(
        (
          await run((tx) =>
            enqueue(tx, scope, "analytics", randomUUID(), "oldest"),
          )
        ).id,
      ).toBe(first.id);
    });
    it("SR04: changing publisher connector changes the approval package", async () => {
      const c = await draft();
      const connector = await run((tx) =>
        create(tx, scope, "connectors", {
          provider: "postiz",
          status: "write_verified",
          baseUrl: "https://example.invalid/api",
          channels: ["test-social"],
        }),
      );
      const before = await run((tx) => packageFor(tx, scope, c.id));
      await run((tx) =>
        update(tx, scope, connector, {
          ...data(connector),
          baseUrl: "https://different.example.invalid/api",
        }),
      );
      expect(
        (await run((tx) => packageFor(tx, scope, c.id))).packageHash,
      ).not.toBe(before.packageHash);
    });
    it("SR01/A12: in-flight or settled reservation never authorizes a second transmission", async () => {
      const r = await run((tx) =>
        reserve(tx, scope, "once", "text", 30, policy),
      );
      await run((tx) => markTransmitted(tx, scope, r.id));
      await expect(
        run((tx) => markTransmitted(tx, scope, r.id)),
      ).rejects.toThrow();
      await run((tx) => settle(tx, scope, r.id, 12));
      await expect(
        run((tx) => reserve(tx, scope, "once", "text", 30, policy)),
      ).rejects.toThrow("RESERVATION_ALREADY_USED");
      expect(
        (
          await run((tx) =>
            tx.budgetReservation.findUniqueOrThrow({ where: { id: r.id } }),
          )
        ).settledMicros,
      ).toBe(12n);
    });
    it("A20: ambiguous publication is never blindly claimed again", async () => {
      const c = await draft();
      const p = await run((tx) =>
        publishIntent(tx, scope, { contentId: c.id, version: c.version }),
      );
      await run((tx) =>
        update(tx, scope, p, { ...data(p), status: "outcome_unknown" }),
      );
      expect((await run((tx) => claimPublication(tx, scope, p.id))).send).toBe(
        false,
      );
    });
    it("K27/B08: correcting metrics invalidates insight and deletion purges historical memory", async () => {
      const m = await run((tx) =>
        create(tx, scope, "metrics", {
          source: "manual_test",
          externalId: "one",
          campaign: "one",
          sampleSize: 40,
          clicks: 2,
          sessions: null,
          conversions: null,
          currency: "EUR",
          timezone: "UTC",
        }),
      );
      const insight = await run((tx) => analyze(tx, scope, "one"));
      await run((tx) =>
        correctMetric(
          tx,
          scope,
          m.id,
          m.version,
          { clicks: 4 },
          "Corrected synthetic fixture",
        ),
      );
      expect(
        data(await run((tx) => entity(tx, scope, "insights", insight.id)))
          .status,
      ).toBe("invalidated");
      const current = await run((tx) =>
        entity(tx, scope, "insights", insight.id),
      );
      await run((tx) =>
        memoryLifecycle(
          tx,
          scope,
          "insights",
          current.id,
          current.version,
          "delete",
        ),
      );
      const history = await run((tx) =>
        tx.entityVersion.findMany({ where: { entityId: current.id } }),
      );
      expect(history).toHaveLength(1);
      expect(data(history[0]!).status).toBe("deleted");
    });
    it("A27: experiment with inadequate samples never declares a winner", async () => {
      const e = await run((tx) =>
        create(tx, scope, "experiments", {
          name: "Synthetic",
          variants: ["a", "b"],
          primaryMetric: "clicks",
          minimumSample: 30,
          startAt: past,
          endAt: future,
          status: "planned",
        }),
      );
      const result = await run((tx) => evaluateExperiment(tx, scope, e.id));
      expect(data(result).result).toBe("insufficient_data");
      expect(data(result).winner).toBeNull();
    });
    it("B03: calendar blocks stop pending publication and require new review after release", async () => {
      const c = await draft(),
        pub = await run((tx) =>
          publishIntent(tx, scope, { contentId: c.id, version: c.version }),
        );
      const block = await run((tx) =>
        blockCalendar(tx, scope, {
          title: "Owner blackout",
          channels: ["test-social"],
          startAt: past,
          endAt: future,
          reason: "Manual fixture hold",
        }),
      );
      expect(
        data(await run((tx) => entity(tx, scope, "publications", pub.id)))
          .status,
      ).toBe("blocked_dependency");
      expect(
        (await run((tx) => claimPublication(tx, scope, pub.id))).send,
      ).toBe(false);
      await expect(
        run((tx) =>
          publishIntent(tx, scope, { contentId: c.id, version: c.version }),
        ),
      ).rejects.toThrow("MANUAL_CALENDAR_BLOCK");
      await run((tx) => unblockCalendar(tx, scope, block.id, block.version));
      expect(
        (await run((tx) => claimPublication(tx, scope, pub.id))).send,
      ).toBe(false);
    });
    it("B06: seven-day cycle updates knowledge, survives a pause, keeps an exception and follows measured memory within quota", async () => {
      const base = Date.now();
      const clock = (day: number) => vi.setSystemTime(base + day * 86400000);
      try {
        clock(0);
        const mission = await run((tx) =>
          create(tx, scope, "missions", {
            title: "Seven day verified cycle",
            goal: "price",
            audience: "Synthetic",
            language: "en",
            channels: ["test-social"],
            startAt: new Date(base - 1000).toISOString(),
            endAt: new Date(base + 7 * 86400000).toISOString(),
            maxContents: 3,
            targetAction: "read",
            sourceIds: [sourceId],
            contentType: "social",
            status: "ready",
          }),
        );
        const [first] = await run((tx) =>
          deterministicDraft(tx, scope, mission.id),
        );
        const reviewed = await run((tx) =>
          reviewContent(tx, scope, first!.id, first!.version),
        );
        const pub = await run((tx) =>
          publishIntent(tx, scope, {
            contentId: reviewed.id,
            version: reviewed.version,
          }),
        );
        const claim = await run((tx) => claimPublication(tx, scope, pub.id));
        await run((tx) =>
          finishPublication(tx, scope, pub.id, data(claim.pub).fence, {
            status: "published_test",
            remoteId: "test-seven-days",
          }),
        );
        clock(1);
        await run((tx) =>
          create(tx, scope, "metrics", {
            source: "manual_test",
            externalId: "seven-day-1",
            campaign: mission.id,
            currency: "EUR",
            timezone: "UTC",
            sampleSize: 40,
            clicks: 4,
            sessions: 40,
            conversions: 1,
            costMicros: 0,
          }),
        );
        const insight = await run((tx) => analyze(tx, scope, mission.id));
        expect(data(insight).status).toBe("observed");
        clock(2);
        const unavailable=vi.fn(async()=>{throw new Error('Synthetic provider outage')});
        await expect(createPostizClient({baseUrl:'https://postiz.example/public/v1',token:'synthetic-seven-day-token',fetch:unavailable}).healthcheck()).rejects.toThrow();
        expect(unavailable).toHaveBeenCalledTimes(1);
        await run(tx=>exception(tx,scope,'PROVIDER_UNAVAILABLE',mission.id));
        await run((tx) =>
          tx.project.update({
            where: { id: scope.projectId },
            data: { paused: true },
          }),
        );
        expect((await run((tx) => sweepProject(tx, scope))).queued).toBe(0);
        clock(3);
        await run((tx) =>
          tx.project.update({
            where: { id: scope.projectId },
            data: { paused: false },
          }),
        );
        await run((tx) => prepareFollowup(tx, scope, mission.id));
        const current = data(
          await run((tx) => entity(tx, scope, "missions", mission.id)),
        );
        expect(current.planContext.insights[0].id).toBe(insight.id);
        expect(current.maxContents).toBe(3);
        const duplicate = await run((tx) =>
          deterministicDraft(tx, scope, mission.id),
        );
        expect(duplicate).toEqual([]);
        expect(
          data(await run((tx) => entity(tx, scope, "missions", mission.id)))
            .completedRuns,
        ).toBe(2);
        clock(4);
        await run((tx) =>
          ingest(tx, scope, {
            sourceId,
            externalId: "fixture",
            title: "Price update",
            text: "Confirmed Orbit fixture knowledge updated.",
            mimeType: "text/plain",
            language: "en",
            expectedGeneration: 1,
          }),
        );
        clock(5);
        await run((tx) => prepareFollowup(tx, scope, mission.id));
        await run((tx) =>
          tx.project.update({
            where: { id: scope.projectId },
            data: { paused: true },
          }),
        );
        await run((tx) => sweepProject(tx, scope));
        expect(
          data(await run((tx) => entity(tx, scope, "missions", mission.id)))
            .maxContents,
        ).toBe(3);
        clock(6);
        await run((tx) =>
          tx.project.update({
            where: { id: scope.projectId },
            data: { paused: false },
          }),
        );
        const [last] = await run((tx) =>
          deterministicDraft(tx, scope, mission.id),
        );
        if (last) {
          const r = await run((tx) =>
            reviewContent(tx, scope, last.id, last.version),
          );
          expect(["reviewed", "needs_review"]).toContain(data(r).status);
        }
        const end = data(
          await run((tx) => entity(tx, scope, "missions", mission.id)),
        );
        expect(await run(tx=>tx.entity.count({where:{projectId:scope.projectId,kind:"exceptions"}}))).toBeGreaterThan(0);
        expect(end.completedRuns).toBe(3);
        expect(end.status).toBe("completed");
        expect(
          await run((tx) =>
            tx.budgetReservation.count({
              where: { projectId: scope.projectId },
            }),
          ),
        ).toBe(0);
        expect(
          await run((tx) =>
            tx.entity.count({
              where: { projectId: scope.projectId, kind: "publications" },
            }),
          ),
        ).toBe(1);
        expect(
          data(await run((tx) => entity(tx, scope, "publications", pub.id)))
            .test,
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
    it("B06 prerequisite: seven simulated daily sweeps preserve one bounded durable mission job", async () => {
      const m = await run((tx) =>
        create(tx, scope, "missions", {
          title: "Seven days",
          goal: "price",
          startAt: past,
          endAt: future,
          maxContents: 1,
          status: "ready",
        }),
      );
      for (let day = 0; day < 7; day++)
        await run((tx) =>
          sweepProject(tx, scope, new Date(Date.now() + day * 86400000)),
        );
      const jobs = await run((tx) =>
        tx.entity.findMany({
          where: { projectId: scope.projectId, kind: "jobs" },
        }),
      );
      expect(jobs.filter((j) => data(j).resourceId === m.id)).toHaveLength(1);
      expect(
        await run((tx) =>
          tx.outbox.count({ where: { projectId: scope.projectId } }),
        ),
      ).toBe(1);
    });
  },
);

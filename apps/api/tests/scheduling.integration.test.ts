import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  closeDatabase,
  type DbTx,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  ingest,
  retrieve,
  setFact,
} from "../../../packages/knowledge/src/index.ts";
import { create, data } from "../src/shared.ts";
import { preflight } from "../src/modules/policy.ts";
import {
  claimPublication,
  finishPublication,
  publishIntent,
} from "../src/modules/workflow.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const berlin = (instant: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));

describe.skipIf(!enabled)(
  "A23 real SQL scheduling across Berlin DST and competing campaigns",
  () => {
    let db: PrismaClient,
      auth: PrismaClient,
      scope: Scope | undefined,
      sourceId: string;
    let startAt: string, endAt: string, sequence: number;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope!.workspaceId, scope!.projectId, fn, db);
    beforeAll(() => {
      db = createClient(process.env.TEST_DATABASE_URL!);
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    });
    beforeEach(() => {
      sequence = 0;
      vi.stubEnv("EXECUTION_MODE", "test");
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      if (scope) {
        await auth.workspace.delete({ where: { id: scope.workspaceId } });
        await auth.user.delete({ where: { id: scope.userId } });
        scope = undefined;
      }
    });
    afterAll(async () => {
      await db?.$disconnect();
      await auth?.$disconnect();
    });
    async function fixture(
      now: string,
      limits: { maxPerDay: number; minIntervalMinutes: number },
    ) {
      vi.setSystemTime(new Date(now));
      startAt = new Date(Date.now() - 3600000).toISOString();
      endAt = new Date(Date.now() + 3 * 86400000).toISOString();
      const user = await auth.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic DST owner",
          email: randomUUID() + "@example.invalid",
        },
      });
      const workspace = await auth.workspace.create({
        data: {
          name: "Synthetic DST scheduling",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await auth.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Synthetic DST project",
          timezone: "Europe/Berlin",
          mode: "autopilot",
        },
      });
      scope = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      await run(async (tx) => {
        sourceId = (
          await create(tx, scope!, "sources", {
            name: "Synthetic scheduling source",
            type: "manual",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: false,
            authority: "official",
            maxAgeHours: 168,
            allowedOrigins: [],
            allowedPaths: [],
          })
        ).id;
        await ingest(tx, scope!, {
          sourceId,
          externalId: "dst-fixture",
          title: "Synthetic verified slots",
          text: "Synthetic scheduling fixture contains no real campaign data.",
          mimeType: "text/plain",
          language: "en",
          validFrom: startAt,
        });
        await create(tx, scope!, "policies", {
          mode: "autopilot",
          active: true,
          channels: ["test-social"],
          contentTypes: ["social"],
          allowedOrigins: [],
          startAt,
          endAt,
          ...limits,
          dailyBudgetMicros: 100,
          monthlyBudgetMicros: 200,
          perRunBudgetMicros: 100,
          approvedPaidTests: false,
        });
      });
    }
    async function content(scheduledAt: string) {
      const n = ++sequence,
        key = "slot_" + n,
        value = "Distinct synthetic campaign " + n;
      return run(async (tx) => {
        const fact = await setFact(tx, scope!, {
          key,
          value,
          valueType: "text",
          language: "en",
          sourceId,
          validFrom: startAt,
          validUntil: endAt,
          status: "verified",
          publicUse: true,
          modelUse: false,
        });
        const evidence = await retrieve(tx, scope!, {
          query: key,
          factKeys: [key],
          sourceIds: [sourceId],
          language: "en",
          purpose: "public",
          at: new Date(),
        });
        const mission = await create(tx, scope!, "missions", {
          title: value,
          goal: key,
          audience: "Synthetic",
          language: "en",
          channels: ["test-social"],
          startAt,
          endAt,
          maxContents: 1,
          targetAction: "read",
          sourceIds: [sourceId],
          contentType: "social",
          status: "ready",
          allowedActions: ["publish_test"],
        });
        const body = key + ": " + value;
        return create(tx, scope!, "content", {
          title: value,
          body,
          type: "social",
          language: "en",
          channel: "test-social",
          missionId: mission.id,
          evidenceId: evidence.id,
          claims: [{ kind: "fact", factId: fact.id, text: body }],
          status: "reviewed",
          risk: "routine",
          synthetic: true,
          origin: "generated_derived",
          scheduledAt,
        });
      });
    }
    async function schedule(row: Awaited<ReturnType<typeof content>>) {
      return run((tx) =>
        publishIntent(tx, scope!, { contentId: row.id, version: row.version }),
      );
    }
    async function assertPreflight(
      row: Awaited<ReturnType<typeof content>>,
      at: string,
    ) {
      expect(
        await run((tx) =>
          preflight(tx, scope!, row.id, { test: true, at: new Date(at) }),
        ),
      ).toMatchObject({ allowed: true, blockers: [] });
    }
    it("fall-back stores both 02:30 instants distinctly and never repeats the same package", async () => {
      await fixture("2026-10-24T22:00:00.000Z", {
        maxPerDay: 3,
        minIntervalMinutes: 60,
      });
      const firstAt = "2026-10-25T00:30:00.000Z",
        secondAt = "2026-10-25T01:30:00.000Z";
      expect([berlin(firstAt), berlin(secondAt)]).toEqual(["02:30", "02:30"]);
      const first = await content(firstAt),
        second = await content(secondAt);
      await assertPreflight(first, firstAt);
      await assertPreflight(second, secondAt);
      const [a, b, duplicate] = await Promise.all([
        schedule(first),
        schedule(second),
        schedule(first),
      ]);
      expect(duplicate.id).toBe(a.id);
      expect(a.id).not.toBe(b.id);
      expect([data(a).scheduledAt, data(b).scheduledAt]).toEqual([
        firstAt,
        secondAt,
      ]);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "publications" } })),
      ).toBe(2);
      expect(
        await run((tx) => tx.outbox.count({ where: { topic: "publishing" } })),
      ).toBe(2);
      vi.setSystemTime(new Date(firstAt));
      const claim = await run((tx) => claimPublication(tx, scope!, a.id));
      expect(claim.send).toBe(true);
      await run((tx) =>
        finishPublication(tx, scope!, a.id, data(claim.pub).fence, {
          status: "published_test",
          remoteId: "synthetic-fall-first",
        }),
      );
      vi.setSystemTime(new Date(secondAt));
      expect((await run((tx) => claimPublication(tx, scope!, a.id))).send).toBe(
        false,
      );
      expect((await run((tx) => claimPublication(tx, scope!, b.id))).send).toBe(
        true,
      );
    });
    it("spring-forward spacing uses elapsed instants across the missing 02:00 hour", async () => {
      await fixture("2026-03-29T00:00:00.000Z", {
        maxPerDay: 3,
        minIntervalMinutes: 90,
      });
      const firstAt = "2026-03-29T00:30:00.000Z",
        tooSoonAt = "2026-03-29T01:30:00.000Z",
        boundaryAt = "2026-03-29T02:00:00.000Z";
      expect([berlin(firstAt), berlin(tooSoonAt), berlin(boundaryAt)]).toEqual([
        "01:30",
        "03:30",
        "04:00",
      ]);
      const first = await content(firstAt),
        tooSoon = await content(tooSoonAt),
        boundary = await content(boundaryAt);
      await assertPreflight(first, firstAt);
      await assertPreflight(tooSoon, tooSoonAt);
      await schedule(first);
      await expect(schedule(tooSoon)).rejects.toThrow("CHANNEL_SPACING");
      expect(data(await schedule(boundary)).scheduledAt).toBe(boundaryAt);
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "publications" } })),
      ).toBe(2);
    });
    it("parallel campaigns share Berlin-day quota across UTC midnight and reset at local midnight", async () => {
      await fixture("2026-10-24T21:00:00.000Z", {
        maxPerDay: 2,
        minIntervalMinutes: 30,
      });
      const rows = [];
      for (const at of [
        "2026-10-24T22:30:00.000Z",
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T01:30:00.000Z",
      ])
        rows.push(await content(at));
      const outcomes = await Promise.allSettled(rows.map(schedule));
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const rejected = outcomes.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]!.reason)).toContain("CHANNEL_DAILY_QUOTA");
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "publications" } })),
      ).toBe(2);
      const nextDayAt = "2026-10-25T23:15:00.000Z";
      expect(berlin(nextDayAt)).toBe("00:15");
      const nextDay = await content(nextDayAt);
      expect(data(await schedule(nextDay)).scheduledAt).toBe(nextDayAt);
    });
    it("parallel campaigns cannot overrun the shared channel spacing fence", async () => {
      await fixture("2026-10-25T10:00:00.000Z", {
        maxPerDay: 10,
        minIntervalMinutes: 30,
      });
      const a = await content("2026-10-25T12:00:00.000Z"),
        b = await content("2026-10-25T12:15:00.000Z");
      const outcomes = await Promise.allSettled([schedule(a), schedule(b)]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        String(outcomes.find((r) => r.status === "rejected")!.reason),
      ).toContain("CHANNEL_SPACING");
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "publications" } })),
      ).toBe(1);
      expect(
        await run((tx) => tx.outbox.count({ where: { topic: "publishing" } })),
      ).toBe(1);
    });
  },
);

describe.skipIf(!enabled)("A25 authenticated workspace pause", () => {
  it("workspace owner fences all projects while a project editor is denied", async () => {
    const auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const app = await buildServer();
    const identity = makeAuth(),
      password = randomBytes(24).toString("base64url"),
      origin = process.env.APP_ORIGIN!;
    let workspaceId: string | undefined;
    const users: string[] = [];
    try {
      const owner = await identity.api.signUpEmail({
        body: {
          email: randomUUID() + "@example.invalid",
          name: "Synthetic pause owner",
          password,
        },
      });
      users.push(owner.user.id);
      const editor = await identity.api.signUpEmail({
        body: {
          email: randomUUID() + "@example.invalid",
          name: "Synthetic pause editor",
          password,
        },
      });
      users.push(editor.user.id);
      const workspace = await auth.workspace.create({
        data: {
          name: "Synthetic global pause",
          members: {
            create: [
              { userId: owner.user.id, role: "owner" },
              { userId: editor.user.id, role: "viewer" },
            ],
          },
        },
      });
      workspaceId = workspace.id;
      const a = await auth.project.create({
        data: {
          workspaceId,
          name: "Editor assigned",
          members: { create: { userId: editor.user.id, role: "editor" } },
        },
      });
      const b = await auth.project.create({
        data: { workspaceId, name: "Owner-only project" },
      });
      async function cookie(email: string) {
        const r = await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          headers: { origin },
          payload: { email, password },
        });
        expect(r.statusCode).toBe(200);
        const cookies = r.headers["set-cookie"];
        return (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; ");
      }
      const editorCookie = await cookie(editor.user.email),
        ownerCookie = await cookie(owner.user.email);
      const url = `/api/workspaces/${workspaceId}/pause`;
      const denied = await app.inject({
        method: "POST",
        url,
        headers: { origin, cookie: editorCookie },
        payload: { paused: true },
      });
      expect(denied.statusCode).toBe(403);
      expect(
        await auth.project.count({ where: { workspaceId, paused: true } }),
      ).toBe(0);
      const paused = await app.inject({
        method: "POST",
        url,
        headers: { origin, cookie: ownerCookie },
        payload: { paused: true },
      });
      expect(paused.statusCode).toBe(200);
      expect(new Set(paused.json().projectIds)).toEqual(new Set([a.id, b.id]));
      const projects = await auth.project.findMany({ where: { workspaceId } });
      expect(projects.every((p) => p.paused && p.generation > 1)).toBe(true);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { origin, cookie: editorCookie },
            payload: { paused: false },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        await auth.project.count({ where: { workspaceId, paused: true } }),
      ).toBe(2);
    } finally {
      if (workspaceId)
        await auth.workspace.delete({ where: { id: workspaceId } });
      if (users.length)
        await auth.user.deleteMany({ where: { id: { in: users } } });
      await app.close();
      await auth.$disconnect();
      await closeDatabase();
    }
  });
});

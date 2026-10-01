import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type PrismaClient,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, update } from "../../api/src/shared.ts";
import { nextSweepAt } from "../../api/src/modules/lifecycle.ts";
import { nextMatomoRunAt } from "../../api/src/modules/matomo-schedule.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Project work-due marker", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope, other: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>, s = scope) =>
    scoped(s.workspaceId, s.projectId, fn, db);
  const marker = async (projectId = scope.projectId) =>
    (
      await auth.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { workDueAt: true },
      })
    ).workDueAt.valueOf();
  const defer = (projectId = scope.projectId) =>
    auth.project.update({
      where: { id: projectId },
      data: { workDueAt: new Date(Date.now() + 86400000) },
    });
  beforeAll(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic marker owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic marker workspace",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const [a, b] = await Promise.all(
      ["A", "B"].map((name) =>
        auth.project.create({
          data: { workspaceId: w.id, name: "Synthetic marker " + name },
        }),
      ),
    );
    scope = {
      workspaceId: w.id,
      projectId: a!.id,
      userId: user.id,
      role: "owner",
    };
    other = { ...scope, projectId: b!.id };
  });
  afterAll(async () => {
    if (auth && scope) {
      await auth.workspace.delete({ where: { id: scope.workspaceId } });
      await auth.user.delete({ where: { id: scope.userId } });
    }
    await db?.$disconnect();
    await auth?.$disconnect();
  });
  it("new projects are due immediately", async () => {
    expect(await marker()).toBeLessThanOrEqual(Date.now());
  });
  it("entity writes wake only their own project", async () => {
    await defer();
    await defer(other.projectId);
    const row = await run((tx) =>
      create(tx, scope, "missions", { title: "Synthetic", status: "draft" }),
    );
    expect(await marker()).toBeLessThanOrEqual(Date.now());
    expect(await marker(other.projectId)).toBeGreaterThan(Date.now());
    await defer();
    await run((tx) => update(tx, scope, row, { title: "Synthetic 2" }));
    expect(await marker()).toBeLessThanOrEqual(Date.now());
  });
  it("outbox rows move the marker to their availability, dispatch does not", async () => {
    await defer();
    const availableAt = new Date(Date.now() + 600000);
    const job = await run((tx) =>
      create(tx, scope, "jobs", { topic: "analytics", status: "queued" }),
    );
    await defer();
    const event = await run((tx) =>
      tx.outbox.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          topic: "analytics",
          entityId: job.id,
          payload: { jobId: job.id },
          availableAt,
        },
      }),
    );
    expect(await marker()).toBe(availableAt.valueOf());
    await defer();
    await run((tx) =>
      tx.outbox.update({
        where: { id: event.id },
        data: { dispatchedAt: new Date() },
      }),
    );
    expect(await marker()).toBeGreaterThan(Date.now() + 3600000);
  });
  it("project state changes wake the project, marker-only updates do not", async () => {
    await defer();
    expect(await marker()).toBeGreaterThan(Date.now());
    await auth.project.update({
      where: { id: scope.projectId },
      data: { paused: true },
    });
    expect(await marker()).toBeLessThanOrEqual(Date.now());
    await auth.project.update({
      where: { id: scope.projectId },
      data: { paused: false },
    });
  });
  it("the business role still cannot read or wake other projects", async () => {
    await defer(other.projectId);
    const visible = await run((tx) =>
      tx.project.findMany({ select: { id: true } }),
    );
    expect(visible.map((p) => p.id)).toEqual([scope.projectId]);
    const changed = await run((tx) =>
      tx.project.updateMany({
        where: { id: other.projectId },
        data: { workDueAt: new Date() },
      }),
    );
    expect(changed.count).toBe(0);
    expect(await marker(other.projectId)).toBeGreaterThan(Date.now());
  });
  it("nextSweepAt reports the earliest time-based sweep transition", async () => {
    const at = new Date();
    const soon = new Date(at.valueOf() + 3600000),
      later = new Date(at.valueOf() + 7200000),
      end = new Date(at.valueOf() + 86400000);
    await run(async (tx) => {
      await create(tx, other, "missions", {
        title: "Synthetic scheduled",
        status: "ready",
        startAt: later.toISOString(),
        endAt: end.toISOString(),
      });
      await create(tx, other, "experiments", {
        status: "running",
        startAt: at.toISOString(),
        endAt: soon.toISOString(),
      });
    }, other);
    expect(
      (await run((tx) => nextSweepAt(tx, other, at), other))?.valueOf(),
    ).toBe(soon.valueOf());
    await auth.project.update({
      where: { id: other.projectId },
      data: { paused: true },
    });
    expect(await run((tx) => nextSweepAt(tx, other, at), other)).toBeNull();
  });
  it("autopilot plan checks and saved Matomo imports report their next run", async () => {
    const at = new Date();
    const checked = new Date(at.valueOf() - 4 * 60_000),
      imported = new Date(at.valueOf() - 11 * 3600_000);
    await run(async (tx) => {
      await create(tx, scope, "autopilot_settings", {
        enabled: true,
        lastPlanCheckAt: checked.toISOString(),
      });
      await create(tx, scope, "matomo_schedules", {
        enabled: true,
        lastRunAt: imported.toISOString(),
      });
    });
    expect((await run((tx) => nextSweepAt(tx, scope, at)))?.valueOf()).toBe(
      checked.valueOf() + 10 * 60_000,
    );
    expect((await run((tx) => nextMatomoRunAt(tx, scope)))?.valueOf()).toBe(
      imported.valueOf() + 12 * 3600_000,
    );
  });
});

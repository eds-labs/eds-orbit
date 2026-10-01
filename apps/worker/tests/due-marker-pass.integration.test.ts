import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type PrismaClient,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, update } from "../../api/src/shared.ts";
import {
  claimProject,
  deferAfterFailure,
  releaseProject,
} from "../src/due-marker.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// A pump pass races with API writes; none of them may be lost.
describe.skipIf(!enabled)("Work-due marker across one pump pass", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn, db);
  const marker = async () =>
    (
      await auth.project.findUniqueOrThrow({
        where: { id: scope.projectId },
        select: { workDueAt: true },
      })
    ).workDueAt.valueOf();
  const lease = () => new Date(Date.now() + 60_000);
  const later = () => new Date(Date.now() + 300_000);
  beforeAll(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic pass owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic pass workspace",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const p = await auth.project.create({
      data: { workspaceId: w.id, name: "Synthetic pass project" },
    });
    scope = {
      workspaceId: w.id,
      projectId: p.id,
      userId: user.id,
      role: "owner",
    };
  });
  afterAll(async () => {
    if (auth && scope) {
      await auth.workspace.delete({ where: { id: scope.workspaceId } });
      await auth.user.delete({ where: { id: scope.userId } });
    }
    await db?.$disconnect();
    await auth?.$disconnect();
  });
  beforeEach(async () => {
    // Due, as when the pump selects the project.
    await auth.project.update({
      where: { id: scope.projectId },
      data: { workDueAt: new Date(Date.now() - 1_000) },
    });
  });
  it("keeps the project due when an outbox row arrives during the pass", async () => {
    const claimed = await claimProject(auth, scope.projectId, lease());
    expect(claimed).not.toBeNull();
    const job = await run((tx) =>
      create(tx, scope, "jobs", { topic: "publishing", status: "queued" }),
    );
    await run((tx) =>
      tx.outbox.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          topic: "publishing",
          entityId: job.id,
          payload: { jobId: job.id },
        },
      }),
    );
    await releaseProject(auth, scope.projectId, claimed!, later());
    expect(await marker()).toBeLessThanOrEqual(Date.now());
  });
  it("keeps the project due when business data changes during the pass", async () => {
    const mission = await run((tx) =>
      create(tx, scope, "missions", { title: "Synthetic", status: "draft" }),
    );
    await auth.project.update({
      where: { id: scope.projectId },
      data: { workDueAt: new Date(Date.now() - 1_000) },
    });
    const claimed = await claimProject(auth, scope.projectId, lease());
    await run((tx) =>
      update(tx, scope, mission, { title: "Synthetic 2", status: "draft" }),
    );
    await releaseProject(auth, scope.projectId, claimed!, later());
    expect(await marker()).toBeLessThanOrEqual(Date.now());
  });
  it("sets the next due time after a quiet pass", async () => {
    const next = later();
    const claimed = await claimProject(auth, scope.projectId, lease());
    await releaseProject(auth, scope.projectId, claimed!, next);
    expect(await marker()).toBe(next.valueOf());
  });
  it("does not claim a project that is no longer due", async () => {
    const next = later();
    await auth.project.update({
      where: { id: scope.projectId },
      data: { workDueAt: next },
    });
    expect(await claimProject(auth, scope.projectId, lease())).toBeNull();
    expect(await marker()).toBe(next.valueOf());
  });
  it("retries a failed pass after the failure delay, not after the lease", async () => {
    const claimed = await claimProject(auth, scope.projectId, lease());
    const retryAt = new Date(Date.now() + 5_000);
    await deferAfterFailure(auth, scope.projectId, retryAt, claimed);
    expect(await marker()).toBe(retryAt.valueOf());
  });
});

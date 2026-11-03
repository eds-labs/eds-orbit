import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity } from "../../api/src/shared.ts";
import { workerProcess } from "./support/worker-process.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);

/**
 * A job whose outbox row was handed to BullMQ but whose BullMQ job is gone
 * (Redis lost it) is handed over again after ten minutes (ADR 0020 §7
 * "Recovery", S5). A job dispatched recently is left alone.
 */
describe.skipIf(!enabled)("Worker re-dispatch of jobs lost from Redis", () => {
  const worker = workerProcess("orbit-lost-job");
  let scope: Scope;
  const users: string[] = [];
  let lost = "";
  let recent = "";

  /** A queued job whose only outbox row was dispatched `minutesAgo` and never reached BullMQ. */
  const dispatchedJob = (minutesAgo: number) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const job = await create(tx, scope, "jobs", {
        topic: "ingestion",
        resourceId: randomUUID(),
        idempotencyKey: `lost-job:${randomUUID()}`,
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        availableAt: new Date().toISOString(),
        actorId: scope.userId,
      });
      const at = new Date(Date.now() - minutesAgo * 60_000);
      await tx.outbox.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          topic: "ingestion",
          entityId: job.id,
          payload: { jobId: job.id },
          availableAt: at,
          dispatchedAt: at,
        },
      });
      return job.id;
    });
  const outboxRows = (jobId: string) =>
    scoped(scope.workspaceId, scope.projectId, (tx) => tx.outbox.count({ where: { entityId: jobId } }));

  beforeAll(async () => {
    const user = await authDb.user.create({
      data: { id: randomUUID(), name: "Synthetic lost job owner", email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic lost job", members: { create: { userId: user.id, role: "owner" } } },
    });
    const project = await authDb.project.create({ data: { workspaceId: workspace.id, name: "Synthetic lost job" } });
    scope = { workspaceId: workspace.id, projectId: project.id, userId: user.id, role: "owner" };
    lost = await dispatchedJob(11);
    recent = await dispatchedJob(2);
    worker.start(scope.workspaceId);
  }, 60000);

  afterAll(async () => {
    await worker.cleanup();
    if (scope) await authDb.workspace.deleteMany({ where: { id: scope.workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("hands a lost job to the queue again and lets it run", async () => {
    const outcome = await worker.waitFor(async () => {
      const d = data(await scoped(scope.workspaceId, scope.projectId, (tx) => entity(tx, scope, "jobs", lost)));
      return d.status === "queued" || d.status === "running" ? false : { status: d.status, error: d.error };
    }, 60000);
    // The ingestion of a missing document stops for good: it ran.
    expect(outcome).toEqual({ status: "blocked_dependency", error: "NOT_FOUND" });
    expect(await outboxRows(lost)).toBe(2);
  }, 90000);

  it("leaves a recently dispatched job alone", async () => {
    expect(await outboxRows(recent)).toBe(1);
    const d = data(await scoped(scope.workspaceId, scope.projectId, (tx) => entity(tx, scope, "jobs", recent)));
    expect(d.status).toBe("queued");
  });
});

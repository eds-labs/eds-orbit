import type { Queue } from "bullmq";
import { scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

// Jobs lost from Redis (ADR 0020 §7 "Recovery"). The pump hands an outbox
// row to BullMQ once and marks it dispatched; if Redis then loses the job
// (a flush, a restore, an eviction), its entity stays queued for good. A
// queued or retry_scheduled job whose newest outbox row was dispatched more
// than ten minutes ago and has no live BullMQ job gets a new outbox row.

const LOST_AFTER_MS = 10 * 60_000;
const MAX_PER_PASS = 20;
const OPEN = new Set(["queued", "retry_scheduled"]);
const ALIVE = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

export async function redispatchLost(scope: Scope, queues: Map<string, Queue>, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - LOST_AFTER_MS);
  const candidates = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const rows = await tx.outbox.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        topic: { in: [...queues.keys()] },
        dispatchedAt: { lt: cutoff },
      },
      orderBy: { dispatchedAt: "desc" },
      take: 200,
    });
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.entityId))];
    const jobs = await tx.entity.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: "jobs", id: { in: ids } },
      select: { id: true, data: true },
    });
    const open = new Set(jobs.filter((j) => OPEN.has(String((j.data as { status?: unknown }).status))).map((j) => j.id));
    // Only the newest row of a job counts; a newer one is still on its way.
    const newest = await tx.outbox.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, entityId: { in: [...open] } },
      orderBy: { createdAt: "desc" },
    });
    const latest = new Map<string, (typeof newest)[number]>();
    for (const row of newest) if (!latest.has(row.entityId)) latest.set(row.entityId, row);
    return [...latest.values()].filter((row) => row.dispatchedAt && row.dispatchedAt < cutoff).slice(0, MAX_PER_PASS);
  });
  let count = 0;
  for (const row of candidates) {
    const queue = queues.get(row.topic);
    if (!queue) continue;
    const job = await queue.getJob(row.id);
    if (job && ALIVE.has(await job.getState())) continue;
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.outbox.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          topic: row.topic,
          entityId: row.entityId,
          payload: { jobId: row.entityId },
          availableAt: now,
        },
      }),
    );
    count++;
  }
  return count;
}

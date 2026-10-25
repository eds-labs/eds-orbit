import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { create, data, list } from "../shared.ts";

/**
 * Queues a job durably: a `jobs` entity and an outbox row in the caller's
 * transaction, which the worker dispatches to the queue named by `topic`.
 * A job with the same idempotency key is returned instead of a second one.
 * `extra` adds fields the handler reads from the job (never content).
 */
export async function enqueue(
  tx: DbTx,
  scope: Scope,
  topic: string,
  resourceId: string,
  key: string,
  availableAt = new Date(),
  extra: Record<string, string> = {},
) {
  const old = (await list(tx, scope, "jobs")).find(
    (x) => data(x).idempotencyKey === key,
  );
  if (old) return old;
  const job = await create(tx, scope, "jobs", {
    ...extra,
    topic,
    resourceId,
    idempotencyKey: key,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    availableAt: availableAt.toISOString(),
    actorId: scope.userId,
  });
  await tx.outbox.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      topic,
      entityId: job.id,
      payload: { jobId: job.id },
      availableAt,
    },
  });
  return job;
}

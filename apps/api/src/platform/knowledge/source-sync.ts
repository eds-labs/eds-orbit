import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { SchedulerContribution } from "../jobs/types.ts";
import { create, data, list } from "../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";

/**
 * Periodic source synchronisation (knowledge services, AD-08): sources with
 * `syncEveryHours` get a new sync request and an ingestion job once their
 * interval passed. Moved unchanged from lifecycle.sweepProject (WP1.6).
 */
async function sweep(tx: DbTx, scope: Scope, at: Date) {
  let queued = 0;
  const requests = await list(tx, scope, "sync_requests");
  for (const source of await list(tx, scope, "sources")) {
    const d = data(source);
    if (d.status !== "active" || !d.syncEveryHours) continue;
    const latest = requests.find((r) => data(r).sourceId === source.id);
    if (!latest) continue;
    const last = d.lastSuccessfulSyncAt
      ? Date.parse(d.lastSuccessfulSyncAt)
      : 0;
    if (at.valueOf() - last < d.syncEveryHours * 3600000) continue;
    const slot = Math.floor(at.valueOf() / (d.syncEveryHours * 3600000));
    const key = `periodic-sync:${source.id}:${d.generation}:${slot}`;
    const jobs = await list(tx, scope, "jobs");
    if (jobs.some((j) => data(j).idempotencyKey === key)) continue;
    const request = await create(tx, scope, "sync_requests", {
      ...data(latest),
      expectedGeneration: d.generation,
    });
    await enqueue(tx, scope, "ingestion", request.id, key, at);
    queued++;
  }
  return { queued };
}
async function nextDueAt(tx: DbTx, scope: Scope, at: Date) {
  const now = at.valueOf();
  let next = Infinity;
  const consider = (value: unknown) => {
    const time =
      typeof value === "number" ? value : Date.parse(String(value ?? ""));
    if (Number.isFinite(time) && time > now) next = Math.min(next, time);
  };
  const requests = await list(tx, scope, "sync_requests");
  for (const source of await list(tx, scope, "sources")) {
    const d = data(source);
    if (d.status !== "active" || !d.syncEveryHours) continue;
    if (!requests.some((r) => data(r).sourceId === source.id)) continue;
    const interval = d.syncEveryHours * 3600000;
    const last = d.lastSuccessfulSyncAt
      ? Date.parse(d.lastSuccessfulSyncAt)
      : 0;
    consider(
      last + interval > now
        ? last + interval
        : (Math.floor(now / interval) + 1) * interval,
    );
  }
  return Number.isFinite(next) ? new Date(next) : null;
}

export const sourceSyncScheduler: SchedulerContribution = { sweep, nextDueAt };

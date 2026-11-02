import type { JobDef } from "../../../platform/jobs/types.ts";
import { blockPublication, lockPublication, markOutcomeUnknown } from "./claim.ts";
import { deliverPublication } from "./deliver.ts";
import { dispatchPost } from "./dispatch.ts";
import { DELIVER, DISPATCH, RECONCILE } from "./queues.ts";
import { reconcilePublication } from "./reconcile.ts";

// The social module's queue classes (ADR 0020 §7, S5) on the Orbit worker:
// no other scheduler. Due work is found through the outbox's availableAt.

export { DELIVER, DISPATCH, RECONCILE } from "./queues.ts";

export const dispatchJob: JobDef = {
  queueClass: DISPATCH,
  handler: ({ scope, job }) => dispatchPost(scope, String(job.resourceId), Number(job.postVersion)),
};

export const deliverJob: JobDef = {
  queueClass: DELIVER,
  concurrency: 2,
  // Uploads to X and Telegram and Instagram's container step fit easily.
  leaseMs: 180_000,
  handler: ({ scope, job }) => deliverPublication(scope, String(job.resourceId)),
  /**
   * The worker died during the job. A publication being sent may have gone
   * out: it becomes outcome_unknown and is never sent again. One that was
   * only claimed made no provider call and may be claimed again.
   */
  async onLeaseExpired(tx, scope, job) {
    const pub = await lockPublication(tx, scope, String(job.resourceId));
    if (pub.status === "sending") await markOutcomeUnknown(tx, scope, pub.id, "SOCIAL_LEASE_EXPIRED");
    else if (pub.status === "claimed")
      await tx.socialPublication.update({ where: { id: pub.id }, data: { status: "pending", fence: null, version: { increment: 1 } } });
  },
  /** A paused project blocks the delivery; resuming re-enqueues recent ones (S5). */
  async onBlockedByPause(tx, job, scope) {
    const pub = await lockPublication(tx, scope, String(job.resourceId));
    // Only what is still to be sent; a failure for good stays failed.
    const retrying = pub.status === "failed" && pub.retryDisposition === "after-delay" && pub.nextAttemptAt !== null;
    if (pub.status === "pending" || retrying) await blockPublication(tx, scope, pub.id, "PROJECT_PAUSED");
  },
};

export const reconcileJob: JobDef = {
  queueClass: RECONCILE,
  concurrency: 2,
  handler: ({ scope, job }) =>
    reconcilePublication(scope, String(job.resourceId), job.attempt === "unknown" ? "unknown" : Number(job.attempt ?? 1)),
};

export const socialJobs: JobDef[] = [dispatchJob, deliverJob, reconcileJob];

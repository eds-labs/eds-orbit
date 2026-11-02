import type { JobDef } from "../../../platform/jobs/types.ts";
import { dispatchPost } from "./dispatch.ts";

// The social module's queue classes (ADR 0020 §7, S5) on the Orbit worker:
// no other scheduler. Due work is found through the outbox's availableAt.

export const DISPATCH = "social_dispatch";
export const DELIVER = "social_deliver";
export const RECONCILE = "social_reconcile";

export const dispatchJob: JobDef = {
  queueClass: DISPATCH,
  handler: ({ scope, job }) => dispatchPost(scope, String(job.resourceId), Number(job.postVersion)),
};

export const socialJobs: JobDef[] = [dispatchJob];

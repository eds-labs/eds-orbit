import type { JobDef } from "../../../platform/jobs/types.ts";
import { audit } from "../../../shared.ts";
import { runScanJob } from "./monitor.ts";
import { PM_QUEUE, runPlanJob } from "./planner.ts";

// The PM's queue (plan §4.4). One class for every PM job; `kind` says which.
// A paid job never repeats a sent call: its calls reserve under the
// subject's own key, so a retried attempt ends as unknown instead.

export const pmJobs: readonly JobDef[] = [
  {
    queueClass: PM_QUEUE,
    leaseMs: 240_000,
    async handler({ scope, job }) {
      switch (job.kind) {
        case "plan":
          return runPlanJob(scope, job.resourceId);
        case "scan":
          await runScanJob(scope, job.resourceId);
          return;
        default:
          throw new Error("WORK_PM_JOB_UNKNOWN");
      }
    },
    // A paused project stops planning; the request shows why.
    async onBlockedByPause(tx, job, scope) {
      if (job.kind !== "plan") return;
      const updated = await tx.workPlanProposal.updateMany({
        where: { projectId: scope.projectId, id: job.resourceId, status: { in: ["queued", "running"] } },
        data: { status: "failed", errorCode: "PROJECT_PAUSED", version: { increment: 1 } },
      });
      if (updated.count) await audit(tx, scope, "work.pm.plan_failed", job.resourceId, { code: "PROJECT_PAUSED" });
    },
  },
];


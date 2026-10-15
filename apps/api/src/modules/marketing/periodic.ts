import type { PeriodicTask } from "../../platform/jobs/types.ts";
import {
  nextMatomoRunAt,
  runScheduledMatomo,
} from "./analytics/matomo-schedule.ts";
import {
  checkPostizQueue,
  nextPostizQueueCheckAt,
  postizQueueHealth,
} from "./publishing/postiz-queue-watch.ts";
import { driveAssetRetry } from "./brand/drive-retry.ts";

/**
 * Marketing's per-project worker tasks (WP2.1), in the order the worker ran
 * them before: saved Matomo imports, the read-only Postiz queue check, then
 * the Drive retry of generated images (WP2.5d).
 */
export const marketingPeriodicTasks: readonly PeriodicTask[] = [
  {
    // Saved Matomo imports run at most twice a day per project.
    name: "matomo-schedule",
    nextDueAt: nextMatomoRunAt,
    async run(scope) {
      await runScheduledMatomo(scope);
    },
  },
  {
    // Its result feeds /api/health/postiz.
    name: "postiz-queue",
    nextDueAt: nextPostizQueueCheckAt,
    async run(scope) {
      const result = await checkPostizQueue(scope);
      return result.checked ? { status: result.status } : undefined;
    },
    health: { summarize: postizQueueHealth },
  },
  driveAssetRetry,
];

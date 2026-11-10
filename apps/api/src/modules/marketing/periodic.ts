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
import { syncSocialHolds } from "./publishing/publisher.ts";

/**
 * Marketing's per-project worker tasks (WP2.1), in the order the worker ran
 * them before: saved Matomo imports, the read-only Postiz queue check, the
 * Drive retry of generated images (WP2.5d), then announcing released posts
 * in Social's calendar.
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
  {
    // Social's calendar follows Marketing; no wake-up of its own (a write wakes the project).
    name: "social-hold-sync",
    run: syncSocialHolds,
  },
];

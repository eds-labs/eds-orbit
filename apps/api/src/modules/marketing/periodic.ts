import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { nextMatomoRunAt, runScheduledMatomo } from "../matomo-schedule.ts";
import {
  checkPostizQueue,
  nextPostizQueueCheckAt,
  postizQueueHealth,
} from "./publishing/postiz-queue-watch.ts";

/**
 * Marketing's per-project worker tasks (WP2.1), in the order the worker ran
 * them before: saved Matomo imports, then the read-only Postiz queue check.
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
];

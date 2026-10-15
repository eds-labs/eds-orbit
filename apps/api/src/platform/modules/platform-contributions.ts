import type { ModuleContributions } from "./contributions.ts";
import { platformActions } from "../http/platform-actions.ts";
import { sourceSyncScheduler } from "../knowledge/source-sync.ts";
import { runChatJob } from "../../modules/chat-runner.ts";
import { stopChatRunForPause } from "../../modules/chat.ts";
import { embedDocument, syncSource } from "../../modules/ingestion.ts";
import { buildIndexBatch } from "../../modules/reindex.ts";
import { runIndexEvaluation } from "../../modules/index-evaluation.ts";
import { pauseCallback } from "../connections/telegram.ts";
import { sendNotification } from "../notifications/sender.ts";

/** What the platform itself registers beside the modules (WP1.6). */
export const platformContributions: ModuleContributions = {
  actions: platformActions,
  scheduler: sourceSyncScheduler,
  // The bot's `/pause` confirmation; modules add their own buttons.
  telegram: { callbacks: { pause: pauseCallback } },
  jobs: [
    {
      queueClass: "chat",
      // Runs with the requesting user's current role, never the worker's.
      async handler({ scope, job }) {
        const finished = await runChatJob(scope, job.actorId, job.resourceId);
        return { status: finished.status, errorCode: finished.errorCode };
      },
      // The reply would otherwise wait forever.
      onBlockedByPause: (tx, job) => stopChatRunForPause(tx, job),
    },
    {
      queueClass: "ingestion",
      handler: ({ scope, job }) =>
        syncSource(scope, job.resourceId).then(() => undefined),
    },
    {
      queueClass: "embedding",
      handler: ({ scope, job, jobId }) =>
        embedDocument(scope, job.resourceId, jobId).then(() => undefined),
    },
    {
      queueClass: "reindex",
      handler: ({ scope, job, jobId }) =>
        buildIndexBatch(scope, job.resourceId, jobId).then(() => undefined),
    },
    {
      // Previews, notices and the daily report for the owner's Telegram bot
      // (WP2.5b). Records its own outcome on the job; a failed delivery is
      // an exception, never a retry loop.
      queueClass: "telegram_notification",
      // A message to the owner's own bot publishes nothing; a pause notice must still reach him.
      runWhilePaused: true,
      // A notification with its retries runs nearly as long as a specialist task.
      leaseMs: 180000,
      handler: ({ scope, jobId }) =>
        sendNotification(scope, jobId).then(() => undefined),
    },
    {
      queueClass: "index_evaluation",
      handler: ({ scope, job, jobId }) =>
        runIndexEvaluation(scope, job.resourceId, jobId).then(() => undefined),
    },
  ],
};

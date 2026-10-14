import type { ModuleContributions } from "./contributions.ts";
import { platformActions } from "../http/platform-actions.ts";
import { sourceSyncScheduler } from "../knowledge/source-sync.ts";
import { runChatJob } from "../../modules/chat-runner.ts";
import { stopChatRunForPause } from "../../modules/chat.ts";
import { embedDocument, syncSource } from "../../modules/ingestion.ts";
import { buildIndexBatch } from "../../modules/reindex.ts";
import { runIndexEvaluation } from "../../modules/index-evaluation.ts";
import { pauseCallback } from "../connections/telegram.ts";

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
      queueClass: "index_evaluation",
      handler: ({ scope, job, jobId }) =>
        runIndexEvaluation(scope, job.resourceId, jobId).then(() => undefined),
    },
  ],
};

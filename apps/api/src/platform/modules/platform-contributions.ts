import { n8nConnectionProvider } from "../automation/workflows.ts";
import {
  anthropicConnectionProvider,
  openAiConnectionProvider,
} from "../ai/connection-providers.ts";
import { taskRetention } from "../tasks/retention.ts";
import { taskStart } from "../tasks/tasks.ts";
import type { ModuleContributions } from "./contributions.ts";
import { platformActions } from "../http/platform-actions.ts";
import { sourceSyncScheduler } from "../knowledge/source-sync.ts";
import { runChatJob } from "../../modules/chat-runner.ts";
import { stopChatRunForPause } from "../../modules/chat.ts";
import { embedDocument, syncSource } from "../knowledge/ingestion.ts";
import { buildIndexBatch } from "../knowledge/reindex.ts";
import { runIndexEvaluation } from "../knowledge/index-evaluation.ts";
import { pauseCallback, telegramWebhook } from "../connections/telegram.ts";
import { sendNotification } from "../notifications/sender.ts";
import { ingressCleanup, ingressRetention } from "../http/ingress-retention.ts";
import { fileCleanup } from "../files/files.ts";
import { emailConnectionProvider } from "../email/connection.ts";
import {
  CUSTOMER_CONTEXT_PROVIDER,
  customerContextConnectionProvider,
} from "../customer-context/connection.ts";
import {
  EMAIL_QUEUE,
  sendQueuedEmail,
  skipEmailForPause,
} from "../email/send.ts";
import { emailInbound } from "../email/inbound.ts";

/** What the platform itself registers beside the modules (WP1.6). */
export const platformContributions: ModuleContributions = {
  actions: platformActions,
  actionTypes: { "platform.task.start": taskStart },
  scheduler: sourceSyncScheduler,
  // The bot's `/pause` confirmation; modules add their own buttons.
  telegram: { callbacks: { pause: pauseCallback } },
  // The bot's webhook through the platform's hooks route as well (WP4.2).
  webhooks: { telegram: telegramWebhook },
  // Public sessions and received webhooks are purged on their own (WP4.2).
  retention: async (tx, scope, ctx) => {
    const ingress = await ingressRetention(tx, scope, ctx);
    const tasks = await taskRetention(tx, scope, ctx);
    return {
      audit: { ...ingress.audit, ...tasks.audit },
      result: { ...ingress.result, ...tasks.result },
    };
  },
  // Files whose removal failed are retried hourly (WP4.6).
  // Inbound e-mail every two minutes per project with a mailbox (WP4.7).
  periodic: [ingressCleanup, fileCleanup, emailInbound],
  // The project's mailbox over SMTP and IMAP (WP4.7), and customer context
  // provider endpoints (ADR 0011).
  connections: {
    providers: {
      email: emailConnectionProvider,
      [CUSTOMER_CONTEXT_PROVIDER]: customerContextConnectionProvider,
      // AI provider accounts, managed centrally (ADR 0013).
      openai: openAiConnectionProvider,
      anthropic: anthropicConnectionProvider,
      // An automation layer such as n8n (WP3.7).
      n8n: n8nConnectionProvider,
    },
  },
  jobs: [
    {
      queueClass: "chat",
      // Runs with the requesting user's current role, never the worker's.
      async handler({ scope, job }) {
        const finished = await runChatJob(scope, job.actorId, job.resourceId);
        return { status: finished.status, errorCode: finished.errorCode };
      },
      // The reply would otherwise wait forever.
      onBlockedByPause: (tx, job, scope) => stopChatRunForPause(tx, job, scope),
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
      // One outbound e-mail through the project's mailbox (WP4.7). Never
      // sent twice: the message row records whether it may have left.
      queueClass: EMAIL_QUEUE,
      handler: ({ scope, job }) =>
        sendQueuedEmail(scope, job.resourceId).then(() => undefined),
      // A pause stops it for good; the message says so.
      onBlockedByPause: (tx, job) => skipEmailForPause(tx, job),
    },
    {
      queueClass: "index_evaluation",
      handler: ({ scope, job, jobId }) =>
        runIndexEvaluation(scope, job.resourceId, jobId).then(() => undefined),
    },
  ],
};

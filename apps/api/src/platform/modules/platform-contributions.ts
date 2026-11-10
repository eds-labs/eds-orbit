import { n8nConnectionProvider } from "../automation/workflows.ts";
import {
  GITHUB_APP_PROVIDER,
  githubAppConnectionProvider,
} from "../connections/github-app.ts";
import {
  anthropicConnectionProvider,
  openAiConnectionProvider,
} from "../ai/connection-providers.ts";
import { taskRetention } from "../tasks/retention.ts";
import { agentWorkRetention } from "../agents/work-orders/retention.ts";
import { taskStart } from "../tasks/tasks.ts";
import {
  configurationActionTypes,
  configurationTools,
} from "../configuration/configuration.ts";
import { projectSection } from "../configuration/project-section.ts";
import { aiModelActionTypes, aiModelTools } from "../ai/mcp-tools.ts";
import {
  spendPolicyActionTypes,
  spendPolicyTools,
} from "../ai/spend-policy-tools.ts";
import type { ModuleContributions } from "./contributions.ts";
import { platformActions } from "../http/platform-actions.ts";
import { sourceSyncScheduler } from "../knowledge/source-sync.ts";
import { runChatJob } from "../../modules/chat-runner.ts";
import { stopChatRunForPause } from "../../modules/chat.ts";
import { embedDocument, syncSource } from "../knowledge/ingestion.ts";
import { buildIndexBatch } from "../knowledge/reindex.ts";
import {
  failSiteRun,
  runSiteBatch,
  SITE_QUEUE,
} from "../knowledge/site-run.ts";
import { runIndexEvaluation } from "../knowledge/index-evaluation.ts";
import {
  EVALUATION_SET_QUEUE,
  generateEvaluationSet,
} from "../knowledge/evaluation-set.ts";
import { pauseCallback, telegramWebhook } from "../connections/telegram.ts";
import { sendNotification } from "../notifications/sender.ts";
import { ingressCleanup, ingressRetention } from "../http/ingress-retention.ts";
import { personalSpaceCleanup } from "../assistant/personal-space.ts";
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
import { ARCHIVE_QUEUE, archiveInboundEmail } from "../email/archive.ts";
import { eventJob, eventRetention } from "../events/events.ts";
import { linkPrune } from "../links/links.ts";

import { agentWorkJob } from "../agents/work-orders/execute.ts";
import { agentRoutes } from "../agents/routes.ts";
import { assistantRoutes } from "../assistant/routes.ts";
import { voiceRoutes } from "../assistant/voice-routes.ts";
// Proactive signals, digests, briefings and per-user Telegram (ADR 0023).
import { proactiveRoutes } from "../proactive/routes.ts";
import { notificationDeliveryJob } from "../proactive/delivery.ts";
import { digestJob } from "../proactive/digest.ts";
import { briefingJob } from "../proactive/briefing.ts";
import { proactiveScheduler } from "../proactive/scheduler.ts";
import { signalsPeriodic } from "../signals/adapters.ts";
import {
  BRIEFING_SUMMARY_FAILED,
  platformSignals,
  signalUserNotifications,
} from "../signals/initial.ts";
import { BUDGET_THRESHOLD_EVENT } from "../signals/budget-threshold.ts";
import { personalAssistantTools } from "../assistant/user-tools.ts";
import {
  agentDelegateAction,
  DELEGATE_ACTION,
} from "../assistant/delegation.ts";
import { delegationNoticeSubscriber } from "../assistant/notices.ts";
import {
  agentTriggerSubscriber,
  TEST_PING,
  testPingTrigger,
} from "../agents/triggers/events.ts";
import {
  agentScheduleScheduler,
  combineSchedulers,
} from "../agents/triggers/schedule.ts";

/** What the platform itself registers beside the modules (WP1.6). */
export const platformContributions: ModuleContributions = {
  actions: platformActions,
  // The agent platform's HTTP routes (ADR 0021), 404 while ORBIT_AGENT_PLATFORM
  // is off, and the personal assistant's (ADR 0022), 404 while
  // ORBIT_PERSONAL_ASSISTANT is off.
  routes: (ctx) => {
    agentRoutes(ctx);
    assistantRoutes(ctx);
    // Voice (ADR 0024), 404 while ORBIT_VOICE is off.
    voiceRoutes(ctx);
    // Proactive layer (ADR 0023), 404 while ORBIT_PROACTIVE is off.
    proactiveRoutes(ctx);
  },
  userNotifications: {
    agent_work_failed: {
      label: { en: "Agent run failed", de: "Agenten-Ausführung fehlgeschlagen" },
      emailDefault: false,
    },
    // Written by the platform's signals only (ADR 0023).
    ...signalUserNotifications,
  },
  // Proactive signals (ADR 0023): deterministic, no AI.
  signals: platformSignals,
  actionTypes: {
    "platform.task.start": taskStart,
    // The personal assistant's delegation batches (ADR 0022 item 7).
    [DELEGATE_ACTION]: agentDelegateAction,
    ...configurationActionTypes,
    ...aiModelActionTypes,
    ...spendPolicyActionTypes,
  },
  // The project configuration over MCP (plans/project-configuration-mcp.md)
  // and the AI model selection (docs/MCP_PROJECT_ADMINISTRATION.md).
  // The AI spending authority (ADR 0015) follows them.
  // The personal Orbit Assistant's user tools and `action_status` (ADR
  // 0022), offered only in personal mode, never in project chat or MCP.
  tools: [
    ...configurationTools,
    ...aiModelTools,
    ...spendPolicyTools,
    ...personalAssistantTools,
  ],
  configurationSections: { project: projectSection },
  // Knowledge source syncs and agent schedule triggers (ADR 0021).
  // Digests and briefings in personal spaces (ADR 0023).
  scheduler: combineSchedulers(
    sourceSyncScheduler,
    agentScheduleScheduler,
    proactiveScheduler,
  ),
  // The bot's `/pause` confirmation; modules add their own buttons.
  telegram: { callbacks: { pause: pauseCallback } },
  // The bot's webhook through the platform's hooks route as well (WP4.2).
  webhooks: { telegram: telegramWebhook },
  // Public sessions and received webhooks are purged on their own (WP4.2).
  retention: async (tx, scope, ctx) => {
    const ingress = await ingressRetention(tx, scope, ctx);
    const tasks = await taskRetention(tx, scope, ctx);
    // Agent work orders, runs and spans (ADR 0021).
    const agents = await agentWorkRetention(tx, scope, ctx);
    return {
      audit: { ...ingress.audit, ...tasks.audit, ...agents.audit },
      result: { ...ingress.result, ...tasks.result, ...agents.result },
    };
  },
  // Files whose removal failed are retried hourly (WP4.6).
  // Inbound e-mail every two minutes per project with a mailbox (WP4.7).
  // Links to deleted objects weekly and events after 30 days (ADR 0016).
  periodic: [
    ingressCleanup,
    fileCleanup,
    emailInbound,
    linkPrune,
    eventRetention,
    personalSpaceCleanup,
    // Periodic signal detectors, hourly (ADR 0023, T4-2).
    signalsPeriodic,
  ],
  // Object links publish their changes (ADR 0016).
  // Handoff targets report progress through one event (ADR 0017).
  events: {
    publishes: [
      "platform.link.created",
      "platform.link.removed",
      "platform.handoff.status_changed",
      // Agent work orders (ADR 0021): content-free, ids and codes only.
      "platform.agent.work_order.finished",
      "platform.agent.work_order.failed",
      // Proactive layer (ADR 0023): budget thresholds and briefing summaries.
      BUDGET_THRESHOLD_EVENT,
      BRIEFING_SUMMARY_FAILED,
      ...(process.env.NODE_ENV === "test" ? [TEST_PING] : []),
    ],
    // Agents may be started by any module's declared triggerable events.
    // Delegated work orders report back into the personal conversation (ADR 0022).
    subscribes: [agentTriggerSubscriber, delegationNoticeSubscriber],
    ...(process.env.NODE_ENV === "test" ? { triggers: testPingTrigger } : {}),
  },
  // The project's mailbox over SMTP and IMAP (WP4.7), and customer context
  // provider endpoints (ADR 0011).
  connections: {
    providers: {
      email: emailConnectionProvider,
      [CUSTOMER_CONTEXT_PROVIDER]: customerContextConnectionProvider,
      // AI provider accounts, managed centrally (ADR 0014).
      openai: openAiConnectionProvider,
      anthropic: anthropicConnectionProvider,
      // An automation layer such as n8n (WP3.7).
      n8n: n8nConnectionProvider,
      // A GitHub App installation for issue synchronization.
      [GITHUB_APP_PROVIDER]: githubAppConnectionProvider,
    },
  },
  jobs: [
    // Agent work orders (ADR 0021): the worker runs them on behalf of their sponsor.
    agentWorkJob,
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
      // One batch of a site source's pages per job; it enqueues the next one.
      queueClass: SITE_QUEUE,
      concurrency: 1,
      leaseMs: 300000,
      handler: ({ scope, job, jobId }) =>
        runSiteBatch(scope, job.resourceId, jobId),
      // A run its job can no longer serve would block the source for good.
      onBlockedByPause: (tx, job, scope) =>
        failSiteRun(tx, scope, job.resourceId, "PROJECT_PAUSED"),
      onLeaseExpired: async (tx, scope, job) => {
        if (job.attempts >= job.maxAttempts)
          await failSiteRun(tx, scope, job.resourceId, "JOB_OUTCOME_UNKNOWN");
      },
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
      // Moves an acknowledged inbound message into the archive folder its
      // owner module asked for (IMAP). Records its outcome on the message.
      queueClass: ARCHIVE_QUEUE,
      handler: ({ scope, job }) => archiveInboundEmail(scope, job.resourceId),
    },
    {
      queueClass: "index_evaluation",
      handler: ({ scope, job, jobId }) =>
        runIndexEvaluation(scope, job.resourceId, jobId).then(() => undefined),
    },
    {
      // One batch of generated test questions per job (one model call).
      queueClass: EVALUATION_SET_QUEUE,
      leaseMs: 180000,
      handler: ({ scope, job, jobId }) =>
        generateEvaluationSet(scope, job.resourceId, jobId),
    },
    // One domain event for one subscriber (ADR 0016).
    eventJob,
    // Proactive delivery, digests and briefings (ADR 0023).
    notificationDeliveryJob,
    digestJob,
    briefingJob,
  ],
};

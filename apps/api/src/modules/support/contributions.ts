import { supportConversationResults } from "./assistant-results.ts";
import { supportMcpTools, supportMcpActions } from "./mcp-tools.ts";
import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { supportSwitchedOn } from "./gate.ts";
import { supportRoutes } from "./routes.ts";
import { supportRetentionTask } from "./privacy.ts";
import { runSupportTask, SUPPORT_DRAFT, SUPPORT_TRIAGE } from "./ai.ts";
import { supportTools } from "./tools.ts";
import { supportAttention } from "./attention.ts";
import { widgetRoutes } from "./widget.ts";
import { supportMailboxUse } from "./inboxes.ts";
import { supportScheduler, supportUserNotifications } from "./automations.ts";
import {
  handleInboundEmail,
  SUPPORT_EMAIL_INBOUND,
  supportEmailDelivery,
} from "./channels/email.ts";

/** What the support module plugs into the platform (WP5.1). */
export const supportContributions: ModuleContributions = {
  available: supportSwitchedOn,
  unavailableCode: "SUPPORT_DISABLED",
  routes: supportRoutes,
  // The e-mail channel (WP5.3) on the project's WP4.7 mailboxes; a live
  // inbox keeps its mailbox from being removed.
  emailInbound: {
    queueClass: SUPPORT_EMAIL_INBOUND,
    mailboxUse: supportMailboxUse,
  },
  jobs: [
    {
      queueClass: SUPPORT_EMAIL_INBOUND,
      handler: ({ scope, job }) => handleInboundEmail(scope, job.resourceId),
    },
    // Support AI (WP5.6): paid calls, never retried after a transmit.
    {
      queueClass: SUPPORT_TRIAGE,
      leaseMs: 180_000,
      handler: ({ scope, job, jobId }) =>
        runSupportTask(scope, {
          task: "triage",
          ticketId: job.resourceId,
          attemptKey: jobId,
        }),
    },
    {
      queueClass: SUPPORT_DRAFT,
      leaseMs: 180_000,
      handler: ({ scope, job, jobId }) =>
        runSupportTask(scope, {
          task: "draft",
          ticketId: job.resourceId,
          attemptKey: jobId,
          manual: String(job.idempotencyKey ?? "").startsWith(
            "support-draft-manual:",
          ),
        }),
    },
  ],
  tools: [...supportTools, ...supportMcpTools],
  conversationSections: supportConversationResults,
  actionTypes: supportMcpActions,
  periodic: [supportEmailDelivery, supportRetentionTask],
  // The livechat widget's public API (WP5.4).
  publicRoutes: widgetRoutes,
  // Notifications and automations (WP5.5).
  userNotifications: supportUserNotifications,
  scheduler: supportScheduler,
  // Attention items: SLA breaches and unassigned tickets.
  attention: supportAttention,
};

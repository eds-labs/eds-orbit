import { supportConversationResults } from "./assistant-results.ts";
import { supportSignals } from "./signals.ts";
import { supportMcpTools, supportMcpActions } from "./mcp-tools.ts";
import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { supportLinkTypes } from "./links.ts";
import { issueReleasedSubscriber } from "./issues-handoff.ts";
import { supportSwitchedOn } from "./gate.ts";
import { supportRoutes } from "./routes.ts";
import { supportRetentionTask } from "./privacy.ts";
import { runSupportTask, SUPPORT_DRAFT, SUPPORT_TRIAGE } from "./ai.ts";
import { supportTools } from "./tools.ts";
import { supportAgentActions, supportAgentTools } from "./agent-tools.ts";
import { supportAgentTemplates } from "./agent-template.ts";
import {
  SUPPORT_MESSAGE_RECEIVED,
  SUPPORT_TICKET_CREATED,
  supportTriggers,
} from "./agent-events.ts";
import { supportAttention, supportOverview } from "./attention.ts";
import { widgetRoutes } from "./widget.ts";
import { supportMailboxUse } from "./inboxes.ts";
import { ticketImportTarget } from "./email-import.ts";
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
  // A member turns a single message of a mailbox into a ticket (ADR 0026).
  emailImport: { ticket: ticketImportTarget },
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
        }).then(() => undefined),
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
        }).then(() => undefined),
    },
  ],
  tools: [...supportTools, ...supportMcpTools, ...supportAgentTools],
  conversationSections: supportConversationResults,
  actionTypes: { ...supportMcpActions, ...supportAgentActions },
  periodic: [supportEmailDelivery, supportRetentionTask],
  // The livechat widget's public API (WP5.4).
  publicRoutes: widgetRoutes,
  // Notifications and automations (WP5.5).
  userNotifications: supportUserNotifications,
  // Urgent tickets join the proactive feed as a mapping only (ADR 0023).
  signals: supportSignals,
  scheduler: supportScheduler,
  // Attention items: SLA breaches and unassigned tickets.
  attention: supportAttention,
  // Ticket counts for the personal assistant's overview (ADR 0022).
  assistantOverview: supportOverview,
  // The Support agent template (ADR 0021 Phase 2).
  agentTemplates: supportAgentTemplates,
  // Tickets as link targets of other modules (ADR 0016).
  linkTypes: supportLinkTypes,
  // Erasure tells other modules which tickets went (content-free); a
  // released product issue leaves a note on its tickets (ADR 0018).
  events: {
    publishes: [
      "support.contact.erased",
      SUPPORT_TICKET_CREATED,
      SUPPORT_MESSAGE_RECEIVED,
    ],
    subscribes: [issueReleasedSubscriber],
    // New tickets and customer messages may start a Support agent (ADR 0021 Phase 2).
    triggers: supportTriggers,
  },
};

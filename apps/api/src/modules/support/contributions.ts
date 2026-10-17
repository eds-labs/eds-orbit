import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { supportSwitchedOn } from "./gate.ts";
import { supportRoutes } from "./routes.ts";
import { supportRetentionTask } from "./privacy.ts";
import { runSupportTask, SUPPORT_DRAFT, SUPPORT_TRIAGE } from "./ai.ts";
import { supportTools } from "./tools.ts";
import { widgetRoutes } from "./widget.ts";
import { supportScheduler, supportUserNotifications } from "./automations.ts";
import {
  handleInboundEmail,
  SUPPORT_EMAIL_INBOUND,
  supportEmailDelivery,
} from "./channels/email.ts";

/** What the support module plugs into the platform (WP5.1). */
export const supportContributions: ModuleContributions = {
  available: supportSwitchedOn,
  routes: supportRoutes,
  // The e-mail channel (WP5.3) on the project's WP4.7 mailbox.
  emailInbound: { queueClass: SUPPORT_EMAIL_INBOUND },
  jobs: [
    {
      queueClass: SUPPORT_EMAIL_INBOUND,
      handler: ({ scope, job }) => handleInboundEmail(scope, job.resourceId),
    },
    // Support AI (WP5.6): paid calls, never retried after a transmit.
    {
      queueClass: SUPPORT_TRIAGE,
      leaseMs: 180_000,
      handler: ({ scope, job }) =>
        runSupportTask(scope, { task: "triage", ticketId: job.resourceId }),
    },
    {
      queueClass: SUPPORT_DRAFT,
      leaseMs: 180_000,
      handler: ({ scope, job }) =>
        runSupportTask(scope, { task: "draft", ticketId: job.resourceId }),
    },
  ],
  tools: supportTools,
  periodic: [supportEmailDelivery, supportRetentionTask],
  // The livechat widget's public API (WP5.4).
  publicRoutes: widgetRoutes,
  // Notifications and automations (WP5.5).
  userNotifications: supportUserNotifications,
  scheduler: supportScheduler,
};

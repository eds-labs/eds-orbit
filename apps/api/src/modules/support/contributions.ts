import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { supportSwitchedOn } from "./gate.ts";
import { supportRoutes } from "./routes.ts";
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
  ],
  periodic: [supportEmailDelivery],
};

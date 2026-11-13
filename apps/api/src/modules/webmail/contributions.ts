import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { webmailSwitchedOn } from "./gate.ts";
import { webmailMailboxUse } from "./mailboxes.ts";
import { webmailMaintenance, webmailRetention } from "./maintenance.ts";
import { webmailRoutes } from "./routes.ts";

/** What the webmail module plugs into the platform. */
export const webmailContributions: ModuleContributions = {
  available: webmailSwitchedOn,
  unavailableCode: "WEBMAIL_DISABLED",
  routes: webmailRoutes,
  // No queue class: webmail takes no mail, it only follows a mailbox's removal.
  emailInbound: { mailboxUse: webmailMailboxUse },
  periodic: [webmailMaintenance],
  retention: webmailRetention,
  // Roundcube is a separate deployment configured by the environment only.
  integrations: [
    {
      id: "webmail",
      label: { en: "Webmail", de: "Webmail" },
      category: "email",
      authType: "environment",
      scopes: [],
      storage: ["environment"],
      checkable: false,
    },
  ],
};

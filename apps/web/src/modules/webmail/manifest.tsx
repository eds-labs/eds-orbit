import { Inbox } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { WebmailOverview } from "./overview";

/**
 * Webmail in the web shell (ADR 0026). Opt-in: shown only where the server
 * lists the module as enabled (ORBIT_WEBMAIL and the project row). The mailbox
 * list comes from the member's grants, never from the project role.
 */
export const webmailWeb: WebModule = {
  id: "webmail",
  optIn: true,
  displayName: { en: "Webmail", de: "Webmail" },
  description: {
    en: "Read and answer the mailboxes shared with you.",
    de: "Für dich freigegebene Postfächer lesen und beantworten.",
  },
  // Right after Support (20), before Issues (25).
  groupOrder: 22,
  views: [
    {
      key: "webmail",
      path: "",
      component: WebmailOverview,
      nav: {
        label: { en: "Mailboxes", de: "Postfächer" },
        icon: Inbox,
        order: 0,
      },
    },
  ],
};

import { WebmailHome } from "./home";
import { WebmailInboxHome } from "./inbox-home";
import { Inbox } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { WebmailOverview } from "./overview";
import { webmailSettings } from "./settings";
import { webmailPath } from "./api";
import { unreadTotalLabel } from "./unread-labels";

/**
 * Webmail in the web shell (ADR 0026). Opt-in: shown only where the server
 * lists the module as enabled (ORBIT_WEBMAIL and the project row). The mailbox
 * list comes from the member's grants, never from the project role.
 */
export const webmailWeb: WebModule = {
  homeWidgets: [
    {
      id: "webmail.mailboxes",
      title: { en: "Shared mailboxes", de: "Freigegebene Postfächer" },
      description: {
        en: "Number and status of mailboxes shared with you.",
        de: "Anzahl und Zustand deiner freigegebenen Postfächer.",
      },
      defaultSize: "compact",
      component: WebmailHome,
    },
    {
      id: "webmail.inbox",
      title: { en: "Email inbox", de: "E-Mail-Posteingang" },
      description: {
        en: "Unread counts across your mailboxes and the latest messages in the selected inbox.",
        de: "Ungelesene E-Mails in deinen Postfächern und die neuesten Nachrichten im ausgewählten Posteingang.",
      },
      defaultSize: "compact",
      component: WebmailInboxHome,
    },
  ],
  id: "webmail",
  optIn: true,
  displayName: { en: "Webmail", de: "Webmail" },
  description: {
    en: "Read and answer the mailboxes shared with you.",
    de: "Für dich freigegebene Postfächer lesen und beantworten.",
  },
  // Right after Support (20), before Issues (25).
  groupOrder: 22,
  settings: webmailSettings,
  views: [
    {
      key: "webmail",
      path: "",
      component: WebmailOverview,
      nav: {
        label: { en: "Mailboxes", de: "Postfächer" },
        icon: Inbox,
        order: 0,
        count: {
          path: (id) => webmailPath(id, "/unread"),
          label: unreadTotalLabel,
        },
      },
    },
  ],
};

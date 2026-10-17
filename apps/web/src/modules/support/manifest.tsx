import { LifeBuoy } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { SupportContacts } from "./contacts";
import { SupportHome } from "./home";
import { SupportInbox } from "./inbox";
import { supportSettings } from "./settings";

/**
 * Support in the web shell (WP5.2): the inbox with the ticket view, the
 * contacts, a settings tab and a home tile. Opt-in: shown only where the
 * server lists the module as enabled (ORBIT_SUPPORT and the project row).
 */
export const supportWeb: WebModule = {
  id: "support",
  optIn: true,
  displayName: { en: "Support", de: "Support" },
  description: {
    en: "Customer tickets from e-mail and the app widget.",
    de: "Kundentickets aus E-Mail und dem App-Widget.",
  },
  home: SupportHome,
  homeOrder: 5,
  settings: supportSettings,
  views: [
    {
      key: "support",
      path: "",
      component: SupportInbox,
      nav: {
        label: { en: "Support", de: "Support" },
        icon: LifeBuoy,
        order: 30,
      },
    },
    {
      key: "support-contacts",
      path: "contacts",
      component: SupportContacts,
      title: { en: "Contacts", de: "Kontakte" },
      navKey: "support",
    },
  ],
};

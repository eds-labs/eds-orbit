import { ChartColumn, LayoutDashboard, LifeBuoy, Users } from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label } from "@/platform/shell/types";
import type { WebModule } from "@/platform/shell/types";
import { supportActionRequests } from "./action-requests";
import { supportAttention } from "./attention";
import { SupportContacts } from "./contacts";
import { SupportHome } from "./home";
import { SupportInbox } from "./inbox";
import { SupportOverview } from "./overview";
import { SupportStats } from "./stats";
import { supportSettings } from "./settings";

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

/**
 * Support in the web shell (WP5.2): an overview, the inbox with the ticket
 * view, the contacts, a settings tab and a home tile. Opt-in: shown only where the
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
  groupOrder: 20,
  settings: supportSettings,
  attention: supportAttention,
  actionRequests: supportActionRequests,
  views: [
    {
      key: "support",
      path: "",
      component: SupportOverview,
      nav: { label: label("overview"), icon: LayoutDashboard, order: 0 },
    },
    {
      key: "support-tickets",
      path: "tickets",
      component: SupportInbox,
      nav: {
        label: label("tickets"),
        icon: LifeBuoy,
        order: 10,
        mobile: true,
        mobileRank: 20,
      },
    },
    {
      key: "support-contacts",
      path: "contacts",
      component: SupportContacts,
      nav: { label: label("contacts"), icon: Users, order: 20 },
    },
    {
      key: "support-stats",
      path: "stats",
      component: SupportStats,
      nav: { label: label("statistics"), icon: ChartColumn, order: 30 },
    },
  ],
};

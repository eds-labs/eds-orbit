import { Landmark } from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label, WebModule } from "@/platform/shell/types";
import { financeAttention } from "./attention";
import { FinanceHome } from "./home";
import { FinanceOverview } from "./overview";
import { financeSettings } from "./settings";

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

/**
 * Finance in the web shell (spec §9). Opt-in: shown only where the server
 * lists the module as enabled (ORBIT_FINANCE and the project row).
 *
 * Only the overview is registered so far. The review, bookings, invoices,
 * recurring and reports pages are added with their views in the later tasks
 * (keys `finance.review`, `finance.invoices`, …, which the server's
 * attention items already name as `navKey`); registering empty placeholders
 * would put dead entries in the navigation.
 */
export const financeWeb: WebModule = {
  id: "finance",
  optIn: true,
  displayName: { en: "Finance", de: "Finanzen" },
  description: {
    en: "Receipts, bookings, invoices and reports.",
    de: "Belege, Buchungen, Rechnungen und Berichte.",
  },
  home: FinanceHome,
  homeOrder: 25,
  groupOrder: 40,
  settings: financeSettings,
  attention: financeAttention,
  views: [
    {
      key: "finance",
      path: "",
      component: FinanceOverview,
      nav: { label: label("overview"), icon: Landmark, order: 0 },
    },
  ],
};

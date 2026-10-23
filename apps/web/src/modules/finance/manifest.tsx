import {
  BookOpen,
  ChartColumn,
  ClipboardCheck,
  Landmark,
  Receipt,
  Repeat,
} from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label, WebModule } from "@/platform/shell/types";
import { financeAttention } from "./attention";
import { FinanceEntries } from "./entries";
import { FinanceHome } from "./home";
import { FinanceInvoices } from "./invoices";
import { FinanceOverview } from "./overview";
import { FinanceRecurring } from "./recurring";
import { FinanceReports } from "./reports";
import { FinanceReview } from "./review";
import { financeSettings } from "./settings";

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

/**
 * Finance in the web shell (spec §9). Opt-in: shown only where the server
 * lists the module as enabled (ORBIT_FINANCE and the project row).
 *
 * The overview, the review queue and the management pages (bookings,
 * invoices, recurring costs, reports). The invoices view's key
 * `finance.invoices` is the `navKey` of the server's attention items.
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
    {
      key: "finance.review",
      path: "review",
      component: FinanceReview,
      nav: {
        label: label("financeReviewNav"),
        icon: ClipboardCheck,
        order: 10,
      },
    },
    {
      key: "finance.bookings",
      path: "bookings",
      component: FinanceEntries,
      nav: {
        label: label("financeBookingsNav"),
        icon: BookOpen,
        order: 20,
      },
    },
    {
      key: "finance.invoices",
      path: "invoices",
      component: FinanceInvoices,
      nav: {
        label: label("financeInvoicesNav"),
        icon: Receipt,
        order: 30,
      },
    },
    {
      key: "finance.recurring",
      path: "recurring",
      component: FinanceRecurring,
      nav: {
        label: label("financeRecurringNav"),
        icon: Repeat,
        order: 40,
      },
    },
    {
      key: "finance.reports",
      path: "reports",
      component: FinanceReports,
      nav: {
        label: label("financeReportsNav"),
        icon: ChartColumn,
        order: 50,
      },
    },
  ],
};

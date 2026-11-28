import { ChartNoAxesCombined } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { SeoManagement } from "./manage";
import { SeoOverviewPage } from "./overview";
import { seoText } from "./labels";

export const seoWeb: WebModule = {
  id: "seo",
  optIn: true,
  displayName: { en: "SEO", de: "SEO" },
  description: { en: seoText("en").intro, de: seoText("de").intro },
  groupOrder: 14,
  views: [
    {
      key: "seo",
      path: "",
      component: SeoOverviewPage,
      nav: {
        label: { en: seoText("en").overview, de: seoText("de").overview },
        icon: ChartNoAxesCombined,
        order: 0,
      },
    },
  ],
  integrations: [
    {
      id: "search-console",
      label: { en: seoText("en").manage, de: seoText("de").manage },
      description: {
        en: seoText("en").manageDescription,
        de: seoText("de").manageDescription,
      },
      order: 0,
      providers: ["seo.account.google-search-console"],
      ownHead: true,
      component: SeoManagement,
    },
  ],
};

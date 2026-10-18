import {
  Brain,
  CalendarDays,
  ChartNoAxesColumn,
  FileText,
  Images,
  Target,
} from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label, WebModule } from "@/platform/shell/types";
import { assignmentConfirmRenderer, marketingChat } from "./chat-extension";
import { marketingSettings, PolicySetupLink } from "./settings-sections";
import {
  marketingConnectorExtras,
  marketingConnectorProviders,
} from "./connectors";
import { BrandAssetLibrary } from "@/modules/marketing/advanced";
import { Analytics, Memory } from "./insights";
import {
  CalendarView,
  ContentStudio,
  Missions,
  Overview,
} from "@/modules/marketing/work";

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

function MarketingHome() {
  return <Overview embedded />;
}

/**
 * Marketing in the web shell. Transitional (WP1.7): the views are today's
 * components; WP2.3 moves them into this folder.
 */
export const marketingWeb: WebModule = {
  id: "marketing",
  displayName: { en: "Marketing", de: "Marketing" },
  description: {
    en: "Missions, content, calendar, assets and results.",
    de: "Missionen, Inhalte, Kalender, Assets und Ergebnisse.",
  },
  home: MarketingHome,
  homeOrder: 10,
  groupOrder: 10,
  chat: marketingChat,
  actionRequests: { "assignment.confirm": assignmentConfirmRenderer },
  settings: marketingSettings,
  setupLinks: [PolicySetupLink],
  connectors: {
    providers: marketingConnectorProviders,
    extras: marketingConnectorExtras,
  },
  views: [
    {
      key: "missions",
      path: "missions",
      component: Missions,
      nav: { label: label("missions"), icon: Target, order: 10 },
      legacyPaths: ["/missions"],
    },
    {
      key: "content",
      path: "content",
      component: ContentStudio,
      nav: {
        label: label("content"),
        icon: FileText,
        order: 30,
        mobile: label("contentShort"),
        mobileRank: 40,
      },
      legacyPaths: ["/content"],
    },
    {
      key: "calendar",
      path: "calendar",
      component: CalendarView,
      nav: { label: label("calendar"), icon: CalendarDays, order: 40 },
      legacyPaths: ["/calendar"],
    },
    {
      key: "assets",
      path: "assets",
      component: BrandAssetLibrary,
      nav: { label: label("assets"), icon: Images, order: 60 },
      legacyPaths: ["/assets"],
    },
    {
      key: "analytics",
      path: "analytics",
      component: Analytics,
      nav: { label: label("analytics"), icon: ChartNoAxesColumn, order: 80 },
      legacyPaths: ["/analytics"],
    },
    {
      key: "memory",
      path: "memory",
      component: Memory,
      nav: { label: label("memory"), icon: Brain, order: 90 },
      legacyPaths: ["/memory"],
    },
  ],
};

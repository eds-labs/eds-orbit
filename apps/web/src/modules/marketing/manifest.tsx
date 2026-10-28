import { MarketingPlansPage } from "./plans-page";
import { planReviewRenderer, planActivationRenderer } from "./plan-card";
import {
  Brain,
  CalendarDays,
  ChartNoAxesColumn,
  ClipboardList,
  FileText,
  Images,
  LayoutDashboard,
  Target,
} from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label, WebModule } from "@/platform/shell/types";
import { marketingAttention } from "./attention";
import { assignmentConfirmRenderer, marketingChat } from "./chat-extension";
import {
  creativePreviewRenderer,
  PREVIEW_ACTION,
} from "./creative/preview-request";
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
} from "@/modules/marketing/work";
import { MarketingHomeCard } from "./home";
import { AssignmentsPage } from "./assignments-page";
import { MarketingOverview } from "./overview";

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

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
  home: MarketingHomeCard,
  homeOrder: 10,
  groupOrder: 10,
  chat: marketingChat,
  actionRequests: {
    "assignment.confirm": assignmentConfirmRenderer,
    "marketing_plan.review": planReviewRenderer,
    "marketing_plan.activate": planActivationRenderer,
    [PREVIEW_ACTION]: creativePreviewRenderer,
  },
  attention: marketingAttention,
  settings: marketingSettings,
  setupLinks: [PolicySetupLink],
  connectors: {
    providers: marketingConnectorProviders,
    extras: marketingConnectorExtras,
  },
  views: [
    {
      key: "marketing-overview",
      path: "",
      component: MarketingOverview,
      nav: {
        label: label("overview"),
        icon: LayoutDashboard,
        order: 0,
      },
    },
    {
      key: "marketing-plans",
      path: "plans",
      component: MarketingPlansPage,
      nav: {
        feature: "agents",
        label: { en: "Plans", de: "Pläne" },
        icon: Brain,
        order: 5,
        mobile: true,
        mobileRank: 35,
      },
    },
    {
      key: "missions",
      path: "missions",
      component: Missions,
      nav: { label: label("missions"), icon: Target, order: 10 },
      legacyPaths: ["/missions"],
    },
    {
      // The standing assignments of Orbit Agents (2026-10-19; before in the
      // project settings as section "agents").
      key: "assignments",
      path: "assignments",
      component: AssignmentsPage,
      nav: {
        feature: "agents",
        label: label("assignments"),
        icon: ClipboardList,
        order: 20,
      },
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

import {
  BookOpen,
  Database,
  Library,
  ListChecks,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { labels } from "@/lib/i18n";
import type { WebModule } from "@/platform/shell/types";
import type { Label, ViewDef } from "@/platform/shell/types";
import {
  Knowledge,
  KNOWLEDGE_TABS,
  type KnowledgeTab,
} from "@/modules/knowledge/knowledge";
import { KnowledgeOverview } from "@/modules/knowledge/overview";
import { knowledgeAttention } from "./attention";
import { KnowledgeHomeCard } from "./home";

// Each tab but the overview is a page of its own (WP3.3), reachable by URL.
// Names of the pages in the sidebar and the breadcrumb.
const TAB_TITLES: Record<Exclude<KnowledgeTab, "overview">, Label> = {
  review: { en: "To review", de: "Zu prüfen" },
  sources: { en: labels.en.sources, de: labels.de.sources },
  facts: { en: labels.en.factTab, de: labels.de.factTab },
  import: { en: labels.en.import, de: labels.de.import },
  conflicts: { en: labels.en.conflicts, de: labels.de.conflicts },
  library: { en: labels.en.library, de: labels.de.library },
  health: { en: labels.en.health, de: labels.de.health },
  inspector: { en: labels.en.inspector, de: labels.de.inspector },
  impact: { en: labels.en.impact, de: labels.de.impact },
};

// The content tabs have their own sidebar entry (UI restructure); the
// diagnostic ones (health, inspector, impact) stay under the overview.
const TAB_NAV: Partial<
  Record<Exclude<KnowledgeTab, "overview">, { icon: LucideIcon; order: number }>
> = {
  sources: { icon: Database, order: 10 },
  facts: { icon: ListChecks, order: 20 },
  conflicts: { icon: TriangleAlert, order: 30 },
  import: { icon: Upload, order: 40 },
  library: { icon: Library, order: 50 },
};

const tabView = (tab: Exclude<KnowledgeTab, "overview">): ViewDef => {
  const nav = TAB_NAV[tab];
  return {
    key: `knowledge-${tab}`,
    path: tab,
    component: function KnowledgeTabView() {
      return <Knowledge tab={tab} />;
    },
    alternateNav: {
      feature: "knowledgeWorkspace",
      nav:
        tab === "sources"
          ? {
              label: { en: "Sources", de: "Quellen" },
              icon: Database,
              order: 10,
            }
          : tab === "review"
            ? {
                label: { en: "To review", de: "Zu prüfen" },
                icon: ListChecks,
                order: 20,
              }
            : null,
    },
    ...(nav
      ? { nav: { label: TAB_TITLES[tab], ...nav } }
      : { title: TAB_TITLES[tab], navKey: "knowledge" }),
  };
};

/** Knowledge in the web shell: the overview and one URL per tab (WP3.3). */
export const knowledgeWeb: WebModule = {
  id: "knowledge",
  displayName: { en: "Knowledge", de: "Wissen" },
  description: {
    en: "Sources, verified facts and the search index.",
    de: "Quellen, verifizierte Fakten und der Suchindex.",
  },
  home: KnowledgeHomeCard,
  homeOrder: 20,
  groupOrder: 30,
  attention: knowledgeAttention,
  views: [
    {
      key: "knowledge",
      path: "",
      component: function KnowledgeEntry() {
        return <Knowledge tab="overview" />;
      },
      alternateNav: {
        feature: "knowledgeWorkspace",
        nav: {
          label: { en: "Project knowledge", de: "Projektwissen" },
          icon: BookOpen,
          order: 0,
          mobile: { en: "Knowledge", de: "Wissen" },
          mobileRank: 50,
        },
      },
      nav: {
        label: { en: labels.en.overview, de: labels.de.overview },
        icon: BookOpen,
        order: 0,
        // The bottom bar keeps the module's name; the sidebar says Overview.
        mobile: { en: labels.en.knowledge, de: labels.de.knowledge },
        mobileRank: 50,
      },
      legacyPaths: ["/knowledge"],
    },
    ...KNOWLEDGE_TABS.filter(
      (tab): tab is Exclude<KnowledgeTab, "overview"> => tab !== "overview",
    ).map(tabView),
  ],
};

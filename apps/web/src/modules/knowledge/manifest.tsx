import { BookOpen } from "lucide-react";
import { labels } from "@/lib/i18n";
import type { WebModule } from "@/platform/shell/types";
import type { Label, ViewDef } from "@/platform/shell/types";
import {
  Knowledge,
  KNOWLEDGE_TABS,
  type KnowledgeTab,
} from "@/modules/knowledge/knowledge";

// Each tab but the overview is a page of its own (WP3.3), reachable by URL
// and highlighting the knowledge entry of the sidebar.
// Breadcrumb names of the tabs (the tab bar keeps its own labels).
const TAB_TITLES: Record<Exclude<KnowledgeTab, "overview">, Label> = {
  sources: { en: labels.en.sources, de: labels.de.sources },
  facts: { en: labels.en.factTab, de: labels.de.factTab },
  import: { en: labels.en.import, de: labels.de.import },
  conflicts: { en: "Conflicts", de: "Konflikte" },
  library: { en: labels.en.library, de: labels.de.library },
  health: { en: labels.en.health, de: labels.de.health },
  inspector: { en: labels.en.inspector, de: labels.de.inspector },
  impact: { en: labels.en.impact, de: labels.de.impact },
};

const tabView = (tab: Exclude<KnowledgeTab, "overview">): ViewDef => ({
  key: `knowledge-${tab}`,
  path: tab,
  title: TAB_TITLES[tab],
  component: function KnowledgeTabView() {
    return <Knowledge tab={tab} />;
  },
  navKey: "knowledge",
});

/** Knowledge in the web shell: the overview and one URL per tab (WP3.3). */
export const knowledgeWeb: WebModule = {
  id: "knowledge",
  displayName: { en: "Knowledge", de: "Wissen" },
  description: {
    en: "Sources, verified facts and the search index.",
    de: "Quellen, verifizierte Fakten und der Suchindex.",
  },
  views: [
    {
      key: "knowledge",
      path: "",
      component: function KnowledgeOverview() {
        return <Knowledge tab="overview" />;
      },
      nav: {
        label: { en: labels.en.knowledge, de: labels.de.knowledge },
        icon: BookOpen,
        order: 50,
        mobile: true,
      },
      legacyPaths: ["/knowledge"],
    },
    ...KNOWLEDGE_TABS.filter(
      (tab): tab is Exclude<KnowledgeTab, "overview"> => tab !== "overview",
    ).map(tabView),
  ],
};

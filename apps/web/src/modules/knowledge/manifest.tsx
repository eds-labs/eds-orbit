import { BookOpen } from "lucide-react";
import { labels } from "@/lib/i18n";
import type { WebModule } from "@/platform/shell/types";
import { Knowledge } from "@/modules/knowledge/knowledge";

/**
 * Knowledge in the web shell. Transitional (WP1.7): one page; WP3.3 turns
 * its tabs into URL segments and moves the component into this folder.
 */
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
      component: Knowledge,
      nav: {
        label: { en: labels.en.knowledge, de: labels.de.knowledge },
        icon: BookOpen,
        order: 50,
        mobile: true,
      },
      legacyPaths: ["/knowledge"],
    },
  ],
};

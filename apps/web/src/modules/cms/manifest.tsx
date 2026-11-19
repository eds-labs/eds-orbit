import { FileText, Image, LayoutDashboard, Tags, Users } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { cmsText } from "./labels";
import { CmsOverview } from "./overview";
import { cmsAttention } from "./attention";
import { EntriesView } from "./entries";
import { MediaView } from "./media";
import { TaxonomiesView } from "./taxonomies";
import { AuthorsView } from "./authors";

const nav = (key: keyof ReturnType<typeof cmsText>["nav"]) => ({
  en: cmsText("en").nav[key],
  de: cmsText("de").nav[key],
});

/**
 * The content module in the web shell (ADR 0029): overview, entries with the
 * editor, media, categories and tags, authors (CH1.14a–c); history and
 * calendar follow (CH1.14). Opt-in:
 * shown only where the server lists the module as enabled (ORBIT_CMS and the
 * project row).
 */
export const cmsWeb: WebModule = {
  id: "cms",
  optIn: true,
  displayName: { en: "Content", de: "Inhalte" },
  description: {
    en: "Website articles with versions, SEO and approval-bound publication.",
    de: "Website-Artikel mit Versionen, SEO und freigabepflichtiger Veröffentlichung.",
  },
  // Between Marketing (10) and Social (12).
  groupOrder: 11,
  attention: cmsAttention,
  views: [
    {
      key: "cms",
      path: "",
      component: CmsOverview,
      nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 },
    },
    {
      key: "cms.entries",
      path: "entries",
      component: EntriesView,
      nav: { label: nav("entries"), icon: FileText, order: 10 },
    },
    {
      key: "cms.media",
      path: "media",
      component: MediaView,
      nav: { label: nav("media"), icon: Image, order: 20 },
    },
    {
      key: "cms.taxonomies",
      path: "taxonomies",
      component: TaxonomiesView,
      nav: { label: nav("terms"), icon: Tags, order: 30 },
    },
    {
      key: "cms.authors",
      path: "authors",
      component: AuthorsView,
      nav: { label: nav("authors"), icon: Users, order: 40 },
    },
  ],
};

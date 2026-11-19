import { LayoutDashboard } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { cmsText } from "./labels";
import { CmsOverview } from "./overview";
import { cmsAttention } from "./attention";

const nav = (key: keyof ReturnType<typeof cmsText>["nav"]) => ({
  en: cmsText("en").nav[key],
  de: cmsText("de").nav[key],
});

/**
 * The content module in the web shell (ADR 0029): an overview for now; the
 * entry list, editor, media, history and calendar follow (CH1.14). Opt-in:
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
    { key: "cms", path: "", component: CmsOverview, nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 } },
  ],
};

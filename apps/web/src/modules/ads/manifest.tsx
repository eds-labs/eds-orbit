import { BarChart3, Images, LayoutDashboard, LayoutGrid, Link2, Megaphone } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { adsText } from "./labels";
import { AdsAccounts } from "./accounts";
import { AdsOverview } from "./overview";
import { AdsPlaceholder } from "./placeholder";

const nav = (key: keyof ReturnType<typeof adsText>["nav"]) => ({
  en: adsText("en").nav[key],
  de: adsText("de").nav[key],
});

/**
 * The ads module in the web shell (ADR 0025): an overview and the views later
 * phases fill. Opt-in: shown only where the server lists the module as
 * enabled (ORBIT_ADS and the project row). Viewers see nothing of it.
 */
export const adsWeb: WebModule = {
  id: "ads",
  optIn: true,
  minAccess: "editor",
  displayName: { en: "Ads", de: "Werbung" },
  description: {
    en: "Paid advertising: campaigns, creatives and performance.",
    de: "Bezahlte Werbung: Kampagnen, Werbemittel und Performance.",
  },
  // Right after Social (12), before Work (15).
  groupOrder: 13,
  views: [
    { key: "ads", path: "", component: AdsOverview, nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 } },
    { key: "ads.campaigns", path: "campaigns", component: AdsPlaceholder, nav: { label: nav("campaigns"), icon: Megaphone, order: 10 } },
    { key: "ads.units", path: "units", component: AdsPlaceholder, nav: { label: nav("units"), icon: LayoutGrid, order: 20 } },
    { key: "ads.creatives", path: "creatives", component: AdsPlaceholder, nav: { label: nav("creatives"), icon: Images, order: 30 } },
    { key: "ads.performance", path: "performance", component: AdsPlaceholder, nav: { label: nav("performance"), icon: BarChart3, order: 40 } },
    { key: "ads.accounts", path: "accounts", component: AdsAccounts, nav: { label: nav("accounts"), icon: Link2, order: 50 } },
  ],
};

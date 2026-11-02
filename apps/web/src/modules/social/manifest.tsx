import { AtSign, BarChart3, CalendarDays, Images, LayoutDashboard, PenSquare } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { socialText } from "./labels";
import { SocialOverview } from "./overview";
import { SocialPlaceholder } from "./placeholder";

const nav = (key: keyof ReturnType<typeof socialText>["nav"]) => ({
  en: socialText("en").nav[key],
  de: socialText("de").nav[key],
});

/**
 * The social module in the web shell (ADR 0020): an overview and the views
 * later phases fill (calendar, posts, media, accounts, analytics). Opt-in:
 * shown only where the server lists the module as enabled (ORBIT_SOCIAL and
 * the project row).
 */
export const socialWeb: WebModule = {
  id: "social",
  optIn: true,
  displayName: { en: "Social", de: "Social Media" },
  description: {
    en: "Social accounts, posts and the publishing calendar.",
    de: "Social-Media-Konten, Beiträge und der Veröffentlichungskalender.",
  },
  // Right after Marketing (10), before Work (15).
  groupOrder: 12,
  views: [
    { key: "social", path: "", component: SocialOverview, nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 } },
    { key: "social.calendar", path: "calendar", component: SocialPlaceholder, nav: { label: nav("calendar"), icon: CalendarDays, order: 10 } },
    { key: "social.posts", path: "posts", component: SocialPlaceholder, nav: { label: nav("posts"), icon: PenSquare, order: 20 } },
    { key: "social.media", path: "media", component: SocialPlaceholder, nav: { label: nav("media"), icon: Images, order: 30 } },
    { key: "social.accounts", path: "accounts", component: SocialPlaceholder, nav: { label: nav("accounts"), icon: AtSign, order: 40 } },
    { key: "social.analytics", path: "analytics", component: SocialPlaceholder, nav: { label: nav("analytics"), icon: BarChart3, order: 50 } },
  ],
};

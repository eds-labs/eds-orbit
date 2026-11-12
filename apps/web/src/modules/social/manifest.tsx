import { AtSign, BarChart3, CalendarDays, Images, LayoutDashboard, PenSquare } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { AccountsView } from "./accounts";
import { SocialAccountsPage } from "./accounts-page";
import { socialActionRequests } from "./action-requests";
import { socialAttention } from "./attention";
import { MediaView } from "./media";
import { socialText } from "./labels";
import { SocialOverview } from "./overview";
import { PostsView } from "./posts/posts-view";
import { CalendarView } from "./calendar/calendar-view";
import { AnalyticsView } from "./analytics";
import { AddToSocialAction } from "./drive-action";

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
  attention: socialAttention,
  actionRequests: socialActionRequests,
  // Images from the Google Drive page into the media library (design 2026-11-05).
  drive: { fileActions: [AddToSocialAction] },
  // The accounts page in the settings center's Integrations area (ADR 0027);
  // its own page /p/:id/social/accounts mounts the same view until the center
  // is on, then only states the accounts and links here.
  integrations: [
    {
      id: "accounts",
      label: { en: "Social accounts", de: "Social-Media-Konten" },
      description: {
        en: "Connect, check and disconnect the project's social media accounts.",
        de: "Social-Media-Konten des Projekts verbinden, prüfen und trennen.",
      },
      order: 0,
      // The catalog ids of the account providers (apps/api social/accounts/providers.ts).
      providers: ["social.account.x", "social.account.facebook", "social.account.instagram", "social.account.telegram"],
      ownHead: true,
      component: AccountsView,
    },
  ],
  views: [
    { key: "social", path: "", component: SocialOverview, nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 } },
    { key: "social.calendar", path: "calendar", component: CalendarView, nav: { label: nav("calendar"), icon: CalendarDays, order: 10 } },
    { key: "social.posts", path: "posts", component: PostsView, nav: { label: nav("posts"), icon: PenSquare, order: 20 } },
    { key: "social.media", path: "media", component: MediaView, nav: { label: nav("media"), icon: Images, order: 30 } },
    { key: "social.accounts", path: "accounts", component: SocialAccountsPage, nav: { label: nav("accounts"), icon: AtSign, order: 40 } },
    { key: "social.analytics", path: "analytics", component: AnalyticsView, nav: { label: nav("analytics"), icon: BarChart3, order: 50 } },
  ],
};

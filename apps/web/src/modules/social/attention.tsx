import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { socialText } from "./labels";

// The social module's attention texts: counts only, no handles.

const open: Label = { en: socialText("en").attention.open, de: socialText("de").attention.open };
const openPosts: Label = { en: socialText("en").attention.openPosts, de: socialText("de").attention.openPosts };

export const socialAttention: Readonly<Record<string, AttentionRenderer>> = {
  social_account_reconnect: (item, locale) => ({
    title: socialText(locale).attention.reconnect(item.count ?? 1),
    action: open,
  }),
  // Approved posts whose time passed unsent, e.g. during a pause (S5).
  social_post_missed: (item, locale) => ({
    title: socialText(locale).attention.missed(item.count ?? 1),
    action: openPosts,
  }),
  // Unclear, held back or failed publications (S5).
  social_publication_problem: (item, locale) => ({
    title: socialText(locale).attention.publications(item.count ?? 1),
    action: openPosts,
  }),
};

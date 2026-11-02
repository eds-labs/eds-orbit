import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { socialText } from "./labels";

// The social module's attention texts: counts only, no handles.

const open: Label = { en: socialText("en").attention.open, de: socialText("de").attention.open };

export const socialAttention: Readonly<Record<string, AttentionRenderer>> = {
  social_account_reconnect: (item, locale) => ({
    title: socialText(locale).attention.reconnect(item.count ?? 1),
    action: open,
  }),
};

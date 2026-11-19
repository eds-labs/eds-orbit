import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { cmsText } from "./labels";

// The content module's attention texts (CH1.17): counts only, no titles.

const open: Label = { en: cmsText("en").attention.open, de: cmsText("de").attention.open };

export const cmsAttention: Readonly<Record<string, AttentionRenderer>> = {
  // A publication stopped before going live (preflight, lateness, changed sites).
  cms_publication_stopped: (item, locale) => ({ title: cmsText(locale).attention.stopped(item.count ?? 1), action: open }),
  // Live in Orbit, but the site's page did not show the revision after the last check.
  cms_live_check_failed: (item, locale) => ({ title: cmsText(locale).attention.liveCheck(item.count ?? 1), action: open }),
};

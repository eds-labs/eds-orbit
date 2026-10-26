import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { issuesText } from "./labels";

// The module's attention texts (UI restructure §4.3): counts only, no titles.

const open: Label = { en: issuesText("en").attention.open, de: issuesText("de").attention.open };

export const issuesAttention: Readonly<Record<string, AttentionRenderer>> = {
  issues_critical: (item, locale) => ({ title: issuesText(locale).attention.critical(item.count ?? 1), action: open }),
  issues_triage_backlog: (item, locale) => ({ title: issuesText(locale).attention.triage(item.count ?? 1), action: open }),
  issues_duplicates_pending: (item, locale) => ({ title: issuesText(locale).attention.duplicates(item.count ?? 1), action: open }),
  issues_release_unconfirmed: (item, locale) => ({ title: issuesText(locale).attention.release(item.count ?? 1), action: open }),
  issues_closed_open_tasks: (item, locale) => ({ title: issuesText(locale).attention.openTasks(item.count ?? 1), action: open }),
};

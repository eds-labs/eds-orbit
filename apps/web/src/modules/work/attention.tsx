import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { workText } from "./labels";

// The module's attention texts (UI restructure §4.3): counts only, no titles.

const action = (key: "openMine" | "openBoard" | "openMilestones"): Label => ({
  en: workText("en").attention[key],
  de: workText("de").attention[key],
});

export const workAttention: Readonly<Record<string, AttentionRenderer>> = {
  work_overdue_mine: (item, locale) => ({
    title: workText(locale).attention.overdue(item.count ?? 1),
    action: action("openMine"),
  }),
  work_blocked: (item, locale) => ({
    title: workText(locale).attention.blocked(item.count ?? 1),
    action: action("openBoard"),
  }),
  work_milestone_due: (item, locale) => ({
    title: workText(locale).attention.milestones(item.count ?? 1),
    action: action("openMilestones"),
  }),
};

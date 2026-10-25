import type { AttentionRenderer, Label } from "@/platform/shell/types";
import { workText } from "./labels";
import { pmText } from "./pm-labels";

// The module's attention texts (UI restructure §4.3): counts only, no titles.

const action = (key: "openMine" | "openBoard" | "openMilestones"): Label => ({
  en: workText("en").attention[key],
  de: workText("de").attention[key],
});

const pmAction = (key: "open" | "openTasks"): Label => ({
  en: pmText("en").attention[key],
  de: pmText("de").attention[key],
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
  // AI project manager (ADR 0017).
  work_pm_critical: (item, locale) => ({
    title: pmText(locale).attention.critical(item.count ?? 1),
    action: pmAction("open"),
  }),
  work_pm_plan_ready: (item, locale) => ({
    title: pmText(locale).attention.planReady(item.count ?? 1),
    action: pmAction("open"),
  }),
  work_pm_budget: (_item, locale) => ({
    title: pmText(locale).attention.budget,
    action: pmAction("open"),
  }),
  work_coding_unknown: (item, locale) => ({
    title: pmText(locale).attention.codingUnknown(item.count ?? 1),
    action: pmAction("openTasks"),
  }),
};

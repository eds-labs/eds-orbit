import type { UserNotificationKind } from "../../platform/notifications/members.ts";
import type { SignalDefinition } from "../../platform/signals/types.ts";

// Marketing's proactive signal (ADR 0023 item 4, plan §2.2): a mapping only.
// Assignment exceptions the owner's Telegram bot already reports (a paused
// budget, drafts left for the owner, a run with problems) also become a
// member notice for the project's owners, through the bot's own `notify`
// call and keyed by its job key: nothing is detected a second time, and
// the notice carries the kind's label only.
export const marketingSignalNotifications: Readonly<Record<string, UserNotificationKind>> = {
  marketing_assignment_attention: {
    label: { en: "An assignment needs attention", de: "Ein Auftrag braucht Aufmerksamkeit" },
    emailDefault: false,
    proactive: true,
  },
  // A released post that would be refused at its slot (and its all-clear): the
  // watch writes these directly, naming the post and the reasons for the owners.
  marketing_post_at_risk: {
    label: { en: "A released post will not be published", de: "Ein freigegebener Post wird nicht veröffentlicht" },
    emailDefault: true,
  },
  marketing_post_at_risk_cleared: {
    label: { en: "An at-risk post can be published again", de: "Ein gefährdeter Post kann wieder veröffentlicht werden" },
    emailDefault: false,
  },
};

export const marketingSignals: readonly SignalDefinition[] = [
  {
    key: "marketing.assignment_attention",
    kind: "marketing_assignment_attention",
    title: { en: "Assignments that need attention", de: "Aufträge, die Aufmerksamkeit brauchen" },
    link: "/marketing",
    source: {
      botKinds: {
        budget_paused: "urgent",
        needs_owner: "attention",
        run_problem: "attention",
      },
    },
  },
];

import type { SignalDefinition } from "../../platform/signals/types.ts";

// Support's proactive signal (ADR 0023 item 4, plan §2.2): a mapping only.
// The SLA and hand-off notices keep their own sender and recipients
// (automations.ts); the mapping gives them a severity, so they join the
// cross-project feed, the digest and per-user Telegram. Nothing is
// detected a second time.
export const supportSignals: readonly SignalDefinition[] = [
  {
    key: "support.urgent_ticket",
    kind: "support_sla_breached",
    title: { en: "Urgent tickets", de: "Dringende Tickets" },
    source: {
      kinds: {
        support_sla_at_risk: "attention",
        support_sla_breached: "urgent",
        support_ai_handoff: "urgent",
      },
    },
  },
];

import type { AttentionItem } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type { AttentionRenderer, Label } from "@/platform/shell/types";

// The support module's attention texts (UI restructure §4.3). Params carry
// the ticket number, subject, channel and whether someone is assigned, never
// a message body; the home page shows the due time from `dueAt`.

const OPEN_TICKET: Label = { en: "Open ticket", de: "Ticket öffnen" };

const CHANNELS: Record<string, Label> = {
  email: { en: "E-mail", de: "E-Mail" },
  widget: { en: "Widget", de: "Widget" },
};

/** "#1042 Subject", or the number alone for an empty subject. */
function ticketName(item: AttentionItem) {
  const subject = String(item.params.subject ?? "").trim();
  return [`#${String(item.params.number ?? "—")}`, subject]
    .filter(Boolean)
    .join(" ");
}

/** Channel and assignment, such as "E-mail · unassigned". */
function ticketDetail(item: AttentionItem, locale: Locale) {
  const channel = String(item.params.channel ?? "");
  const de = locale === "de";
  return [
    channel ? (CHANNELS[channel]?.[locale] ?? channel) : null,
    item.params.assigned === true
      ? de
        ? "zugewiesen"
        : "assigned"
      : item.params.assigned === false
        ? de
          ? "nicht zugewiesen"
          : "unassigned"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const sla =
  (label: Label): AttentionRenderer =>
  (item, locale) => ({
    title: `${label[locale]} · ${ticketName(item)}`,
    detail: ticketDetail(item, locale) || undefined,
    action: OPEN_TICKET,
  });

export const supportAttention: Readonly<Record<string, AttentionRenderer>> = {
  support_sla_breached: sla({ en: "SLA breached", de: "SLA verletzt" }),
  support_sla_at_risk: sla({ en: "SLA at risk", de: "SLA gefährdet" }),
  support_unassigned: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${n === 1 ? "Ticket" : "Tickets"} nicht zugewiesen`
          : `${n} unassigned ticket${n === 1 ? "" : "s"}`,
      action: { en: "Show tickets", de: "Tickets anzeigen" },
    };
  },
};

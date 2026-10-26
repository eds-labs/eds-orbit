import type { AttentionItem } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type { AttentionRenderer, Label } from "@/platform/shell/types";

// The support module's attention texts (UI restructure §4.3). Params carry
// the ticket number, subject, channel and whether someone is assigned, never
// a message body; the home page shows the due time from `dueAt`. Each ticket
// counts once (R20): beyond the listed ones, one item per SLA kind counts the
// rest without names, and the unassigned item counts only the others.

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

const SHOW_TICKETS: Label = { en: "Show tickets", de: "Tickets anzeigen" };

/**
 * A breached or at-risk ticket: "<label> · #1042 <subject>", or the count of
 * the further ones for the aggregated item (no ticket number).
 */
const sla =
  (label: Label, more: (n: number) => Label): AttentionRenderer =>
  (item, locale) =>
    item.params.number === undefined && item.count !== undefined
      ? { title: more(item.count)[locale], action: SHOW_TICKETS }
      : {
          title: `${label[locale]} · ${ticketName(item)}`,
          detail: ticketDetail(item, locale) || undefined,
          action: OPEN_TICKET,
        };

export const supportAttention: Readonly<Record<string, AttentionRenderer>> = {
  support_sla_breached: sla(
    { en: "SLA breached", de: "SLA verletzt" },
    (n) => ({
      en: `${n} more ticket${n === 1 ? "" : "s"} with SLA breached`,
      de: `${n} ${n === 1 ? "weiteres Ticket" : "weitere Tickets"} mit verletztem SLA`,
    }),
  ),
  support_sla_at_risk: sla({ en: "SLA at risk", de: "SLA gefährdet" }, (n) => ({
    en: `${n} more ticket${n === 1 ? "" : "s"} with SLA at risk`,
    de: `${n} ${n === 1 ? "weiteres Ticket" : "weitere Tickets"} mit gefährdetem SLA`,
  })),
  // A reported product issue was released (ADR 0018): the agent tells the customer.
  support_issue_released: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `Fix freigegeben: ${n} ${n === 1 ? "Ticket" : "Tickets"} informieren`
          : `Fix released: inform ${n} ticket${n === 1 ? "" : "s"}`,
      action: SHOW_TICKETS,
    };
  },
  support_unassigned: (item, locale) => {
    const n = item.count ?? 1;
    // Unassigned tickets with an SLA item are listed above it.
    const others = item.params.othersListed === true;
    return {
      title:
        locale === "de"
          ? others
            ? `${n} weitere ohne Zuweisung`
            : `${n} ${n === 1 ? "Ticket" : "Tickets"} nicht zugewiesen`
          : others
            ? `${n} more unassigned`
            : `${n} unassigned ticket${n === 1 ? "" : "s"}`,
      action: SHOW_TICKETS,
    };
  },
};

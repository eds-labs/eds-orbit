import type { AttentionRenderer, Label } from "@/platform/shell/types";

// The finance module's attention texts (UI restructure §4.3). The server
// sends counts only (no names, no amounts); the text comes from the kind.

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const REVIEW: Label = { en: "Open review", de: "Prüfliste öffnen" };
const INVOICES: Label = { en: "Show invoices", de: "Rechnungen anzeigen" };
const SETTINGS: Label = { en: "Open settings", de: "Einstellungen öffnen" };

export const financeAttention: Readonly<Record<string, AttentionRenderer>> = {
  finance_review_pending: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${plural(n, "Beleg", "Belege")} zu prüfen`
          : `${n} ${plural(n, "receipt", "receipts")} to review`,
      action: REVIEW,
    };
  },
  finance_invoices_overdue: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${plural(n, "Rechnung", "Rechnungen")} überfällig`
          : `${n} overdue ${plural(n, "invoice", "invoices")}`,
      action: INVOICES,
    };
  },
  finance_mail_archive_failed: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${plural(n, "Postfach kann", "Postfächer können")} nicht archivieren`
          : `${n} ${plural(n, "mailbox cannot", "mailboxes cannot")} archive mail`,
      action: SETTINGS,
    };
  },
  finance_fx_stale: (_item, locale) => ({
    title:
      locale === "de"
        ? "Wechselkurse sind veraltet"
        : "Exchange rates are out of date",
    action: SETTINGS,
  }),
};

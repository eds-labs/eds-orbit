import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
} from "../../platform/attention/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { financeActive } from "./gate.ts";
import { mailboxesView } from "./queries.ts";
import { FINANCE_READ, FINANCE_SETTINGS } from "./permissions.ts";
import { readFinanceSettings } from "./settings.ts";

// The finance module's attention items, computed at read time and never
// stored. Params stay empty: counts only, no names or amounts. Settings
// items badge the platform's settings entry and open finance's section.

/** An ECB feed older than this many days counts as stale. */
export const FX_STALE_DAYS = 4;
const DAY_MS = 86_400_000;

/**
 * True when some configured currency pair needs ECB rates: USD and USDC
 * convert through the project's peg and need none.
 */
function needsEcbRates(settings: {
  baseCurrency: string;
  currencies: string[];
}) {
  const pegged = new Set(["USD", "USDC"]);
  return settings.currencies.some(
    (c) =>
      c !== settings.baseCurrency &&
      !(pegged.has(c) && pegged.has(settings.baseCurrency)),
  );
}

async function fxStale(tx: DbTx, scope: Scope, now: Date) {
  const { settings } = await readFinanceSettings(tx, scope);
  if (settings.fxSource !== "ecb" || !needsEcbRates(settings)) return null;
  const newest = await tx.financeFxRate.findFirst({
    where: { projectId: scope.projectId, source: "ecb" },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!newest) return { since: undefined };
  const age = now.getTime() - newest.date.getTime();
  return age > FX_STALE_DAYS * DAY_MS
    ? { since: newest.date.toISOString() }
    : null;
}

export const financeAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => {
  if (!can(scope, FINANCE_READ)) return [];
  if (!(await financeActive(tx, scope))) return [];
  const items: AttentionItem[] = [];
  const base = { moduleId: "finance", params: {} } as const;

  const review = await tx.financeDocument.count({
    where: {
      projectId: scope.projectId,
      status: { in: ["needs_review", "failed"] },
    },
  });
  if (review > 0)
    items.push({
      ...base,
      id: "finance:review_pending",
      kind: "finance_review_pending",
      severity: "warning",
      count: review,
      navKey: "finance.review",
      link: "/finance/review",
    });

  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const overdue = await tx.financeInvoice.count({
    where: {
      projectId: scope.projectId,
      status: { in: ["open", "partially_paid"] },
      dueDate: { lt: today },
      // An open credit note is a credit, never overdue.
      kind: { not: "credit_note" },
    },
  });
  if (overdue > 0)
    items.push({
      ...base,
      id: "finance:invoices_overdue",
      kind: "finance_invoices_overdue",
      severity: "warning",
      count: overdue,
      navKey: "finance.invoices",
      link: "/finance/invoices?status=overdue",
    });

  // Mailbox bindings are owner settings, so only owners see their failures.
  if (can(scope, FINANCE_SETTINGS)) {
    const failed = (await mailboxesView(tx, scope)).filter(
      (m) => m.active && m.lastArchiveError,
    ).length;
    if (failed > 0)
      items.push({
        ...base,
        id: "finance:mail_archive_failed",
        kind: "finance_mail_archive_failed",
        severity: "info",
        count: failed,
        navKey: "settings",
        link: "/settings?section=finance-mailboxes",
      });
  }

  const stale = await fxStale(tx, scope, now);
  if (stale)
    items.push({
      ...base,
      id: "finance:fx_stale",
      kind: "finance_fx_stale",
      severity: "info",
      ...(stale.since ? { since: stale.since } : {}),
      navKey: "settings",
      link: "/settings?section=finance-currencies",
    });
  return items;
};

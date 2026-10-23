import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { isoDate } from "./common.ts";
import { rateFor } from "./fx.ts";
import { invoiceStatusView, isOpenCredit } from "./invoices.ts";
import { invoiceBalances } from "./payments.ts";
import { CURRENCY_DECIMALS, convert } from "./money.ts";
import { monthlyEquivalent } from "./recurring.ts";
import { readFinanceSettings } from "./settings.ts";

// Read-side reports (spec §10). Income and expense are the posted lines on
// income and expense accounts, summed by the UTC month of the entry date.
// A reversal is itself a posted entry with swapped sides, so summing every
// posted line nets reversals out without filtering anything. All money in
// views is a decimal string of base-currency micros.

const MAX_MONTHS = 120;
const TOP_CATEGORIES = 8;
const monthOf = (date: string) => date.slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const str = (micros: bigint) => micros.toString();

type Range = { from: string; to: string };

function parseRange(range: Range): Range {
  const { from, to } = range;
  const valid = (d: string) =>
    isoDate.safeParse(d).success &&
    new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) === d;
  if (!valid(from) || !valid(to) || from > to)
    throw new DomainError("FINANCE_RANGE_INVALID", 422);
  return range;
}

/** Every UTC month `YYYY-MM` from the month of `from` to the month of `to`. */
function monthsBetween({ from, to }: Range): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const end = monthOf(to);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > end) break;
    months.push(key);
    if (months.length > MAX_MONTHS)
      throw new DomainError("FINANCE_RANGE_INVALID", 422);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

type Sum = {
  month: string;
  type: "income" | "expense";
  categoryId: string | null;
  costCenterId: string | null;
  /** Expense: debit minus credit. Income: credit minus debit. */
  amount: bigint;
};

/** Posted income and expense lines grouped by month, type, category and cost center. */
async function lineSums(
  tx: DbTx,
  scope: Scope,
  { from, to }: Range,
): Promise<Sum[]> {
  const rows = await tx.$queryRaw<
    {
      month: string;
      type: string;
      categoryId: string | null;
      costCenterId: string | null;
      net: string;
    }[]
  >`
    SELECT to_char(e."entryDate", 'YYYY-MM') AS month,
           a."type" AS "type",
           l."categoryId" AS "categoryId",
           l."costCenterId" AS "costCenterId",
           SUM(CASE WHEN l."side" = 'debit' THEN l."baseAmountMicros"
                    ELSE -l."baseAmountMicros" END)::text AS net
      FROM "FinanceJournalLine" l
      JOIN "FinanceJournalEntry" e
        ON e."projectId" = l."projectId" AND e."id" = l."entryId"
      JOIN "FinanceAccount" a
        ON a."projectId" = l."projectId" AND a."id" = l."accountId"
     WHERE l."projectId" = ${scope.projectId}::uuid
       AND e."status" = 'posted'
       AND e."entryDate" >= ${from}::date
       AND e."entryDate" <= ${to}::date
       AND a."type" IN ('income', 'expense')
     GROUP BY 1, 2, 3, 4`;
  return rows.map((r) => {
    const net = BigInt(r.net);
    const type = r.type as "income" | "expense";
    return {
      month: r.month,
      type,
      categoryId: r.categoryId,
      costCenterId: r.costCenterId,
      amount: type === "expense" ? net : -net,
    };
  });
}

type CategoryRow = {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
};

async function loadCategories(tx: DbTx, scope: Scope) {
  const rows: CategoryRow[] = await tx.financeCategory.findMany({
    where: { projectId: scope.projectId },
    select: { id: true, name: true, kind: true, parentId: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** The highest ancestor of `id` (itself included) accepted by `stop`, else the root. */
function headOf(
  categories: Map<string, CategoryRow>,
  id: string,
  accept: (id: string) => boolean = () => true,
): string | null {
  let head: string | null = null;
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (accept(current)) head = current;
    current = categories.get(current)?.parentId ?? null;
  }
  return head;
}

const add = <K>(map: Map<K, bigint>, key: K, amount: bigint) =>
  map.set(key, (map.get(key) ?? 0n) + amount);

function prefixMatch<T extends { name: string }>(
  rows: Iterable<T>,
  query: string,
) {
  const needle = query.trim().toLowerCase();
  return [...rows].filter(
    (r) => needle && r.name.toLowerCase().startsWith(needle),
  );
}

/**
 * Open invoices in base with something left. Without `asOf`, today's state:
 * status open/partially_paid. With `asOf` (ISO date): every non-void
 * invoice issued on or before it, less payments dated and credit notes
 * issued on or before it. Voids carry no date, so a payment voided after
 * `asOf` counts as never made, and an invoice voided later is excluded.
 */
async function openItems(tx: DbTx, scope: Scope, asOf?: string) {
  const invoices = await tx.financeInvoice.findMany({
    where: asOf
      ? {
          projectId: scope.projectId,
          status: { not: "void" },
          issueDate: { lte: new Date(`${asOf}T00:00:00.000Z`) },
        }
      : {
          projectId: scope.projectId,
          status: { in: ["open", "partially_paid"] },
        },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
  });
  // The batch helper honours credits and voided payments; its base is the
  // invoice's posted open-item base less what earlier payments settled.
  const balances = await invoiceBalances(tx, scope, invoices, asOf);
  // Standalone credit notes are credits, kept apart from the invoices.
  return invoices.flatMap((invoice) => {
    const balance = balances.get(invoice.id)!;
    return balance.openAmountMicros > 0n
      ? [{ invoice, balance, credit: isOpenCredit(invoice) }]
      : [];
  });
}

export async function financeSummary(tx: DbTx, scope: Scope, raw: Range) {
  const range = parseRange(raw);
  const { settings } = await readFinanceSettings(tx, scope);
  const months = monthsBetween(range);
  const sums = await lineSums(tx, scope, range);

  const income = new Map<string, bigint>();
  const expense = new Map<string, bigint>();
  const byCenter = new Map<string | null, bigint>();
  const byCategoryMonth = new Map<string | null, Map<string, bigint>>();
  const categories = await loadCategories(tx, scope);
  for (const s of sums) {
    if (s.type === "income") {
      add(income, s.month, s.amount);
      continue;
    }
    add(expense, s.month, s.amount);
    add(byCenter, s.costCenterId, s.amount);
    const head = s.categoryId ? headOf(categories, s.categoryId) : null;
    const perMonth = byCategoryMonth.get(head) ?? new Map<string, bigint>();
    add(perMonth, s.month, s.amount);
    byCategoryMonth.set(head, perMonth);
  }

  // Open and overdue, split by direction because payables and receivables
  // are different kinds of money. Open credits (standalone credit notes)
  // are counted apart and reduce the open totals; they are never overdue.
  const now = today();
  const open = {
    count: 0,
    totalMicros: 0n,
    payableMicros: 0n,
    receivableMicros: 0n,
  };
  const overdue = {
    count: 0,
    totalMicros: 0n,
    payableMicros: 0n,
    receivableMicros: 0n,
  };
  const creditsOpen = {
    count: 0,
    totalMicros: 0n,
    payableMicros: 0n,
    receivableMicros: 0n,
  };
  for (const { invoice, balance, credit } of await openItems(tx, scope)) {
    if (credit) {
      const amount = balance.openBaseMicros;
      creditsOpen.count += 1;
      creditsOpen.totalMicros += amount;
      open.totalMicros -= amount;
      if (invoice.direction === "payable") {
        creditsOpen.payableMicros += amount;
        open.payableMicros -= amount;
      } else {
        creditsOpen.receivableMicros += amount;
        open.receivableMicros -= amount;
      }
      continue;
    }
    const bucket = [open];
    if (invoiceStatusView(invoice, now) === "overdue") bucket.push(overdue);
    for (const b of bucket) {
      b.count += 1;
      b.totalMicros += balance.openBaseMicros;
      if (invoice.direction === "payable")
        b.payableMicros += balance.openBaseMicros;
      else b.receivableMicros += balance.openBaseMicros;
    }
  }

  // Recurring costs per month in base at today's latest stored rate; an
  // entry without a rate is skipped and counted, never converted at 1.
  let recurringMonthlyMicros = 0n;
  let recurringMissingRate = 0;
  const baseDecimals = CURRENCY_DECIMALS[settings.baseCurrency];
  const recurring = await tx.financeRecurring.findMany({
    where: { projectId: scope.projectId, active: true },
  });
  for (const r of recurring) {
    try {
      const monthly = monthlyEquivalent(r);
      const rate = await rateFor(
        tx,
        scope,
        r.currency,
        settings.baseCurrency,
        now,
      );
      recurringMonthlyMicros += convert(monthly, rate.rate, baseDecimals);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "FX_RATE_MISSING"))
        throw error;
      recurringMissingRate += 1;
    }
  }

  const centers = new Map(
    (
      await tx.financeCostCenter.findMany({
        where: { projectId: scope.projectId },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );
  const ranked = [...byCategoryMonth.entries()].map(([id, perMonth]) => ({
    id,
    perMonth,
    total: [...perMonth.values()].reduce((a, b) => a + b, 0n),
  }));
  ranked.sort((a, b) => (a.total === b.total ? 0 : a.total > b.total ? -1 : 1));
  const monthsOf = (perMonth: Map<string, bigint>) =>
    months.map((month) => ({
      month,
      expenseMicros: str(perMonth.get(month) ?? 0n),
    }));
  const named = ranked.filter((r) => r.id !== null);
  const top = named.slice(0, TOP_CATEGORIES);
  const rest = new Map<string, bigint>();
  for (const r of [
    ...named.slice(TOP_CATEGORIES),
    ...ranked.filter((r) => r.id === null),
  ])
    for (const [month, amount] of r.perMonth) add(rest, month, amount);

  const reviewCount = await tx.financeDocument.count({
    where: { projectId: scope.projectId, status: "needs_review" },
  });

  return {
    baseCurrency: settings.baseCurrency,
    from: range.from,
    to: range.to,
    months: months.map((month) => {
      const i = income.get(month) ?? 0n;
      const e = expense.get(month) ?? 0n;
      return {
        month,
        incomeMicros: str(i),
        expenseMicros: str(e),
        resultMicros: str(i - e),
      };
    }),
    open: {
      ...open,
      totalMicros: str(open.totalMicros),
      payableMicros: str(open.payableMicros),
      receivableMicros: str(open.receivableMicros),
    },
    overdue: {
      ...overdue,
      totalMicros: str(overdue.totalMicros),
      payableMicros: str(overdue.payableMicros),
      receivableMicros: str(overdue.receivableMicros),
    },
    creditsOpen: {
      ...creditsOpen,
      totalMicros: str(creditsOpen.totalMicros),
      payableMicros: str(creditsOpen.payableMicros),
      receivableMicros: str(creditsOpen.receivableMicros),
    },
    recurringMonthlyMicros: str(recurringMonthlyMicros),
    recurringMissingRate,
    // `id: null` is "Unassigned"; the web supplies the label.
    byCostCenter: [...byCenter.entries()]
      .map(([id, amount]) => ({
        id,
        name: id ? (centers.get(id) ?? null) : null,
        expenseMicros: amount,
      }))
      .sort((a, b) =>
        a.expenseMicros === b.expenseMicros
          ? 0
          : a.expenseMicros > b.expenseMicros
            ? -1
            : 1,
      )
      .map((c) => ({ ...c, expenseMicros: str(c.expenseMicros) })),
    byCategory: [
      ...top.map((r) => ({
        id: r.id,
        name: categories.get(r.id!)?.name ?? null,
        months: monthsOf(r.perMonth),
      })),
      ...(rest.size
        ? [
            {
              id: null,
              name: null,
              other: true as const,
              months: monthsOf(rest),
            },
          ]
        : []),
    ],
    reviewCount,
  };
}

export type CostReportInput = Range & {
  groupBy: "month" | "category" | "costCenter";
  category?: string;
  costCenter?: string;
  kind: "income" | "expense";
};

export async function costReport(tx: DbTx, scope: Scope, raw: CostReportInput) {
  const range = parseRange(raw);
  const { settings } = await readFinanceSettings(tx, scope);
  const months = monthsBetween(range);
  const categories = await loadCategories(tx, scope);
  const centers = new Map(
    (
      await tx.financeCostCenter.findMany({
        where: { projectId: scope.projectId },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );

  // A category filter matches names by prefix and takes the matches with
  // all their descendants; the matches are the groups children roll into.
  let matchedCategories: Set<string> | null = null;
  if (raw.category !== undefined)
    matchedCategories = new Set(
      prefixMatch(categories.values(), raw.category).map((c) => c.id),
    );
  let matchedCenters: Set<string> | null = null;
  if (raw.costCenter !== undefined)
    matchedCenters = new Set(
      prefixMatch(
        [...centers].map(([id, name]) => ({ id, name })),
        raw.costCenter,
      ).map((c) => c.id),
    );
  const empty = matchedCategories?.size === 0 || matchedCenters?.size === 0;

  const byMonth = new Map<string, bigint>();
  const byCategory = new Map<string | null, bigint>();
  const byCenter = new Map<string | null, bigint>();
  let total = 0n;
  if (!empty)
    for (const s of await lineSums(tx, scope, range)) {
      if (s.type !== raw.kind) continue;
      let head: string | null = null;
      if (s.categoryId) {
        head = headOf(
          categories,
          s.categoryId,
          matchedCategories ? (id) => matchedCategories!.has(id) : undefined,
        );
      }
      if (matchedCategories && (!head || !matchedCategories.has(head)))
        continue;
      if (
        matchedCenters &&
        (!s.costCenterId || !matchedCenters.has(s.costCenterId))
      )
        continue;
      total += s.amount;
      add(byMonth, s.month, s.amount);
      add(byCategory, head, s.amount);
      add(byCenter, s.costCenterId, s.amount);
    }

  const sorted = <K>(map: Map<K, bigint>) =>
    [...map.entries()].sort((a, b) =>
      a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1,
    );
  const rows =
    raw.groupBy === "month"
      ? months.map((month) => ({
          month,
          totalMicros: str(byMonth.get(month) ?? 0n),
        }))
      : raw.groupBy === "category"
        ? sorted(byCategory).map(([id, amount]) => ({
            id,
            name: id ? (categories.get(id)?.name ?? null) : null,
            totalMicros: str(amount),
          }))
        : sorted(byCenter).map(([id, amount]) => ({
            id,
            name: id ? (centers.get(id) ?? null) : null,
            totalMicros: str(amount),
          }));
  return {
    baseCurrency: settings.baseCurrency,
    kind: raw.kind,
    groupBy: raw.groupBy,
    from: range.from,
    to: range.to,
    totalMicros: str(total),
    rows,
    // What the filters matched, so the assistant can say what it counted.
    matched: matchedCategories
      ? [...categories.values()]
          .filter((c) =>
            headOf(categories, c.id, (id) => matchedCategories.has(id)),
          )
          .map((c) => c.name)
      : [],
    matchedCostCenters: matchedCenters
      ? [...matchedCenters].map((id) => centers.get(id)!)
      : [],
  };
}

export async function yearOverview(tx: DbTx, scope: Scope, year: number) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999)
    throw new DomainError("FINANCE_RANGE_INVALID", 422);
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const { settings } = await readFinanceSettings(tx, scope);
  const months = monthsBetween(range);
  const categories = await loadCategories(tx, scope);
  const centers = new Map(
    (
      await tx.financeCostCenter.findMany({
        where: { projectId: scope.projectId },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );

  const perCategory = new Map<string, Map<string, bigint>>();
  const byCenter = new Map<string | null, bigint>();
  for (const s of await lineSums(tx, scope, range)) {
    const head = s.categoryId ? headOf(categories, s.categoryId) : null;
    const key = `${s.type}:${head ?? ""}`;
    const perMonth = perCategory.get(key) ?? new Map<string, bigint>();
    add(perMonth, s.month, s.amount);
    perCategory.set(key, perMonth);
    if (s.type === "expense") add(byCenter, s.costCenterId, s.amount);
  }

  // Open items at 31 Dec of the year (see openItems for the void caveat);
  // open credits are listed apart from the open invoices.
  const items = await openItems(tx, scope, range.to);
  const openRow = ({ invoice, balance }: (typeof items)[number]) => ({
    invoiceId: invoice.id,
    number: invoice.number,
    direction: invoice.direction,
    counterpartyId: invoice.counterpartyId,
    currency: invoice.currency,
    issueDate: invoice.issueDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
    openMicros: str(balance.openAmountMicros),
    openBaseMicros: str(balance.openBaseMicros),
  });
  const open = items.filter((i) => !i.credit).map(openRow);
  const credits = items.filter((i) => i.credit);
  const creditsOpen = {
    count: credits.length,
    totalMicros: str(
      credits.reduce((sum, i) => sum + i.balance.openBaseMicros, 0n),
    ),
    items: credits.map(openRow),
  };

  const invoices = await tx.financeInvoice.findMany({
    where: {
      projectId: scope.projectId,
      status: { not: "void" },
      documentId: { not: null },
      issueDate: {
        gte: new Date(`${range.from}T00:00:00.000Z`),
        lte: new Date(`${range.to}T00:00:00.000Z`),
      },
    },
    orderBy: [{ issueDate: "asc" }, { number: "asc" }],
  });
  const booked = new Set(
    (
      await tx.financeDocument.findMany({
        where: {
          projectId: scope.projectId,
          status: "booked",
          id: { in: invoices.map((i) => i.documentId!) },
        },
        select: { id: true },
      })
    ).map((d) => d.id),
  );
  const rows = invoices.filter((i) => booked.has(i.documentId!));
  const names = new Map(
    (
      await tx.financeCounterparty.findMany({
        where: {
          projectId: scope.projectId,
          id: {
            in: rows.flatMap((i) =>
              i.counterpartyId ? [i.counterpartyId] : [],
            ),
          },
        },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );
  const entryNumbers = new Map(
    (
      await tx.financeJournalEntry.findMany({
        where: {
          projectId: scope.projectId,
          id: { in: rows.flatMap((i) => (i.entryId ? [i.entryId] : [])) },
        },
        select: { id: true, number: true },
      })
    ).map((e) => [e.id, e.number]),
  );
  // Base totals come from the posting: the open-item line carries the
  // invoice total in base (for a receipt, the payment account line).
  const baseTotals = new Map<string, bigint>();
  const entryIds = rows.flatMap((i) => (i.entryId ? [i.entryId] : []));
  if (entryIds.length) {
    const lines = await tx.financeJournalLine.findMany({
      where: {
        projectId: scope.projectId,
        entryId: { in: entryIds },
        categoryId: null,
      },
    });
    for (const i of rows) {
      const line = lines.find(
        (l) =>
          l.entryId === i.entryId &&
          l.currency === i.currency &&
          l.amountMicros === i.totalMicros,
      );
      if (line) baseTotals.set(i.id, line.baseAmountMicros);
    }
  }

  return {
    baseCurrency: settings.baseCurrency,
    year,
    months,
    categories: [...perCategory.entries()].map(([key, perMonth]) => {
      const [kind, id] = key.split(":") as ["income" | "expense", string];
      return {
        id: id || null,
        name: id ? (categories.get(id)?.name ?? null) : null,
        kind,
        months: months.map((month) => ({
          month,
          amountMicros: str(perMonth.get(month) ?? 0n),
        })),
        totalMicros: str([...perMonth.values()].reduce((a, b) => a + b, 0n)),
      };
    }),
    costCenters: [...byCenter.entries()].map(([id, amount]) => ({
      id,
      name: id ? (centers.get(id) ?? null) : null,
      expenseMicros: str(amount),
    })),
    open,
    creditsOpen,
    documents: rows.map((i) => ({
      id: i.documentId!,
      invoiceId: i.id,
      number: i.number,
      issueDate: i.issueDate.toISOString().slice(0, 10),
      counterparty: i.counterpartyId
        ? (names.get(i.counterpartyId) ?? null)
        : null,
      currency: i.currency,
      totalMicros: str(i.totalMicros),
      totalBaseMicros: baseTotals.has(i.id) ? str(baseTotals.get(i.id)!) : null,
      entryNumber: i.entryId ? (entryNumbers.get(i.entryId) ?? null) : null,
    })),
  };
}

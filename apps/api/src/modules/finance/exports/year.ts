import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { formatMicros } from "../money.ts";
import { yearOverview } from "../reports.ts";
import { csvFile, csvRow } from "./csv.ts";
import type { ExportPeriod, FinanceExporter } from "./exporter.ts";

/** The calendar year `from`..`to` spans exactly, or 422 EXPORT_PERIOD_INVALID. */
export function singleYear({ from, to }: ExportPeriod): number {
  const year = Number(from.slice(0, 4));
  if (from !== `${year}-01-01` || to !== `${year}-12-31`)
    throw new DomainError("EXPORT_PERIOD_INVALID", 422);
  return year;
}

/**
 * The tax advisor's year overview as one CSV of titled sections (category by
 * month, cost centers, open items at 31 December, booked documents), each
 * separated by a blank line. Amounts are in the base currency unless a
 * column says otherwise.
 */
async function buildYearOverview(tx: DbTx, scope: Scope, period: ExportPeriod) {
  const year = singleYear(period);
  const overview = await yearOverview(tx, scope, year);
  const base = overview.baseCurrency;
  const fmt = (micros: string) => formatMicros(BigInt(micros), base);
  const rows: string[] = [];
  let rowCount = 0;
  const section = (
    title: string,
    header: string[],
    body: (string | null)[][],
  ) => {
    if (rows.length) rows.push(csvRow([]));
    rows.push(csvRow([title]), csvRow(header));
    for (const row of body) rows.push(csvRow(row));
    rowCount += body.length;
  };

  section(
    "Category by month",
    ["kind", "category", ...overview.months, "total", "currency"],
    overview.categories.map((c) => [
      c.kind,
      c.name,
      ...c.months.map((m) => fmt(m.amountMicros)),
      fmt(c.totalMicros),
      base,
    ]),
  );
  section(
    "Cost centers",
    ["cost_center", "expense", "currency"],
    overview.costCenters.map((c) => [c.name, fmt(c.expenseMicros), base]),
  );

  const counterpartyIds = [
    ...new Set(
      overview.open.flatMap((o) =>
        o.counterpartyId ? [o.counterpartyId] : [],
      ),
    ),
  ];
  const names = new Map(
    (
      await tx.financeCounterparty.findMany({
        where: { projectId: scope.projectId, id: { in: counterpartyIds } },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );
  section(
    `Open items at ${year}-12-31`,
    [
      "direction",
      "number",
      "counterparty",
      "issue_date",
      "due_date",
      "currency",
      "open_amount",
      "base_currency",
      "open_base_amount",
    ],
    overview.open.map((o) => [
      o.direction,
      o.number,
      o.counterpartyId ? (names.get(o.counterpartyId) ?? null) : null,
      o.issueDate,
      o.dueDate,
      o.currency,
      formatMicros(BigInt(o.openMicros), o.currency),
      base,
      fmt(o.openBaseMicros),
    ]),
  );
  section(
    "Documents",
    [
      "issue_date",
      "number",
      "counterparty",
      "currency",
      "total",
      "base_currency",
      "base_total",
      "entry_number",
      "document_id",
    ],
    overview.documents.map((d) => [
      d.issueDate,
      d.number,
      d.counterparty,
      d.currency,
      formatMicros(BigInt(d.totalMicros), d.currency),
      base,
      d.totalBaseMicros === null ? null : fmt(d.totalBaseMicros),
      d.entryNumber,
      d.id,
    ]),
  );
  return {
    bytes: csvFile(rows),
    mime: "text/csv",
    name: `finance-year-overview_${year}.csv`,
    rowCount,
  };
}

export const yearOverviewExporter: FinanceExporter = {
  id: "year_overview",
  label: "Year overview (CSV)",
  build: buildYearOverview,
};

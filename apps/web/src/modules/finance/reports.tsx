"use client";
import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { useResource } from "@/lib/api";
import {
  Alert,
  Button,
  Empty,
  Input,
  Skeleton,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  financeApi,
  financePath,
  type FinanceExport,
  type YearOverview,
} from "./api";
import { useFinanceAccess } from "./access";
import { isDate } from "./amount";
import { micros as parseMicros, monthLabel } from "./charts";
import { paramsHref } from "./entries";
import { financeText, type FinanceText } from "./labels";
import { errorText, useLast, useMasterData } from "./lists";
import { formatMoney } from "./money";

// Reports (spec §9): the year overview for the tax advisor with a print
// layout, the three exports and the export history. The year lives in the
// URL (?year=). Exports need finance.export; the API stays authoritative.

export type ExportKind = "journal_csv" | "documents_zip" | "year_overview";
export const EXPORT_KINDS: readonly ExportKind[] = [
  "year_overview",
  "journal_csv",
  "documents_zip",
];

/** The selected year in the URL, or the current UTC year. */
export function yearOf(value: string | null, now: Date): number {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1970 && year <= 9999
    ? year
    : now.getUTCFullYear();
}

/** The years offered: the current one and the six before, plus the selected one. */
export function yearOptions(now: Date, selected: number): number[] {
  const current = now.getUTCFullYear();
  const years = Array.from({ length: 7 }, (_, i) => current - i);
  return years.includes(selected)
    ? years
    : [...years, selected].sort((a, b) => b - a);
}

/**
 * The period an export covers. A year overview is always January 1 to
 * December 31 of the selected year (the server accepts nothing else); the
 * journal and the documents use the custom period when it is given and
 * valid, otherwise the selected year.
 */
export function exportPeriod(
  kind: ExportKind,
  year: number,
  custom: { from: string; to: string } | null,
): { from: string; to: string } {
  const whole = { from: `${year}-01-01`, to: `${year}-12-31` };
  if (kind === "year_overview" || !custom) return whole;
  return custom;
}

/** True when a custom period is two real dates in order. */
export const customValid = (custom: { from: string; to: string }) =>
  isDate(custom.from) && isDate(custom.to) && custom.from <= custom.to;

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

const sum = (values: readonly string[]) =>
  values.reduce((total, v) => total + parseMicros(v), 0n);

function ExportSection({
  t,
  year,
  locale,
}: {
  t: FinanceText;
  year: number;
  locale: string;
}) {
  const r = t.reports;
  const { project } = useWorkspace();
  const finance = financeApi(project.id);
  const history = useResource<{ items: FinanceExport[] }>(
    financePath(project.id, "/exports"),
  );
  const items = useLast(history.data)?.items ?? null;
  const [custom, setCustom] = useState(false);
  const [range, setRange] = useState({
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<FinanceExport | null>(null);
  const lock = useRef(false);
  const customOk = !custom || customValid(range);

  async function run(kind: ExportKind) {
    if (lock.current) return;
    lock.current = true;
    setPending(kind);
    setError(null);
    setDone(null);
    try {
      const period = exportPeriod(kind, year, custom ? range : null);
      const created = await finance.exports.create({ kind, ...period });
      setDone(created);
      history.refresh();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      lock.current = false;
      setPending(null);
    }
  }
  const hint: Record<ExportKind, string> = {
    year_overview: r.yearOverviewHint,
    journal_csv: r.journalHint,
    documents_zip: r.documentsHint,
  };
  const label: Record<ExportKind, string> = {
    year_overview: r.yearOverview,
    journal_csv: r.journal,
    documents_zip: r.documents,
  };
  return (
    <section className="panel finance-noprint" aria-label={r.exportsTitle}>
      <div className="panel-head">
        <div>
          <h2>{r.exportsTitle}</h2>
          <p>{r.exportsIntro}</p>
        </div>
      </div>
      <div className="finance-body">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => setCustom(e.target.checked)}
          />
          {r.custom}
        </label>
        {custom && (
          <div className="finance-grid">
            <label>
              <span>{r.from}</span>
              <Input
                id="finance-export-from"
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              <span>{r.to}</span>
              <Input
                id="finance-export-to"
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
          </div>
        )}
        <ul className="settings-rows">
          {EXPORT_KINDS.map((kind) => {
            const period = exportPeriod(kind, year, custom ? range : null);
            return (
              <li key={kind} className="finance-link-row">
                <div>
                  <strong>{label[kind]}</strong>
                  <small className="field-hint">
                    {hint[kind]}{" "}
                    {fill(r.periodOf, { from: period.from, to: period.to })}
                  </small>
                </div>
                <Button
                  variant="outline"
                  data-export={kind}
                  disabled={
                    pending !== null || (kind !== "year_overview" && !customOk)
                  }
                  onClick={() => void run(kind)}
                >
                  <Download aria-hidden size={14} />
                  {pending === kind ? r.exporting : label[kind]}
                </Button>
              </li>
            );
          })}
        </ul>
        {error && <Alert kind="error">{error}</Alert>}
        {done && (
          <Alert kind="success">
            {r.exported}{" "}
            <a className="text-link" href={finance.exports.fileUrl(done.id)}>
              {r.download}
            </a>
          </Alert>
        )}
        <h3>{r.history}</h3>
        {items === null && history.error ? (
          <ResourceError error={history.error} retry={history.refresh} />
        ) : items === null ? (
          <Skeleton />
        ) : items.length === 0 ? (
          <p className="panel-note">{r.historyEmpty}</p>
        ) : (
          <div
            className="table-wrap"
            role="region"
            aria-label={r.history}
            tabIndex={0}
          >
            <table className="finance-table">
              <thead>
                <tr>
                  <th scope="col">{r.historyColumns.kind}</th>
                  <th scope="col">{r.historyColumns.period}</th>
                  <th scope="col" className="finance-num">
                    {r.historyColumns.rows}
                  </th>
                  <th scope="col">{r.historyColumns.created}</th>
                  <th scope="col">{r.historyColumns.file}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id}>
                    <th scope="row">{r.kinds[x.kind] ?? x.kind}</th>
                    <td>
                      {x.periodStart.slice(0, 10)} – {x.periodEnd.slice(0, 10)}
                    </td>
                    <td className="finance-num">{x.rowCount}</td>
                    <td>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: project.timezone,
                      }).format(new Date(x.createdAt))}
                    </td>
                    <td>
                      <a
                        className="text-link"
                        href={finance.exports.fileUrl(x.id)}
                      >
                        {r.download}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** The year overview tables (also what tests render with a fixed overview). */
export function YearTables({
  t,
  locale,
  overview,
  counterparties,
  fileUrl,
  word,
}: {
  t: FinanceText;
  locale: string;
  overview: YearOverview;
  counterparties: ReadonlyMap<string, string>;
  fileUrl: (documentId: string) => string;
  word: (key: "financeReportOther" | "financeReportUnassigned") => string;
}) {
  const r = t.reports;
  const base = overview.baseCurrency;
  const money = (value: string) => formatMoney(value, base, locale);
  const nameOf = (c: { id: string | null; name: string | null }) =>
    c.name ?? (c.id === null ? r.uncategorized : word("financeReportOther"));
  const kinds = ["income", "expense"] as const;
  const totals = (kind: "income" | "expense") =>
    sum(
      overview.categories
        .filter((c) => c.kind === kind)
        .map((c) => c.totalMicros),
    );
  return (
    <>
      <p className="panel-note">{fill(r.amountsIn, { base })}</p>
      {overview.categories.length === 0 && <Empty title={r.noData} />}
      {kinds.map((kind) => {
        const rows = overview.categories.filter((c) => c.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="panel" aria-label={r[kind]}>
            <div className="panel-head">
              <h2>
                {r[kind]} · {r.categoriesTitle}
              </h2>
            </div>
            <div className="finance-body">
              <div
                className="table-wrap"
                role="region"
                aria-label={r[kind]}
                tabIndex={0}
              >
                <table className="finance-table finance-year-table">
                  <thead>
                    <tr>
                      <th scope="col">{r.category}</th>
                      {overview.months.map((m) => (
                        <th key={m} scope="col" className="finance-num">
                          {monthLabel(m, locale)}
                        </th>
                      ))}
                      <th scope="col" className="finance-num">
                        {r.total}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={`${kind}:${c.id ?? "none"}`}>
                        <th scope="row">{nameOf(c)}</th>
                        {overview.months.map((m, i) => (
                          <td key={m} className="finance-num">
                            {money(c.months[i]?.amountMicros ?? "—")}
                          </td>
                        ))}
                        <td className="finance-num">{money(c.totalMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">
                        {kind === "income" ? r.totalIncome : r.totalExpense}
                      </th>
                      {overview.months.map((m, i) => (
                        <td key={m} className="finance-num">
                          {money(
                            String(
                              sum(
                                rows.map(
                                  (c) => c.months[i]?.amountMicros ?? "0",
                                ),
                              ),
                            ),
                          )}
                        </td>
                      ))}
                      <td className="finance-num">
                        {money(String(totals(kind)))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </section>
        );
      })}
      {overview.categories.length > 0 && (
        <p className="finance-allocation-sum">
          {r.result}: {money(String(totals("income") - totals("expense")))}
        </p>
      )}

      <section className="panel" aria-label={r.costCenters}>
        <div className="panel-head">
          <h2>{r.costCenters}</h2>
        </div>
        <div className="finance-body">
          {overview.costCenters.length === 0 ? (
            <p className="panel-note">{r.noData}</p>
          ) : (
            <div
              className="table-wrap"
              role="region"
              aria-label={r.costCenters}
              tabIndex={0}
            >
              <table className="finance-table">
                <thead>
                  <tr>
                    <th scope="col">{r.costCenter}</th>
                    <th scope="col" className="finance-num">
                      {r.expense}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.costCenters.map((c) => (
                    <tr key={c.id ?? "none"}>
                      <th scope="row">
                        {c.name ??
                          (c.id === null
                            ? word("financeReportUnassigned")
                            : word("financeReportOther"))}
                      </th>
                      <td className="finance-num">{money(c.expenseMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel" aria-label={r.openTitle}>
        <div className="panel-head">
          <h2>{r.openTitle}</h2>
        </div>
        <div className="finance-body">
          {overview.open.length === 0 ? (
            <p className="panel-note">{r.noOpen}</p>
          ) : (
            <div
              className="table-wrap"
              role="region"
              aria-label={r.openTitle}
              tabIndex={0}
            >
              <table className="finance-table">
                <thead>
                  <tr>
                    <th scope="col">{r.openColumns.number}</th>
                    <th scope="col">{r.openColumns.counterparty}</th>
                    <th scope="col">{r.openColumns.direction}</th>
                    <th scope="col">{r.openColumns.due}</th>
                    <th scope="col" className="finance-num">
                      {r.openColumns.open}
                    </th>
                    <th scope="col" className="finance-num">
                      {fill(r.openColumns.openBase, { base })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.open.map((o) => (
                    <tr key={o.invoiceId}>
                      <th scope="row">{o.number ?? "—"}</th>
                      <td>
                        {o.counterpartyId
                          ? (counterparties.get(o.counterpartyId) ?? "—")
                          : "—"}
                      </td>
                      <td>
                        {t.invoices.directions[o.direction] ?? o.direction}
                      </td>
                      <td>{o.dueDate ?? "—"}</td>
                      <td className="finance-num">
                        {formatMoney(o.openMicros, o.currency, locale)}
                      </td>
                      <td className="finance-num">{money(o.openBaseMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel" aria-label={r.documentsTitle}>
        <div className="panel-head">
          <h2>{r.documentsTitle}</h2>
        </div>
        <div className="finance-body">
          {overview.documents.length === 0 ? (
            <p className="panel-note">{r.noDocuments}</p>
          ) : (
            <div
              className="table-wrap"
              role="region"
              aria-label={r.documentsTitle}
              tabIndex={0}
            >
              <table className="finance-table">
                <thead>
                  <tr>
                    <th scope="col">{r.documentColumns.number}</th>
                    <th scope="col">{r.documentColumns.date}</th>
                    <th scope="col">{r.documentColumns.counterparty}</th>
                    <th scope="col" className="finance-num">
                      {r.documentColumns.total}
                    </th>
                    <th scope="col" className="finance-num">
                      {fill(r.documentColumns.base, { base })}
                    </th>
                    <th scope="col">{r.documentColumns.entry}</th>
                    <th scope="col" className="finance-noprint">
                      {r.documentColumns.file}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.documents.map((d) => (
                    <tr key={d.invoiceId}>
                      <th scope="row">{d.number ?? "—"}</th>
                      <td>{d.issueDate}</td>
                      <td>{d.counterparty ?? "—"}</td>
                      <td className="finance-num">
                        {formatMoney(d.totalMicros, d.currency, locale)}
                      </td>
                      <td className="finance-num">
                        {d.totalBaseMicros === null
                          ? "—"
                          : money(d.totalBaseMicros)}
                      </td>
                      <td>{d.entryNumber ?? "—"}</td>
                      <td className="finance-noprint">
                        <a className="text-link" href={fileUrl(d.id)}>
                          {r.original}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export function FinanceReports() {
  const { project, locale, t: word } = useWorkspace();
  const t = financeText(locale);
  const r = t.reports;
  const { canExport } = useFinanceAccess();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const now = new Date();
  const year = yearOf(params?.get("year") ?? null, now);
  const master = useMasterData(project.id);
  const overview = useResource<YearOverview>(
    financePath(project.id, `/reports/year?year=${year}`),
  );
  const shown = useLast(overview.data);
  const finance = financeApi(project.id);
  const names = new Map(master.counterparties.map((c) => [c.id, c.name]));
  return (
    <>
      <PageHead
        title={r.title}
        description={r.intro}
        eyebrow={word("moduleEyebrow")}
      >
        <div className="finance-period finance-noprint">
          <label htmlFor="finance-reports-year">{r.year}</label>
          <select
            id="finance-reports-year"
            className="input"
            value={year}
            onChange={(e) =>
              router.replace(
                paramsHref(pathname, params, {
                  year:
                    Number(e.target.value) === now.getUTCFullYear()
                      ? null
                      : e.target.value,
                }),
              )
            }
          >
            {yearOptions(now, year).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer aria-hidden size={14} />
            {r.print}
          </Button>
        </div>
      </PageHead>
      {canExport ? (
        <ExportSection t={t} year={year} locale={locale} />
      ) : (
        <p className="panel-note finance-noprint">{t.manage.exportOnly}</p>
      )}
      {shown === null && overview.error ? (
        <ResourceError error={overview.error} retry={overview.refresh} />
      ) : shown === null ? (
        <Skeleton />
      ) : (
        <YearTables
          t={t}
          locale={locale}
          overview={shown}
          counterparties={names}
          fileUrl={(id) => finance.documents.fileUrl(id)}
          word={(key) => word(key)}
        />
      )}
    </>
  );
}

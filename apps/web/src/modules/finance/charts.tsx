"use client";
import { labels } from "@/lib/i18n";
import { useWorkspace } from "@/components/workspace-context";
import { financeText } from "./labels";
import { formatMoney } from "./money";

// Small accessible SVG charts for the finance dashboard (spec §9). No chart
// library. Amounts arrive as decimal strings of micros and are scaled with
// bigint math only: a value of 1e15 next to 1e9 must keep its proportion, so
// nothing is parsed to a float before it is divided.

const WHOLE = /^-?\d+$/;
/** An amount string as bigint; anything unparsable counts as 0. */
export const micros = (value: string): bigint =>
  WHOLE.test(value) ? BigInt(value) : 0n;

/** `value / max` on an integer scale of 0 to 1000 (absolute value, clamped). */
export function permille(value: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  const abs = value < 0n ? -value : value;
  const scaled = (abs * 1000n) / max;
  return Number(scaled > 1000n ? 1000n : scaled);
}

/** "Oct 2026" for a `YYYY-MM` month, in the viewer's locale. */
export function monthLabel(month: string, locale: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

export type MonthlyPoint = {
  month: string;
  incomeMicros: string;
  expenseMicros: string;
  resultMicros: string;
};

const SLOT = 44;
const PLOT_TOP = 8;
const PLOT_HEIGHT = 160;
const AXIS_HEIGHT = 24;

/**
 * Income and expense bars per month and the result as a line with dots.
 * Bars grow from a zero baseline; a negative result sits below it. A month
 * without bookings keeps its slot with a bar of height 0 and its label.
 */
export function MonthlyBars({
  months,
  currency,
}: {
  months: MonthlyPoint[];
  currency: string;
}) {
  const { locale } = useWorkspace();
  const t = financeText(locale).dashboard;
  const rows = months.map((m) => ({
    month: m.month,
    income: micros(m.incomeMicros),
    expense: micros(m.expenseMicros),
    result: micros(m.resultMicros),
  }));
  let top = 0n;
  let bottom = 0n;
  for (const r of rows)
    for (const v of [r.income, r.expense, r.result]) {
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  const range = top - bottom;
  // Vertical position of a value on the plot, from the 0..1000 scale of the
  // distance to the top of the range.
  const y = (value: bigint) =>
    range === 0n
      ? PLOT_TOP + PLOT_HEIGHT
      : PLOT_TOP + (Number(((top - value) * 1000n) / range) * PLOT_HEIGHT) / 1000;
  const zero = y(0n);
  const width = Math.max(rows.length, 1) * SLOT;
  const sum = (pick: (r: (typeof rows)[number]) => bigint) =>
    String(rows.reduce((total, r) => total + pick(r), 0n));
  const summary = t.monthlyLabel
    .replace("{n}", String(rows.length))
    .replace("{income}", formatMoney(sum((r) => r.income), currency, locale))
    .replace("{expense}", formatMoney(sum((r) => r.expense), currency, locale))
    .replace("{result}", formatMoney(sum((r) => r.result), currency, locale));
  const dots = rows.map((r, i) => ({ x: i * SLOT + SLOT / 2, y: y(r.result) }));
  return (
    <div className="finance-chart">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${PLOT_TOP + PLOT_HEIGHT + AXIS_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <line
          x1={0}
          x2={width}
          y1={zero}
          y2={zero}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {rows.map((r, i) => {
          const x = i * SLOT;
          const bar = (value: bigint, offset: number, fill: string) => {
            const edge = y(value);
            return (
              <rect
                data-bar
                x={x + offset}
                y={Math.min(edge, zero)}
                width={14}
                height={Math.abs(zero - edge)}
                rx={2}
                fill={fill}
              />
            );
          };
          return (
            <g key={r.month}>
              {bar(r.income, 6, "var(--success)")}
              {bar(r.expense, 24, "var(--danger)")}
              <text
                x={x + SLOT / 2}
                y={PLOT_TOP + PLOT_HEIGHT + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted-foreground)"
              >
                {monthLabel(r.month, locale)}
              </text>
            </g>
          );
        })}
        {dots.length > 1 && (
          <polyline
            points={dots.map((d) => `${d.x},${d.y}`).join(" ")}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
          />
        )}
        {dots.map((d, i) => (
          <circle
            key={rows[i]!.month}
            cx={d.x}
            cy={d.y}
            r={3}
            fill="var(--primary)"
          />
        ))}
      </svg>
      <div className="finance-chart-legend" aria-hidden>
        <span data-series="income">{t.income}</span>
        <span data-series="expense">{t.expense}</span>
        <span data-series="result">{t.result}</span>
      </div>
      <table className="sr-only">
        <caption>{t.monthly}</caption>
        <thead>
          <tr>
            <th scope="col">{t.month}</th>
            <th scope="col">{t.income}</th>
            <th scope="col">{t.expense}</th>
            <th scope="col">{t.result}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row">{monthLabel(r.month, locale)}</th>
              <td>{formatMoney(String(r.income), currency, locale)}</td>
              <td>{formatMoney(String(r.expense), currency, locale)}</td>
              <td>{formatMoney(String(r.result), currency, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type RankedRow = {
  id: string | null;
  name: string | null;
  valueMicros: string;
};

/** Rows shown before the rest is folded into "Other". */
export const RANKED_LIMIT = 8;

/**
 * Horizontal bars, largest first: at most eight rows, the rest folded into
 * one "Other" row. A row without a name reads `fallback` ("Unassigned" or
 * "Other"); a folded row always reads "Other".
 */
export function RankedBars({
  rows,
  currency,
  fallback,
  caption,
}: {
  rows: RankedRow[];
  currency: string;
  fallback: string;
  caption: string;
}) {
  const { locale } = useWorkspace();
  const t = financeText(locale).dashboard;
  const other = labels[locale].financeReportOther;
  const sorted = rows
    .map((r) => ({ ...r, value: micros(r.valueMicros) }))
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  const shown = sorted.slice(0, RANKED_LIMIT).map((r) => ({
    key: r.id ?? "none",
    label: r.name ?? fallback,
    value: r.value,
  }));
  const rest = sorted.slice(RANKED_LIMIT);
  if (rest.length)
    shown.push({
      key: "folded",
      label: other,
      value: rest.reduce((total, r) => total + r.value, 0n),
    });
  const max = shown.reduce((m, r) => (r.value > m ? r.value : m), 0n);
  const money = (v: bigint) => formatMoney(String(v), currency, locale);
  const summary = t.costCentersLabel
    .replace("{n}", String(shown.length))
    .replace(
      "{top}",
      shown[0] ? `${shown[0].label} ${money(shown[0].value)}` : "—",
    );
  return (
    <div className="finance-chart">
      <ul className="finance-ranked" role="img" aria-label={summary}>
        {shown.map((r) => (
          <li key={r.key}>
            <span className="finance-ranked-name">{r.label}</span>
            <svg viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden>
              <rect x={0} y={0} width={1000} height={12} rx={4} fill="var(--muted)" />
              <rect
                data-bar
                x={0}
                y={0}
                width={permille(r.value, max)}
                height={12}
                rx={4}
                fill="var(--primary)"
              />
            </svg>
            <span className="finance-ranked-amount">{money(r.value)}</span>
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{caption}</th>
            <th scope="col">{t.amount}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{money(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 28;

/** A trend line over `points`, scaled to its own largest value. */
export function Sparkline({
  points,
  label,
  currency,
}: {
  points: Array<{ month: string; valueMicros: string }>;
  label: string;
  currency: string;
}) {
  const { locale } = useWorkspace();
  const t = financeText(locale).dashboard;
  const values = points.map((p) => micros(p.valueMicros));
  const max = values.reduce((m, v) => (v > m ? v : m), 0n);
  const step = points.length > 1 ? SPARK_WIDTH / (points.length - 1) : 0;
  const coords = values.map((v, i) => ({
    x: points.length > 1 ? i * step : SPARK_WIDTH / 2,
    y: SPARK_HEIGHT - 2 - (permille(v, max) * (SPARK_HEIGHT - 4)) / 1000,
  }));
  return (
    <div className="finance-spark">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
      >
        {coords.length > 1 && (
          <polyline
            points={coords.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t.month}</th>
            <th scope="col">{t.amount}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <th scope="row">{monthLabel(p.month, locale)}</th>
              <td>{formatMoney(p.valueMicros, currency, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

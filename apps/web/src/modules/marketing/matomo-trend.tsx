"use client";

import { useId, useState } from "react";
import { googleSearchReport, matomoReportLabel } from "./matomo-reports";
import styles from "./matomo-trend.module.css";

const metrics = {
  sessions: ["Visits", "Besuche"],
  pageviews: ["Page views", "Seitenaufrufe"],
  outlinkClicks: ["Outbound link clicks", "Klicks auf externe Links"],
  impressions: ["Google Search impressions", "Google-Suchimpressionen"],
  clicks: ["Google Search clicks", "Google-Suchklicks"],
} as const;
type Metric = keyof typeof metrics;
type Measurement = Partial<
  Record<
    | Metric
    | "accountId"
    | "siteId"
    | "date"
    | "timezone"
    | "currency"
    | "reportMethod",
    unknown
  >
>;
export type MatomoTrendData = { items: Measurement[]; truncated: boolean };
const reportMetrics: ReadonlyMap<string, readonly Metric[]> = new Map([
  ["VisitsSummary.get", ["sessions"]],
  ["Actions.get", ["pageviews", "outlinkClicks"]],
  [googleSearchReport, ["impressions", "clicks"]],
]);

type Series = {
  key: string;
  method: string;
  siteId: number;
  timezone: string;
  metrics: readonly Metric[];
  byDay: Map<string, Measurement | null>;
};

function reportSeries(items: Measurement[]) {
  const groups = new Map<string, Series>();
  for (const data of items) {
    const { reportMethod, accountId, siteId, date, timezone, currency } = data;
    const fields =
      typeof reportMethod === "string"
        ? reportMetrics.get(reportMethod)
        : undefined;
    if (
      !fields ||
      typeof reportMethod !== "string" ||
      typeof accountId !== "string" ||
      typeof siteId !== "number" ||
      typeof timezone !== "string" ||
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      continue;
    const key = JSON.stringify([accountId, timezone, currency]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        method: reportMethod,
        siteId,
        timezone,
        metrics: fields,
        byDay: new Map(),
      };
      groups.set(key, group);
    }
    // A duplicate date is ambiguous within one reporting dimension.
    group.byDay.set(date, group.byDay.has(date) ? null : data);
  }
  return [...groups.values()].sort((a, b) => {
    const methods = [...reportMetrics.keys()];
    return (
      methods.indexOf(a.method) - methods.indexOf(b.method) ||
      a.siteId - b.siteId
    );
  });
}

const TREND_DAYS = 30;
function dailyValues(series: Series, metric: Metric) {
  const last = [...series.byDay.keys()].sort().at(-1)!;
  return Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(
      Date.parse(last) - (TREND_DAYS - 1 - index) * 86_400_000,
    );
    const day = date.toISOString().slice(0, 10);
    const value = series.byDay.get(day)?.[metric];
    return {
      day,
      date,
      value:
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? value
          : null,
    };
  });
}

export function MatomoTrend({
  data,
  locale,
}: {
  data: MatomoTrendData;
  locale: string;
}) {
  const title = useId();
  const [reportKey, setReportKey] = useState("");
  const [metricKey, setMetricKey] = useState<Metric>("sessions");
  const de = locale === "de";
  const series = reportSeries(data.items);
  const selected = series.find((group) => group.key === reportKey) ?? series[0];
  const metric = selected?.metrics.includes(metricKey)
    ? metricKey
    : selected?.metrics[0];
  const points = selected && metric ? dailyValues(selected, metric) : [];
  const observed = points.filter(({ value }) => value !== null);
  const max = Math.max(0, ...observed.map(({ value }) => value ?? 0));
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  const longDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const metricLabel = (field: Metric) => metrics[field][de ? 1 : 0];

  return (
    <section className={`panel ${styles.panel}`} aria-labelledby={title}>
      <div>
        <h2 id={title}>
          {de ? "Matomo · Tagesverlauf" : "Matomo · Daily trend"}
        </h2>
        <p className={styles.note}>
          {de
            ? "Matomo erfasst Website-Besuche und Aktionen. Google-Suchimpressionen und Suchklicks stammen aus der verbundenen Search Console. Für Anzeigen und Social-Posts gelten die Zahlen der jeweiligen Plattform."
            : "Matomo records website visits and actions. Google Search impressions and clicks come from the connected Search Console. Ads and social posts use metrics from their respective platforms."}
        </p>
      </div>
      {data.truncated && (
        <p className={styles.note}>
          {de
            ? "Angezeigt werden bis zu 500 zuletzt importierte Matomo-Tagesmessungen."
            : "The chart uses up to 500 of the most recently imported daily Matomo measurements."}
        </p>
      )}
      {selected && metric ? (
        <>
          <div className={styles.controls}>
            <label>
              {de ? "Bericht" : "Report"}
              <select
                className="input"
                value={selected.key}
                onChange={(event) => setReportKey(event.target.value)}
              >
                {series.map((group) => (
                  <option key={group.key} value={group.key}>
                    {matomoReportLabel(group.method, de)} ·{" "}
                    {de ? "Website" : "Site"} {group.siteId} · {group.timezone}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {de ? "Kennzahl" : "Metric"}
              <select
                className="input"
                value={metric}
                onChange={(event) => setMetricKey(event.target.value as Metric)}
              >
                {selected.metrics.map((field) => (
                  <option key={field} value={field}>
                    {metricLabel(field)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.note}>
            {longDate.format(points[0]!.date)} –{" "}
            {longDate.format(points.at(-1)!.date)} ·{" "}
            {de
              ? `${observed.length} von ${TREND_DAYS} Tagen mit Messwerten`
              : `${observed.length} of ${TREND_DAYS} days with measurements`}
          </p>
          {selected.method === googleSearchReport && (
            <p className={styles.note}>
              {de
                ? "Die Suchwerte umfassen die von Matomo gelieferten Keyword-Zeilen und können unvollständig sein."
                : "Search metrics cover the keyword rows returned by Matomo and may be incomplete."}
            </p>
          )}
          {observed.length > 0 ? (
            <>
              <div className={styles.chart} aria-hidden="true">
                <div className={styles.scale}>
                  {max > 0 && <span>{number.format(max)}</span>}
                  <span>0</span>
                </div>
                <div className={styles.bars}>
                  {points.map((point) => (
                    <div className={styles.slot} key={point.day}>
                      {point.value !== null && (
                        <span
                          className={styles.bar}
                          data-zero={point.value === 0 ? "" : undefined}
                          style={{
                            height: max ? `${(point.value / max) * 100}%` : 0,
                          }}
                          title={`${longDate.format(point.date)} · ${number.format(point.value)}`}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className={styles.dates}>
                  {[points[0]!, points[14]!, points.at(-1)!].map((point) => (
                    <span key={point.day}>{date.format(point.date)}</span>
                  ))}
                </div>
              </div>
              <p className={styles.note}>
                {de
                  ? "Lücken markieren Tage ohne Messwert. Ein Strich auf der Nulllinie steht für eine gemessene 0."
                  : "Gaps mark days without measurements. A mark on the baseline represents a measured zero."}
              </p>
              <details>
                <summary>
                  {de ? "Tageswerte anzeigen" : "Show daily values"}
                </summary>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{de ? "Datum" : "Date"}</th>
                      <th scope="col">{metricLabel(metric)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.day}>
                        <th scope="row">{longDate.format(point.date)}</th>
                        <td>
                          {point.value === null
                            ? de
                              ? "Fehlt"
                              : "Missing"
                            : number.format(point.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          ) : (
            <p>
              {de
                ? "Für diese Kennzahl liegen im Zeitraum keine Werte vor."
                : "No values are available for this metric in this period."}
            </p>
          )}
        </>
      ) : (
        <p>
          {de
            ? "Noch keine Matomo-Tageswerte für das Diagramm vorhanden."
            : "No daily Matomo measurements are available for the chart yet."}
        </p>
      )}
    </section>
  );
}

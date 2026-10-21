import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";
export const METRIC_COUNTERS = [
  "sessions",
  "pageviews",
  "clicks",
  "impressions",
  "conversions",
  "costMicros",
] as const;
/** Serialize snapshots, imports and corrections for one project, never across tenants. */
export async function lockMetrics(tx: DbTx, scope: Scope) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.projectId + ":marketing-metrics"}, 0))::text`;
}
type Row = { id: string; version: number; data: unknown; updatedAt: Date };
/** Different report/account/source/currency/zone denominators stay separate. */
export function summarizeMetrics(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const d = data(row);
    const key = JSON.stringify([
      d.source ?? "unknown",
      d.accountId ?? null,
      d.reportFamily ?? d.reportMethod ?? null,
      d.currency ?? null,
      d.timezone ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((items) => {
      const first = data(items[0]!);
      const periods = items
        .map((r) => ({
          start: Date.parse(data(r).periodStart),
          end: Date.parse(data(r).periodEnd),
          campaign: String(data(r).campaign ?? ""),
        }))
        .sort((a, b) => a.start - b.start);
      // Separate campaign rows within the same report may partition a day. Repeated
      // intervals of the same campaign cannot safely be added (including cumulative snapshots).
      const overlap = periods.some((p, i) =>
        periods
          .slice(0, i)
          .some(
            (q) =>
              q.campaign === p.campaign && p.start < q.end && q.start < p.end,
          ),
      );
      let numericIssue = false;
      const totals = Object.fromEntries(
        METRIC_COUNTERS.map((k) => {
          const values = items.map((r) => data(r)[k]);
          if (overlap || values.some((v) => v === null || v === undefined))
            return [k, null];
          const total = values.reduce((sum, value) => sum + Number(value), 0);
          if (
            values.some((v) => !Number.isSafeInteger(v) || v < 0) ||
            !Number.isSafeInteger(total)
          ) {
            numericIssue = true;
            return [k, null];
          }
          return [k, total];
        }),
      ) as Record<(typeof METRIC_COUNTERS)[number], number | null>;
      const labels = [
        ...new Set(
          items
            .map((r) => data(r).campaign)
            .filter((s): s is string => typeof s === "string"),
        ),
      ];
      return {
        source: String(first.source ?? "unknown"),
        accountId: first.accountId ?? null,
        report: String(first.reportFamily ?? first.reportMethod ?? ""),
        currency: first.currency ?? null,
        timezone: first.timezone ?? null,
        label: labels.length === 1 ? labels[0]! : null,
        labels: labels.slice(0, 20),
        days: new Set(
          items.map((r) => String(data(r).periodStart).slice(0, 10)),
        ).size,
        ...totals,
        noData: Object.values(totals).every((v) => v === null),
        overlap,
        freshness: items
          .map((r) =>
            String(data(r).providerFetchedAt ?? r.updatedAt.toISOString()),
          )
          .sort()
          .at(-1)!,
        complete:
          !overlap &&
          !numericIssue &&
          items.every((r) => data(r).complete !== false),
        metricRefs: items.map((r) => ({ id: r.id, version: r.version })),
      };
    })
    .sort(
      (a, b) =>
        Number(b.sessions ?? b.clicks ?? 0) -
        Number(a.sessions ?? a.clicks ?? 0),
    );
}

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { issueView } from "./issues.ts";
import { OPEN_STATUSES, TRIAGE_STATUSES } from "./status.ts";

// The issue center's dashboard (plan §2.9): counts, lists, breakdowns and
// lead times from stored rows only. A metric without data is null, which
// the web shows as "—"; nothing is estimated.

const DAY = 86_400_000;

type LeadRow = {
  new_confirmed: number | null;
  confirmed_fix_ready: number | null;
  fix_ready_released: number | null;
  new_released: number | null;
};

/** Median hours between first reaching statuses, for moves in the last 90 days. */
async function leadTimes(tx: DbTx, scope: Scope) {
  const [row] = await tx.$queryRaw<LeadRow[]>`
    WITH firsts AS (
      SELECT i.id, i."createdAt" AS created,
        min(e."createdAt") FILTER (WHERE e.after->>'status' = 'confirmed') AS confirmed,
        min(e."createdAt") FILTER (WHERE e.after->>'status' = 'fix_ready') AS fix_ready,
        min(e."createdAt") FILTER (WHERE e.after->>'status' = 'released') AS released
      FROM "Issue" i
      JOIN "IssueEvent" e ON e."projectId" = i."projectId" AND e."issueId" = i.id AND e.type = 'status'
      WHERE i."projectId" = ${scope.projectId}::uuid
      GROUP BY i.id, i."createdAt"
    ), since AS (SELECT now() - interval '90 days' AS t)
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM confirmed - created) / 3600)
        FILTER (WHERE confirmed >= (SELECT t FROM since)) AS new_confirmed,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fix_ready - confirmed) / 3600)
        FILTER (WHERE fix_ready >= (SELECT t FROM since) AND confirmed IS NOT NULL AND fix_ready >= confirmed) AS confirmed_fix_ready,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released - fix_ready) / 3600)
        FILTER (WHERE released >= (SELECT t FROM since) AND fix_ready IS NOT NULL AND released >= fix_ready) AS fix_ready_released,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released - created) / 3600)
        FILTER (WHERE released >= (SELECT t FROM since)) AS new_released
    FROM firsts`;
  const hours = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  return {
    newToConfirmed: hours(row?.new_confirmed),
    confirmedToFixReady: hours(row?.confirmed_fix_ready),
    fixReadyToReleased: hours(row?.fix_ready_released),
    newToReleased: hours(row?.new_released),
  };
}

export async function issuesOverview(tx: DbTx, scope: Scope) {
  const now = Date.now();
  const p = scope.projectId;
  const open = { projectId: p, status: { in: [...OPEN_STATUSES] } };
  const [
    openCount,
    critical,
    newWeek,
    awaitingTriage,
    fixReady,
    released,
    criticalList,
    mostReported,
    pendingDuplicates,
    byStatus,
    byComponent,
    bySource,
    ages,
    lead,
  ] = await Promise.all([
    tx.issue.count({ where: open }),
    tx.issue.count({ where: { ...open, severity: "s1_critical" } }),
    tx.issue.count({ where: { projectId: p, status: { not: "duplicate" }, createdAt: { gte: new Date(now - 7 * DAY) } } }),
    tx.issue.count({ where: { projectId: p, status: { in: [...TRIAGE_STATUSES] } } }),
    tx.issue.count({ where: { projectId: p, status: "fix_ready" } }),
    tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT "issueId") AS n FROM "IssueEvent"
      WHERE "projectId" = ${p}::uuid AND type = 'status' AND after->>'status' = 'released'
        AND "createdAt" >= now() - interval '30 days'`,
    tx.issue.findMany({ where: { ...open, severity: "s1_critical" }, orderBy: { lastSeenAt: "desc" }, take: 10 }),
    tx.issue.findMany({ where: { ...open, reportCount: { gt: 1 } }, orderBy: [{ reportCount: "desc" }, { lastSeenAt: "desc" }], take: 10 }),
    tx.issueDuplicateCandidate.count({ where: { projectId: p, status: "pending" } }),
    tx.issue.groupBy({ by: ["status"], where: { projectId: p }, _count: { _all: true } }),
    tx.$queryRaw<{ component: string; n: bigint }[]>`
      SELECT c AS component, count(*) AS n FROM "Issue", unnest(components) AS c
      WHERE "projectId" = ${p}::uuid AND status = ANY(${[...OPEN_STATUSES]}::text[])
      GROUP BY c ORDER BY n DESC LIMIT 20`,
    tx.issueReport.groupBy({
      by: ["sourceKind"],
      where: { projectId: p, receivedAt: { gte: new Date(now - 90 * DAY) } },
      _count: { _all: true },
    }),
    tx.$queryRaw<{ bucket: string; n: bigint }[]>`
      SELECT CASE WHEN "createdAt" >= now() - interval '7 days' THEN 'under_7d'
                  WHEN "createdAt" >= now() - interval '30 days' THEN 'under_30d'
                  ELSE 'over_30d' END AS bucket, count(*) AS n
      FROM "Issue" WHERE "projectId" = ${p}::uuid AND status = ANY(${[...OPEN_STATUSES]}::text[])
      GROUP BY bucket`,
    leadTimes(tx, scope),
  ]);
  const ageBuckets = { under_7d: 0, under_30d: 0, over_30d: 0 };
  for (const a of ages) ageBuckets[a.bucket as keyof typeof ageBuckets] = Number(a.n);
  return {
    metrics: {
      open: openCount,
      critical,
      newLast7Days: newWeek,
      awaitingTriage,
      fixReadyNotReleased: fixReady,
      releasedLast30Days: Number(released[0]?.n ?? 0),
      duplicatesPending: pendingDuplicates,
    },
    critical: criticalList.map(issueView),
    mostReported: mostReported.map(issueView),
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    byComponent: byComponent.map((c) => ({ component: c.component, open: Number(c.n) })),
    bySource: Object.fromEntries(bySource.map((s) => [s.sourceKind, s._count._all])),
    openAge: ageBuckets,
    leadTimesHours: lead,
  };
}

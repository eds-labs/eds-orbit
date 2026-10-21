import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError } from "../../../shared.ts";
import { localDate } from "../agents/scheduling.ts";
import { matomoDayInterval } from "./matomo.ts";
import { persistReport, REPORT_KIND } from "./reports.ts";
const DAY = 86400000;
/** A closed local Monday–Sunday period; calendar math is independent of DST. */
export function reportWeek(now: Date, zone: string) {
  const today = Date.parse(localDate(now, zone) + "T00:00:00Z");
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const day = (n: number) => new Date(n).toISOString().slice(0, 10);
  return {
    from: day(monday - 7 * DAY),
    to: day(monday - DAY),
    nextAt: new Date(
      matomoDayInterval(day(monday + 7 * DAY), zone).periodStart,
    ),
  };
}
export async function reportPlans(tx: DbTx, scope: Scope) {
  return tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "marketing_plans",
      data: { path: ["status"], equals: "active" },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}
export async function scheduleReports(tx: DbTx, scope: Scope, now: Date) {
  for (const plan of await reportPlans(tx, scope)) {
    const { from, to } = reportWeek(now, data(plan).spec.timezone);
    try {
      await persistReport(tx, scope, { planId: plan.id, from, to }, now);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== "REPORT_PERIOD_OUTSIDE_PLAN"
      )
        throw error;
    }
  }
  const stale = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: REPORT_KIND,
      data: { path: ["status"], equals: "invalidated" },
    },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  for (const row of stale) {
    const d = data(row);
    try {
      await persistReport(
        tx,
        scope,
        { planId: d.planId, from: d.period.from, to: d.period.to },
        now,
      );
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        ![
          "REPORT_PERIOD_OUTSIDE_PLAN",
          "REPORT_CLOSED_PERIOD_REQUIRED",
        ].includes(error.code)
      )
        throw error;
    }
  }
}

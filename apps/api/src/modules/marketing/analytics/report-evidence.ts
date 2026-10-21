import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, hash } from "../../../shared.ts";
/** Guard approval/receipt even if newly imported rows have not reached the sweep. */
export async function reportEvidenceCurrent(
  tx: DbTx,
  scope: Scope,
  report: Record<string, any>,
) {
  if (report.status !== "ready") return false;
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "metrics",
      AND: [
        {
          data: { path: ["periodStart"], gte: report.effectivePeriod.startAt },
        },
        { data: { path: ["periodStart"], lt: report.effectivePeriod.endAt } },
      ],
    },
    orderBy: { id: "asc" },
    take: 1001,
  });
  if (rows.length > 1000) return false;
  const refs = rows
    .filter(
      (m) =>
        Date.parse(data(m).periodEnd) <=
          Date.parse(report.effectivePeriod.endAt) &&
        Date.parse(data(m).periodEnd) > Date.parse(data(m).periodStart),
    )
    .map((m) => ({ id: m.id, version: m.version }));
  return hash(refs) === hash(report.metricRefs);
}

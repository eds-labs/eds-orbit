import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  update,
  entity,
  list,
  data,
  hash,
  DomainError,
  audit,
} from "../shared.ts";

export async function correctMetric(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  values: Record<string, unknown>,
  reason: string,
) {
  const row = await entity(tx, scope, "metrics", id);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const corrected = await update(tx, scope, row, {
    ...data(row),
    ...values,
    correctionReason: reason,
    correctedBy: scope.userId,
  });
  for (const insight of await list(tx, scope, "insights"))
    if ((data(insight).metricIds ?? []).includes(id))
      await update(tx, scope, insight, {
        ...data(insight),
        status: "invalidated",
        reason: "METRICS_CORRECTED",
        requiresReanalysis: true,
      });
  await audit(tx, scope, "metric.correct", id, { version, reason });
  return corrected;
}
export async function memoryLifecycle(
  tx: DbTx,
  scope: Scope,
  kind: "preferences" | "insights",
  id: string,
  version: number,
  operation: "disable" | "delete",
) {
  const row = await entity(tx, scope, kind, id);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (operation === "disable")
    return update(tx, scope, row, {
      ...data(row),
      status: "disabled",
      disabledBy: scope.userId,
    });
  // Purge previous content too; the audit retains only identifiers, never removed text.
  await tx.entityVersion.deleteMany({
    where: { projectId: scope.projectId, entityId: id },
  });
  const deleted = await update(tx, scope, row, {
    status: "deleted",
    deletedAt: new Date().toISOString(),
    deletedBy: scope.userId,
  });
  await audit(tx, scope, "memory.delete", id, { kind });
  return deleted;
}
export async function evaluateExperiment(
  tx: DbTx,
  scope: Scope,
  id: string,
  at = new Date(),
) {
  const experiment = await entity(tx, scope, "experiments", id),
    e = data(experiment);
  if (["stopped", "completed"].includes(e.status)) return experiment;
  const rows = (await list(tx, scope, "metrics")).filter(
    (m) =>
      e.variants.includes(data(m).campaign) &&
      new Date(data(m).periodStart) >= new Date(e.startAt) &&
      new Date(data(m).periodEnd) <= new Date(e.endAt),
  );
  const groups = e.variants.map((variant: string) => {
    const matches = rows.filter((m) => data(m).campaign === variant);
    return {
      variant,
      sampleSize: matches.reduce(
        (n, m) => n + Number(data(m).sampleSize ?? 0),
        0,
      ),
      value:
        matches.length &&
        matches.every(
          (m) =>
            data(m)[e.primaryMetric] !== null &&
            data(m)[e.primaryMetric] !== undefined,
        )
          ? matches.reduce((n, m) => n + Number(data(m)[e.primaryMetric]), 0)
          : null,
      metricIds: matches.map((m) => m.id),
    };
  });
  const sufficient = groups.every(
    (v: any) => v.sampleSize >= e.minimumSample && v.value !== null,
  );
  const expired = at >= new Date(e.endAt);
  return update(tx, scope, experiment, {
    ...e,
    status: expired
      ? "completed"
      : at < new Date(e.startAt)
        ? "planned"
        : "running",
    result: sufficient ? "descriptive_only" : "insufficient_data",
    groups,
    winner: null,
    limitations: [
      "Observational measurements do not establish causality.",
      "No automatic budget change or statistically certain winner.",
    ],
    snapshot: hash(rows.map((m) => ({ id: m.id, version: m.version }))),
    evaluatedAt: at.toISOString(),
  });
}
export async function stopExperiment(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  reason: string,
) {
  const row = await entity(tx, scope, "experiments", id);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  await audit(tx, scope, "experiment.stop", id, { reason });
  return update(tx, scope, row, {
    ...data(row),
    status: "stopped",
    stopReason: reason,
    stoppedBy: scope.userId,
  });
}
export async function retention(
  tx: DbTx,
  scope: Scope,
  days: number,
  at = new Date(),
) {
  if (!Number.isInteger(days) || days < 30 || days > 3650)
    throw new DomainError("INVALID_RETENTION");
  const cutoff = new Date(at.valueOf() - days * 86400000);
  const expired = (await list(tx, scope, "insights")).filter(
    (x) =>
      x.updatedAt < cutoff &&
      !["deleted", "invalidated"].includes(data(x).status),
  );
  for (const row of expired)
    await memoryLifecycle(tx, scope, "insights", row.id, row.version, "delete");
  const expiredPrefs = (await list(tx, scope, "preferences")).filter(
    (x) =>
      data(x).validUntil &&
      new Date(data(x).validUntil) < cutoff &&
      data(x).status !== "deleted",
  );
  for (const row of expiredPrefs)
    await memoryLifecycle(
      tx,
      scope,
      "preferences",
      row.id,
      row.version,
      "delete",
    );
  await audit(tx, scope, "retention.apply", scope.projectId, {
    days,
    insights: expired.length,
    preferences: expiredPrefs.length,
  });
  return {
    purgedInsights: expired.length,
    purgedPreferences: expiredPrefs.length,
  };
}
// The sweep frame moved to the platform scheduler (WP1.6); its marketing and
// source-sync parts are scheduler contributions. Importers keep this path.
export { nextSweepAt, sweepProject } from "../platform/jobs/scheduler.ts";

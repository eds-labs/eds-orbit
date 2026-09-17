import { prepareFollowup } from "./planning.ts";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  create,
  update,
  entity,
  list,
  data,
  hash,
  DomainError,
  audit,
  exception,
} from "../shared.ts";
import { analyze, enqueue } from "./workflow.ts";

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
/** Bounded sweep: an owner-created mission is never extended or regenerated past its quota. */
export async function sweepProject(tx: DbTx, scope: Scope, at = new Date()) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return { queued: 0 };
  let queued = 0;
  const metrics = await list(tx, scope, "metrics");
  for (const m of await list(tx, scope, "missions")) {
    if (metrics.some((row) => data(row).campaign === m.id)) {
      try {
        await analyze(tx, scope, m.id);
      } catch (error) {
        if (error instanceof DomainError)
          await exception(tx, scope, error.code, m.id);
        else throw error;
      }
    }
    const current = (await prepareFollowup(tx, scope, m.id, at)) ?? m;
    const d = data(current);
    if (d.status !== "ready" || at < new Date(d.startAt)) continue;
    if (at >= new Date(d.endAt)) {
      await update(tx, scope, m, { ...d, status: "expired" });
      continue;
    }
    await enqueue(
      tx,
      scope,
      "generation",
      m.id,
      "mission:" + m.id + ":" + current.version,
      at,
    );
    queued++;
  }
  const requests = await list(tx, scope, "sync_requests");
  for (const source of await list(tx, scope, "sources")) {
    const d = data(source);
    if (d.status !== "active" || !d.syncEveryHours) continue;
    const latest = requests.find((r) => data(r).sourceId === source.id);
    if (!latest) continue;
    const last = d.lastSuccessfulSyncAt
      ? Date.parse(d.lastSuccessfulSyncAt)
      : 0;
    if (at.valueOf() - last < d.syncEveryHours * 3600000) continue;
    const slot = Math.floor(at.valueOf() / (d.syncEveryHours * 3600000));
    const key = `periodic-sync:${source.id}:${d.generation}:${slot}`;
    const jobs = await list(tx, scope, "jobs");
    if (jobs.some((j) => data(j).idempotencyKey === key)) continue;
    const request = await create(tx, scope, "sync_requests", {
      ...data(latest),
      expectedGeneration: d.generation,
    });
    await enqueue(tx, scope, "ingestion", request.id, key, at);
    queued++;
  }
  for (const e of await list(tx, scope, "experiments"))
    if (data(e).status === "running" && at >= new Date(data(e).endAt))
      await evaluateExperiment(tx, scope, e.id, at);
  return { queued };
}

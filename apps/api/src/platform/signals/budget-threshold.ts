import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { publishEvent } from "../events/events.ts";
import { proactiveEnabled } from "../proactive/preferences.ts";

// Budget threshold events (ADR 0023 item 7, plan WP4.2, R4-2). `reserve`
// emits `platform.ai.budget_threshold_crossed` once per (layer, scope,
// period, threshold) at 80 % and 100 %. Content-free: the layer, the scope
// id, the period, the threshold and a coarse remaining bucket.
//
// Once only: the crossing is evaluated after the reservation under the
// locks `reserve` already holds (the project's transaction lock; the
// organization counters' row locks), and the event's idempotent key is
// checked under an advisory lock on that key before publishing, so
// parallel reservations publish it at most once. The organization layers'
// key check sees the events of the reserving project only (row-level
// security); a second project reaching the same organization threshold in
// the same month can therefore emit it there once more, deduplicated again
// by the notification key in that project.
//
// 100 % means the budget is used up for calls of this size: this
// reservation took it to the limit, or one more reservation of the same
// size would not fit. (`reserve` refuses anything above the limit, so the
// spend itself never passes it.)

export const BUDGET_THRESHOLD_EVENT = "platform.ai.budget_threshold_crossed";
export const BUDGET_THRESHOLDS = [80, 100] as const;

export type ThresholdLayer = {
  /** `project_month`, `org_month` or `org_<provider>`. */
  layer: string;
  scopeId: string;
  /** Spend of the period before and after this reservation, in micros. */
  before: number;
  after: number;
  amount: number;
  limit: number | null | undefined;
  /** The budget period, e.g. "2026-11". */
  period: string;
};

/** The thresholds this reservation crosses on one layer. */
export function crossedThresholds(l: Pick<ThresholdLayer, "before" | "after" | "amount" | "limit">) {
  const limit = l.limit;
  if (!limit || limit <= 0) return [];
  return BUDGET_THRESHOLDS.filter((t) => {
    const line = (limit * t) / 100;
    if (l.before >= line) return false;
    return t === 100 ? l.after >= limit || limit - l.after < l.amount : l.after >= line;
  });
}

export const thresholdKey = (l: Pick<ThresholdLayer, "layer" | "scopeId" | "period">, t: number) =>
  `budget_threshold:${l.layer}:${l.scopeId}:${l.period}:${t}`;

/** Publishes each newly crossed threshold once; nothing while ORBIT_PROACTIVE is off. */
export async function emitBudgetThresholds(
  tx: DbTx,
  scope: Scope,
  layers: readonly ThresholdLayer[],
) {
  if (!proactiveEnabled()) return 0;
  let emitted = 0;
  for (const layer of layers)
    for (const threshold of crossedThresholds(layer)) {
      const key = thresholdKey(layer, threshold);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"orbit:" + key}, 0))`;
      const existing = await tx.domainEvent.findFirst({
        where: {
          projectId: scope.projectId,
          type: BUDGET_THRESHOLD_EVENT,
          data: { path: ["key"], equals: key },
        },
        select: { id: true },
      });
      if (existing) continue;
      const remaining = Math.max(0, (layer.limit ?? 0) - layer.after);
      await publishEvent(tx, scope, {
        type: BUDGET_THRESHOLD_EVENT,
        subject: { type: "platform.ai_budget", id: layer.scopeId },
        actor: { kind: "system", id: null },
        origin: "platform.ai",
        data: {
          key,
          layer: layer.layer,
          scopeId: layer.scopeId,
          period: layer.period,
          threshold,
          // Tenths of the limit left, rounded down: no amounts.
          remainingBucket: Math.floor((remaining / (layer.limit || 1)) * 10) * 10,
        },
      });
      emitted++;
    }
  return emitted;
}

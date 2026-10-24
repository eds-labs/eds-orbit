import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { openOwnerRequests } from "../../modules/action-requests.ts";
import { budgetMonthStart } from "../ai/budget.ts";
import { activePolicyRecord, platformSpendLimits } from "../ai/spend-mandate.ts";
import { providerBudgetStatus } from "../ai/provider-budget.ts";
import { data } from "../shared.ts";
import { can, PROJECT_OWN, PROJECT_WRITE } from "../tenancy/permissions.ts";
import { hiddenKinds } from "../tenancy/module-roles.ts";
import type { AttentionItem, AttentionStatus } from "./types.ts";

// The platform's own attention items and the AI month of the status block
// (UI restructure §4.2): the worker, unclear AI cost and open action
// requests. Cost and requests are the owner's to resolve.

const OPERATIONS = { navKey: "operations", link: "/operations" } as const;

/** What `runtimeHealth()` reports, read before the project transaction. */
export type WorkerHealth = { worker: string; lastHeartbeat: string | null };

/** The project's AI reservations of the UTC budget month. */
export type ReservationMonth = {
  /** What the monthly limit counts: settled, reserved, in flight, unclear. */
  spentMicros: number;
  /** Reservations whose outcome is unclear (`unknown`), if any. */
  unknown: { micros: number; since: string } | null;
};

/**
 * The month's reservations as the budget enforcement counts them
 * (`reserve` in platform/ai/budget.ts): every reservation created since the
 * UTC month start except released ones, settled at its settled amount, the
 * rest at the reserved amount. One grouped query on the createdAt index.
 */
export async function reservationMonth(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<ReservationMonth> {
  const groups = await tx.budgetReservation.groupBy({
    by: ["state"],
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: budgetMonthStart(now) },
      state: { not: "released" },
    },
    _sum: { amountMicros: true, settledMicros: true },
    _min: { createdAt: true },
  });
  let spentMicros = 0;
  let unknown: ReservationMonth["unknown"] = null;
  for (const group of groups) {
    const micros = Number(
      (group.state === "settled"
        ? group._sum.settledMicros
        : group._sum.amountMicros) ?? 0,
    );
    spentMicros += micros;
    if (group.state === "unknown" && group._min.createdAt)
      unknown = { micros, since: group._min.createdAt.toISOString() };
  }
  return { spentMicros, unknown };
}

/**
 * The month's AI spend and the active policy's monthly limit, for owners and
 * editors only (the level of /ai-cost; ruling R26): a viewer gets undefined.
 * The limit is null without an active policy and left out for a member the
 * policies are hidden from (module role `none`), as the dashboard leaves the
 * policy out: unknown, not "no limit".
 */
export async function aiMonthStatus(
  tx: DbTx,
  scope: Scope,
  month: ReservationMonth,
): Promise<AttentionStatus["aiMonth"]> {
  if (!can(scope, PROJECT_WRITE)) return undefined;
  const spentMicros = month.spentMicros;
  // The platform's spending authority (ADR 0015) belongs to no module, so a
  // Marketing role does not hide it.
  const platform = await platformSpendLimits(tx, scope).catch(() => null);
  if (platform)
    return { spentMicros, limitMicros: platform.monthlyBudgetMicros };
  if (hiddenKinds(scope).includes("policies")) return { spentMicros };
  const limit = data(await activePolicyRecord(tx, scope)).monthlyBudgetMicros;
  return {
    spentMicros,
    limitMicros: typeof limit === "number" ? limit : null,
  };
}

/** The platform's items for the member: worker for everyone, the rest for owners. */
export async function platformAttention(
  tx: DbTx,
  scope: Scope,
  now: Date,
  context: { worker: WorkerHealth; month: ReservationMonth },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  if (context.worker.worker !== "ready")
    items.push({
      id: "platform:worker-down",
      moduleId: "platform",
      kind: "platform_worker_down",
      severity: "critical",
      ...(context.worker.lastHeartbeat
        ? { since: context.worker.lastHeartbeat }
        : {}),
      params: {},
      ...OPERATIONS,
    });
  if (!can(scope, PROJECT_OWN)) return items;
  const unknown = context.month.unknown;
  if (unknown)
    items.push({
      id: "platform:cost-unknown",
      moduleId: "platform",
      kind: "platform_cost_unknown",
      severity: "warning",
      since: unknown.since,
      params: { micros: unknown.micros },
      ...OPERATIONS,
    });
  // The Anthropic credit budget (plan D-A8): a warning from the first
  // threshold, critical from the second and when calls are stopped.
  const anthropic = await providerBudgetStatus(tx, scope, "anthropic", now);
  if (anthropic.configured && anthropic.level && anthropic.level !== "ok")
    items.push({
      id: "platform:provider-budget:anthropic",
      moduleId: "platform",
      kind: "platform_provider_budget",
      severity: anthropic.level === "warn" ? "warning" : "critical",
      dueAt: anthropic.spend!.periodEnd.toISOString(),
      since: anthropic.spend!.periodStart.toISOString(),
      params: {
        provider: "anthropic",
        level: anthropic.level,
        spentMicros: anthropic.spend!.spentMicros,
        stopMicros: anthropic.budget!.stopMicros,
        monthlyMicros: anthropic.budget!.monthlyMicros,
      },
      navKey: "operations",
      link: "/settings?section=ai",
    });
  const requests = await openOwnerRequests(tx, scope, now);
  if (requests.length) {
    const expiries = requests
      .map((row) => Date.parse(data(row).expiresAt))
      .filter((at) => !Number.isNaN(at));
    items.push({
      id: "platform:action-requests",
      moduleId: "platform",
      kind: "platform_action_request",
      severity: "warning",
      count: requests.length,
      // Due when the first request expires; waiting since the oldest one.
      ...(expiries.length
        ? { dueAt: new Date(Math.min(...expiries)).toISOString() }
        : {}),
      since: requests.at(-1)!.createdAt.toISOString(),
      params: {},
      navKey: "decisions",
      link: "/decisions",
    });
  }
  return items;
}

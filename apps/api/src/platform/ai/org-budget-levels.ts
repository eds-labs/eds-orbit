import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { reservationMonth } from "../attention/platform-items.ts";
import {
  activeSpendPolicyRecord,
  requireSpendMandate,
} from "./spend-mandate.ts";

// The per-project reads behind the organization's budget levels (plan
// 2026-11-10 WP2 B). System administration reaches the database only
// through the control plane (ADR 0013), so the AI platform reads each
// project inside the project's own scoped transaction, the way
// `aiCostSummary` does: row-level security stays as it is. Nothing is
// written.

/** off: saved but not applied; not_set: no limit; active: applied now. */
export type LimitState = "off" | "not_set" | "active";

/** The owner reading the organization page, acting in one project. */
const ownerScope = (workspaceId: string, projectId: string, actorId: string) =>
  ({ workspaceId, projectId, userId: actorId, role: "owner" }) as Scope;

async function projectLimit(tx: DbTx, scope: Scope, now: Date) {
  const record = await activeSpendPolicyRecord(tx, scope);
  let mandate: Awaited<ReturnType<typeof requireSpendMandate>> | null = null;
  let problem: string | null = null;
  try {
    mandate = await requireSpendMandate(tx, scope);
  } catch (error) {
    const code = (error as { code?: string }).code;
    problem = code === "POLICY_REQUIRED" ? null : (code ?? "POLICY_INVALID");
  }
  const limits = mandate?.limits ?? null;
  const state: LimitState | "expired" | "invalid" = problem
    ? "invalid"
    : !limits
      ? "not_set"
      : !limits.approvedPaidTests || !limits.monthlyBudgetMicros
        ? "off"
        : now < new Date(limits.startAt) || now >= new Date(limits.endAt)
          ? "expired"
          : "active";
  const stored = record ? (record.data as Record<string, unknown>) : null;
  return {
    state,
    source: mandate?.source ?? ("none" as const),
    monthlyBudgetMicros: limits?.monthlyBudgetMicros ?? null,
    dailyBudgetMicros: limits?.dailyBudgetMicros ?? null,
    perRunBudgetMicros: limits?.perRunBudgetMicros ?? null,
    endAt: limits?.endAt ?? null,
    spentMicros: (await reservationMonth(tx, scope, now)).spentMicros,
    activatedBy:
      mandate?.source === "platform" && typeof stored?.activatedBy === "string"
        ? stored.activatedBy
        : null,
    activatedAt:
      mandate?.source === "platform" && typeof stored?.activatedAt === "string"
        ? stored.activatedAt
        : (record?.createdAt.toISOString() ?? null),
  };
}

/**
 * The spending authority of one business project as the organization page
 * shows it: limits, this month's spend and who activated it.
 */
export function projectSpendAuthority(
  workspaceId: string,
  projectId: string,
  actorId: string,
  now: Date,
) {
  return scoped(workspaceId, projectId, (tx) =>
    projectLimit(tx, ownerScope(workspaceId, projectId, actorId), now),
  );
}

/**
 * One personal space's AI reservations of the UTC budget month: what the
 * monthly limit counts and the unclear part. The organization page adds
 * them up to one sum (ADR 0022: never per user).
 */
export function personalSpaceMonth(
  workspaceId: string,
  projectId: string,
  actorId: string,
  now: Date,
) {
  return scoped(workspaceId, projectId, (tx) =>
    reservationMonth(tx, ownerScope(workspaceId, projectId, actorId), now),
  );
}

import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  aiSpendPolicy,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import { DomainError, data } from "../shared.ts";

/**
 * The AI spend mandate: the limits a paid model call is reserved against.
 * Since ADR 0015 it is the platform's active `ai_spend_policies` record.
 * The budget fields of the active Marketing policy (`policies`, ADR 0009
 * AD-10 step 1) apply only in the rollback modes of ORBIT_SPEND_POLICY_SOURCE
 * (plan 3.8). Platform services such as retrieval, embedding, reindexing and
 * the assistant read only this projection.
 */
export type SpendLimits = {
  startAt: string;
  endAt: string;
  approvedPaidTests: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  perRunBudgetMicros: number;
};
/** Where a mandate was read from: the platform record or the legacy Marketing policy. */
export type SpendMandateSource = "platform" | "marketing_policy";
/** The validated mandate plus the policy record version it was read from. */
export type SpendMandate = {
  id: string;
  version: number;
  limits: SpendLimits;
  source: SpendMandateSource;
};
/** The mandate as stored, for re-checking a prepared call: no validation. */
export type SpendMandateRef = {
  id: string;
  version: number;
  data: { startAt: string; endAt: string };
};

const USD = 1_000_000;
const DAY = 86_400_000;

/**
 * Limits derived from a monthly amount (decision D-4): a day may use a
 * tenth of it, a run at most a day's share and never more than USD 2.
 */
export function derivedLimits(monthlyBudgetMicros: number) {
  const dailyBudgetMicros = Math.floor(monthlyBudgetMicros / 10);
  return {
    dailyBudgetMicros,
    perRunBudgetMicros: Math.min(dailyBudgetMicros, 2 * USD),
  };
}

type MandateRow = {
  id: string;
  version: number;
  data: unknown;
  createdAt: Date;
};

/**
 * A personal space's spending authority (ADR 0022 D-09): a read-only
 * projection of the organization's per-user assistant cap, never a stored
 * record the user could change. Its id and version are the organization
 * budget's, so a prepared call sees any change of the cap. Undefined for
 * every other project; null without a cap (no paid assistant turns).
 */
export async function personalSpendRecord(
  tx: DbTx,
  scope: Scope,
): Promise<MandateRow | null | undefined> {
  const project = await tx.project.findFirst({
    where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: { kind: true },
  });
  if (project?.kind !== "personal") return undefined;
  const budget = await tx.organizationAiBudget.findFirst({
    where: { workspaceId: scope.workspaceId },
    select: {
      id: true,
      version: true,
      updatedAt: true,
      assistantPerUserMonthlyMicros: true,
    },
  });
  if (budget?.assistantPerUserMonthlyMicros == null) return null;
  const monthlyBudgetMicros = Number(budget.assistantPerUserMonthlyMicros);
  return {
    id: budget.id,
    version: budget.version,
    createdAt: budget.updatedAt,
    data: {
      profile: "monthly",
      startAt: budget.updatedAt.toISOString(),
      endAt: new Date(budget.updatedAt.getTime() + 100 * 365 * DAY).toISOString(),
      approvedPaidUse: monthlyBudgetMicros > 0,
      monthlyBudgetMicros,
      ...derivedLimits(monthlyBudgetMicros),
      active: true,
    },
  };
}

/** The newest record of `kind` with `active: true`, or null. One row. */
async function activeRecord(
  tx: DbTx,
  scope: Scope,
  kind: "policies" | "ai_spend_policies",
): Promise<MandateRow | null> {
  if (kind === "ai_spend_policies") {
    const personal = await personalSpendRecord(tx, scope);
    if (personal !== undefined) return personal;
  }
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      data: { path: ["active"], equals: true },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The active Marketing policy record (the newest with `active: true`), or
 * null. The marketing `activePolicy` reads it too. One row, not every
 * policy version: the attention route reads it on every page load.
 */
export async function activePolicyRecord(tx: DbTx, scope: Scope) {
  return activeRecord(tx, scope, "policies");
}

/** Where the mandate is read from (ORBIT_SPEND_POLICY_SOURCE, plan 3.8). */
const spendSource = () => loadConfig().ORBIT_SPEND_POLICY_SOURCE;

/**
 * The active platform spending authority (ADR 0015), or null; always null
 * while ORBIT_SPEND_POLICY_SOURCE is "marketing" (rollback).
 */
export async function activeSpendPolicyRecord(tx: DbTx, scope: Scope) {
  if (spendSource() === "marketing") return null;
  return activeRecord(tx, scope, "ai_spend_policies");
}

// The budget fields of a Marketing policy: its publishing fields no longer
// decide whether paid AI may run (ADR 0015).
const legacyLimits = z.object({
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  approvedPaidTests: z.boolean().default(false),
  dailyBudgetMicros: z.number().int().min(0).max(1000000000),
  monthlyBudgetMicros: z.number().int().min(0).max(10000000000),
  perRunBudgetMicros: z.number().int().min(0).max(100000000),
});

/**
 * The record the mandate comes from: the platform's spending authority; the
 * active Marketing policy only in the "fallback" (without a platform record)
 * and "marketing" rollback modes; null otherwise.
 */
async function mandateRecord(tx: DbTx, scope: Scope) {
  const platform = await activeSpendPolicyRecord(tx, scope);
  if (platform) return { row: platform, source: "platform" as const };
  if (spendSource() === "platform") return null;
  const legacy = await activePolicyRecord(tx, scope);
  return legacy ? { row: legacy, source: "marketing_policy" as const } : null;
}

/**
 * Whether `reserve` may use the limits its caller passed when the project
 * has no platform record: only in the rollback modes. In "platform" mode a
 * Marketing caller's own policy budget no longer authorizes anything.
 */
export const passedLimitsAllowed = () => spendSource() !== "platform";

/**
 * The limits a mandate record grants, validated: the platform schema for a
 * platform record, the budget fields for a Marketing policy.
 */
function limitsOf(
  row: { data: unknown },
  source: SpendMandateSource,
): SpendLimits {
  const value = Object.fromEntries(
    Object.entries(data(row)).filter(
      ([key]) =>
        ![
          "active",
          "activatedAt",
          "activatedBy",
          "sourcePolicyId",
          "sourcePolicyVersion",
        ].includes(key),
    ),
  );
  if (source === "platform") {
    const parsed = aiSpendPolicy.parse(value);
    return {
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      approvedPaidTests: parsed.approvedPaidUse,
      dailyBudgetMicros: parsed.dailyBudgetMicros,
      monthlyBudgetMicros: parsed.monthlyBudgetMicros,
      perRunBudgetMicros: parsed.perRunBudgetMicros,
    };
  }
  const parsed = legacyLimits.parse(value);
  if (parsed.endAt <= parsed.startAt)
    throw new DomainError("POLICY_INTERVAL_INVALID");
  return parsed;
}

/**
 * The active mandate, validated; POLICY_REQUIRED without a platform
 * spending authority or an active Marketing policy.
 */
export async function requireSpendMandate(
  tx: DbTx,
  scope: Scope,
): Promise<SpendMandate> {
  const found = await mandateRecord(tx, scope);
  if (!found) throw new DomainError("POLICY_REQUIRED");
  return {
    id: found.row.id,
    version: found.row.version,
    limits: limitsOf(found.row, found.source),
    source: found.source,
  };
}

/**
 * The limits of the platform spending authority, or null without one. A
 * reservation enforces them over whatever limits its caller passed.
 */
export async function platformSpendLimits(
  tx: DbTx,
  scope: Scope,
): Promise<SpendLimits | null> {
  const row = await activeSpendPolicyRecord(tx, scope);
  return row ? limitsOf(row, "platform") : null;
}

/** The active mandate's record id, version and window, or null. */
export async function activeSpendMandateRef(
  tx: DbTx,
  scope: Scope,
): Promise<SpendMandateRef | null> {
  const found = await mandateRecord(tx, scope);
  return found
    ? {
        id: found.row.id,
        version: found.row.version,
        data: {
          startAt: data(found.row).startAt,
          endAt: data(found.row).endAt,
        },
      }
    : null;
}

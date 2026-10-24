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
 * Since ADR 0015 it is the platform's active `ai_spend_policies` record;
 * without one, the budget fields of the active Marketing policy
 * (`policies`, ADR 0009 AD-10 step 1) still apply until every project has a
 * platform record. Platform services such as retrieval, embedding,
 * reindexing and the assistant read only this projection.
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

/** The newest record of `kind` with `active: true`, or null. One row. */
async function activeRecord(
  tx: DbTx,
  scope: Scope,
  kind: "policies" | "ai_spend_policies",
) {
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

/**
 * The active platform spending authority (ADR 0015), or null; always null
 * while ORBIT_SPEND_POLICY_SOURCE is "marketing" (rollback).
 */
export async function activeSpendPolicyRecord(tx: DbTx, scope: Scope) {
  if (loadConfig().ORBIT_SPEND_POLICY_SOURCE === "marketing") return null;
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
 * The record the mandate comes from: the platform's spending authority,
 * else the active Marketing policy; null without either.
 */
async function mandateRecord(tx: DbTx, scope: Scope) {
  const platform = await activeSpendPolicyRecord(tx, scope);
  if (platform) return { row: platform, source: "platform" as const };
  const legacy = await activePolicyRecord(tx, scope);
  return legacy ? { row: legacy, source: "marketing_policy" as const } : null;
}

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

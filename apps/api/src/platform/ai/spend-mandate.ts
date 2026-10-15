import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  policy as policySchema,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import { DomainError, data, list } from "../shared.ts";

/**
 * The AI spend mandate (ADR 0009, AD-10 step 1): the limits a paid model call
 * is reserved against. It is still stored in the active marketing policy
 * (`policies`); this projection is all that platform services such as
 * retrieval, embedding, reindexing and the assistant read from it.
 */
export type SpendLimits = {
  startAt: string;
  endAt: string;
  approvedPaidTests: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  perRunBudgetMicros: number;
};
/** The validated mandate plus the policy record version it was read from. */
export type SpendMandate = { id: string; version: number; limits: SpendLimits };
/** The mandate as stored, for re-checking a prepared call: no validation. */
export type SpendMandateRef = {
  id: string;
  version: number;
  data: { startAt: string; endAt: string };
};

/** The active policy record, or null. The marketing `activePolicy` reads it too. */
export async function activePolicyRecord(tx: DbTx, scope: Scope) {
  const rows = await list(tx, scope, "policies");
  return rows.find((x) => data(x).active === true) ?? null;
}

/**
 * The active mandate, validated against the stored policy schema as before
 * this projection existed; POLICY_REQUIRED without an active policy.
 */
export async function requireSpendMandate(
  tx: DbTx,
  scope: Scope,
): Promise<SpendMandate> {
  const row = await activePolicyRecord(tx, scope);
  if (!row) throw new DomainError("POLICY_REQUIRED");
  const parsed = policySchema.parse(
    Object.fromEntries(
      Object.entries(data(row)).filter(
        ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
      ),
    ),
  );
  return {
    id: row.id,
    version: row.version,
    limits: {
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      approvedPaidTests: parsed.approvedPaidTests,
      dailyBudgetMicros: parsed.dailyBudgetMicros,
      monthlyBudgetMicros: parsed.monthlyBudgetMicros,
      perRunBudgetMicros: parsed.perRunBudgetMicros,
    },
  };
}

/** The active mandate's record id, version and window, or null. */
export async function activeSpendMandateRef(
  tx: DbTx,
  scope: Scope,
): Promise<SpendMandateRef | null> {
  const row = await activePolicyRecord(tx, scope);
  return row
    ? {
        id: row.id,
        version: row.version,
        data: { startAt: data(row).startAt, endAt: data(row).endAt },
      }
    : null;
}

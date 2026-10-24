import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  aiSpendPolicy,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, list, update } from "../shared.ts";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import { budgetMonthStart } from "./budget.ts";
import { activeSpendPolicyRecord, requireSpendMandate } from "./spend-mandate.ts";

// The project's AI spending authority (ADR 0015): one active, versioned
// record of kind `ai_spend_policies`, owner-only, audited. It never writes
// the Marketing policy, so policy versions and package hashes stay as they are.

export const SPEND_POLICY_KIND = "ai_spend_policies";
const DAY = 86_400_000;
const USD = 1_000_000;

/**
 * Standard profiles (decision E-4). A profile other than "custom" sets
 * every limit and the window from now on; the owner only picks it.
 */
export const spendProfiles = {
  off: {
    days: 365,
    approvedPaidUse: false,
    dailyBudgetMicros: 0,
    monthlyBudgetMicros: 0,
    perRunBudgetMicros: 0,
  },
  test: {
    days: 14,
    approvedPaidUse: true,
    dailyBudgetMicros: 1 * USD,
    monthlyBudgetMicros: 10 * USD,
    perRunBudgetMicros: USD / 2,
  },
  normal: {
    days: 365,
    approvedPaidUse: true,
    dailyBudgetMicros: 5 * USD,
    monthlyBudgetMicros: 50 * USD,
    perRunBudgetMicros: 2 * USD,
  },
} as const;

export const spendPolicyInput = z.discriminatedUnion("profile", [
  z.object({ profile: z.enum(["off", "test", "normal"]) }).strict(),
  z
    .object({
      profile: z.literal("custom"),
      startAt: z.iso.datetime(),
      endAt: z.iso.datetime(),
      approvedPaidUse: z.boolean(),
      dailyBudgetMicros: z.number().int().min(0).max(1000000000),
      monthlyBudgetMicros: z.number().int().min(0).max(10000000000),
      perRunBudgetMicros: z.number().int().min(0).max(100000000),
    })
    .strict(),
]);

/** The stored fields a validated input stands for, at `now`. */
export function spendPolicyFields(
  raw: unknown,
  now = new Date(),
): z.infer<typeof aiSpendPolicy> {
  const input = spendPolicyInput.parse(raw);
  if (input.profile === "custom") return aiSpendPolicy.parse(input);
  const { days, ...limits } = spendProfiles[input.profile];
  return aiSpendPolicy.parse({
    profile: input.profile,
    startAt: now.toISOString(),
    endAt: new Date(now.getTime() + days * DAY).toISOString(),
    ...limits,
  });
}

/**
 * Activates a new spending authority: older records are deactivated, the
 * new one is active from now. `source` names a Marketing policy it was
 * copied from (the backfill), never written back.
 */
export async function saveSpendPolicy(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  options: { source?: { id: string; version: number }; now?: Date } = {},
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const fields = spendPolicyFields(raw, options.now);
  for (const row of await list(tx, scope, SPEND_POLICY_KIND))
    if (data(row).active)
      await update(tx, scope, row, { ...data(row), active: false });
  const row = await create(tx, scope, SPEND_POLICY_KIND, {
    ...fields,
    active: true,
    activatedBy: scope.userId,
    activatedAt: (options.now ?? new Date()).toISOString(),
    ...(options.source
      ? {
          sourcePolicyId: options.source.id,
          sourcePolicyVersion: options.source.version,
        }
      : {}),
  });
  await audit(
    tx,
    scope,
    options.source ? "ai_spend_policy.migrated" : "ai_spend_policy.activated",
    row.id,
    {
      profile: fields.profile,
      approvedPaidUse: fields.approvedPaidUse,
      dailyBudgetMicros: fields.dailyBudgetMicros,
      monthlyBudgetMicros: fields.monthlyBudgetMicros,
      perRunBudgetMicros: fields.perRunBudgetMicros,
      endAt: fields.endAt,
      ...(options.source ? { sourcePolicyId: options.source.id } : {}),
    },
  );
  return row;
}

/**
 * What the AI & budget page shows: the platform record, the effective
 * mandate and where it comes from, this month's and today's spend (settled
 * plus open reservations, as `reserve` counts it) and the profiles.
 */
export async function readSpendPolicy(tx: DbTx, scope: Scope, now = new Date()) {
  const record = await activeSpendPolicyRecord(tx, scope);
  let effective: Awaited<ReturnType<typeof requireSpendMandate>> | null = null;
  let problem: string | null = null;
  try {
    effective = await requireSpendMandate(tx, scope);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A stored record that no longer validates is reported, not thrown.
    problem = code === "POLICY_REQUIRED" ? null : (code ?? "POLICY_INVALID");
  }
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const rows = await tx.budgetReservation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: budgetMonthStart(now) },
      state: { not: "released" },
    },
    select: { state: true, amountMicros: true, settledMicros: true, createdAt: true },
  });
  const cost = (x: (typeof rows)[number]) =>
    Number(x.state === "settled" ? x.settledMicros : x.amountMicros);
  return {
    record: record
      ? {
          id: record.id,
          version: record.version,
          ...(data(record) as Record<string, unknown>),
        }
      : null,
    source: effective?.source ?? "none",
    effective: effective?.limits ?? null,
    active: Boolean(
      effective &&
        effective.limits.approvedPaidTests &&
        Date.parse(effective.limits.startAt) <= now.getTime() &&
        Date.parse(effective.limits.endAt) > now.getTime(),
    ),
    problem,
    usage: {
      monthMicros: rows.reduce((n, x) => n + cost(x), 0),
      todayMicros: rows
        .filter((x) => x.createdAt >= day)
        .reduce((n, x) => n + cost(x), 0),
    },
    profiles: spendProfiles,
  };
}

/** Throws when the input cannot be saved, for MCP proposals before approval. */
export function assertSpendPolicyInput(raw: unknown) {
  try {
    spendPolicyFields(raw);
  } catch {
    throw new DomainError("SPEND_POLICY_INVALID", 400);
  }
}

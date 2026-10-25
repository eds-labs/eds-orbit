import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";

// The organization's AI budget (plans/ai-central-management.md, phase C,
// decisions D-5 and D-6): one monthly amount for all projects and a cap per
// provider, set by organization owners. While ORBIT_AI_ORG_BUDGET is on,
// every reservation of every project adds to the organization's counters of
// the UTC month (total and its provider), checked against the budget when
// one is set; settlement moves the same amount from reserved to settled.
// An unclear outcome stays reserved, as everywhere else.

export const aiOrgBudgetEnabled = () => process.env.ORBIT_AI_ORG_BUDGET === "true";

export const ORG_PROVIDERS = ["openai", "anthropic"] as const;
export type OrgProvider = (typeof ORG_PROVIDERS)[number];
/** Warnings before the stop, as shares of a limit. */
export const ORG_WARN_LEVELS = [0.75, 0.9] as const;

const micros = z.number().int().min(0).max(100_000_000_000);
const credit = z
  .object({
    amountMicros: micros,
    verifiedAt: z.iso.datetime(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export const organizationAiBudgetInput = z
  .object({
    /** null: no monthly limit for the organization. */
    monthlyMicros: micros.nullable(),
    providerCaps: z
      .object({ openai: micros.optional(), anthropic: micros.optional() })
      .strict()
      .default({}),
    /** The provider balances as an owner last read them (manual, D-5). */
    credits: z
      .object({ openai: credit.optional(), anthropic: credit.optional() })
      .strict()
      .default({}),
  })
  .strict();
export type OrganizationAiBudgetInput = z.infer<typeof organizationAiBudgetInput>;

export function monthOf(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The level of `spent` against `limit`: ok, warn (75 %), warn2 (90 %), stopped. */
export function budgetLevel(spent: number, limit: number | null | undefined) {
  if (limit === null || limit === undefined) return null;
  if (spent >= limit) return "stopped" as const;
  if (spent >= limit * ORG_WARN_LEVELS[1]) return "warn2" as const;
  if (spent >= limit * ORG_WARN_LEVELS[0]) return "warn" as const;
  return "ok" as const;
}

/** The organization's budget, parsed; null without one. */
export async function organizationBudget(
  db: Pick<DbTx, "organizationAiBudget">,
  workspaceId: string,
) {
  const row = await db.organizationAiBudget.findFirst({ where: { workspaceId } });
  if (!row) return null;
  return {
    monthlyMicros: row.monthlyMicros === null ? null : Number(row.monthlyMicros),
    providerCaps: organizationAiBudgetInput.shape.providerCaps.parse(row.providerCaps),
    credits: organizationAiBudgetInput.shape.credits.parse(row.credits),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** The month's counters of an organization, by scope key. */
export async function organizationSpend(
  db: Pick<DbTx, "organizationSpendCounter">,
  workspaceId: string,
  month: Date,
) {
  const rows = await db.organizationSpendCounter.findMany({
    where: { workspaceId, periodStart: month },
  });
  const spend = (key: string) => {
    const row = rows.find((r) => r.scopeKey === key);
    return {
      reservedMicros: Number(row?.reservedMicros ?? 0),
      settledMicros: Number(row?.settledMicros ?? 0),
      spentMicros: Number((row?.reservedMicros ?? 0n) + (row?.settledMicros ?? 0n)),
    };
  };
  return {
    total: spend("total"),
    openai: spend("openai"),
    anthropic: spend("anthropic"),
  };
}

/**
 * Adds a reservation of `amount` to the organization's month counters,
 * locking them in a fixed order (total, then the provider) after the grant
 * counters, so concurrent reservations of several projects cannot pass a
 * limit together. Returns the provider counter used ('none' for a call
 * without a model), or null while the switch is off.
 */
export async function reserveOnOrganization(
  tx: DbTx,
  scope: Scope,
  provider: OrgProvider | "none",
  amount: number,
  month: Date,
) {
  if (!aiOrgBudgetEnabled()) return null;
  const budget = await organizationBudget(tx, scope.workspaceId);
  const counters: { key: string; limit: number | null | undefined; code: string }[] = [
    { key: "total", limit: budget?.monthlyMicros, code: "ORG_AI_BUDGET_EXCEEDED" },
    ...(provider === "none"
      ? []
      : [
          {
            key: provider,
            limit: budget?.providerCaps[provider],
            code: "ORG_PROVIDER_BUDGET_EXCEEDED",
          },
        ]),
  ];
  for (const c of counters) {
    await tx.$executeRaw`INSERT INTO "OrganizationSpendCounter" ("workspaceId","scopeKey","periodStart")
      VALUES (${scope.workspaceId}::uuid, ${c.key}, ${month})
      ON CONFLICT ("workspaceId","scopeKey","periodStart") DO NOTHING`;
    const [row] = await tx.$queryRaw<{ reservedMicros: bigint; settledMicros: bigint }[]>`
      SELECT "reservedMicros","settledMicros" FROM "OrganizationSpendCounter"
      WHERE "workspaceId" = ${scope.workspaceId}::uuid AND "scopeKey" = ${c.key}
        AND "periodStart" = ${month} FOR UPDATE`;
    if (!row) throw new DomainError("SPEND_COUNTER_UNAVAILABLE", 409);
    if (
      c.limit !== null &&
      c.limit !== undefined &&
      row.reservedMicros + row.settledMicros + BigInt(amount) > BigInt(c.limit)
    )
      throw new DomainError(c.code, 409);
  }
  for (const c of counters)
    await tx.$executeRaw`UPDATE "OrganizationSpendCounter"
      SET "reservedMicros" = "reservedMicros" + ${BigInt(amount)}
      WHERE "workspaceId" = ${scope.workspaceId}::uuid AND "scopeKey" = ${c.key}
        AND "periodStart" = ${month}`;
  return provider;
}

/**
 * Moves a settled reservation's amount from reserved to settled on the
 * counters it was added to (its month, total and provider). Reservations
 * that were not counted (`orgProvider` null) change nothing.
 */
export async function settleOnOrganization(
  tx: DbTx,
  row: {
    workspaceId: string;
    orgProvider: string | null;
    amountMicros: bigint;
    createdAt: Date;
  },
  actual: bigint,
) {
  if (!row.orgProvider) return;
  const month = monthOf(row.createdAt);
  const keys = ["total", ...(row.orgProvider === "none" ? [] : [row.orgProvider])];
  for (const key of keys)
    await tx.$executeRaw`UPDATE "OrganizationSpendCounter"
      SET "reservedMicros" = GREATEST("reservedMicros" - ${row.amountMicros}, 0),
          "settledMicros" = "settledMicros" + ${actual}
      WHERE "workspaceId" = ${row.workspaceId}::uuid AND "scopeKey" = ${key}
        AND "periodStart" = ${month}`;
}

/**
 * What the project's budget page shows of its organization: the monthly
 * budget and provider caps with this month's spend and level, or null when
 * the switch is off.
 */
export async function organizationBudgetForProject(tx: DbTx, scope: Scope, now = new Date()) {
  if (!aiOrgBudgetEnabled()) return null;
  const budget = await organizationBudget(tx, scope.workspaceId);
  const spend = await organizationSpend(tx, scope.workspaceId, monthOf(now));
  return {
    monthlyMicros: budget?.monthlyMicros ?? null,
    spentMicros: spend.total.spentMicros,
    level: budgetLevel(spend.total.spentMicros, budget?.monthlyMicros),
    providers: Object.fromEntries(
      ORG_PROVIDERS.map((p) => [
        p,
        {
          capMicros: budget?.providerCaps[p] ?? null,
          spentMicros: spend[p].spentMicros,
          level: budgetLevel(spend[p].spentMicros, budget?.providerCaps[p]),
        },
      ]),
    ) as Record<OrgProvider, { capMicros: number | null; spentMicros: number; level: ReturnType<typeof budgetLevel> }>,
  };
}

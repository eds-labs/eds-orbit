import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  providerBudgetLevel,
  providerOfModel,
  providerPeriod,
  type ModelRegistry,
  type ProviderBudget,
  type ProviderBudgetLevel,
  type ProviderId,
} from "../../../../../packages/ai/src/index.ts";
import { DomainError } from "../shared.ts";
import { runtimeProviderBudgets } from "./openai-configuration.ts";

/**
 * The provider budget (plan D-A6): what the project spent on one provider's
 * models in the current billing period, counted like `reserve` counts the
 * policy budget (settled at the settled amount, reserved, in-flight and
 * unknown at the reserved amount, released not at all). The provider of a
 * reservation is derived from its stored model through the model registry,
 * so no column was added.
 */

export const PROVIDER_BUDGET_STOP = "PROVIDER_BUDGET_STOP";

export type ProviderPeriodSpend = {
  spentMicros: number;
  settledMicros: number;
  pendingMicros: number;
  unknownMicros: number;
  count: number;
  periodStart: Date;
  periodEnd: Date;
};

/** The project's spend on `provider` models in the period of `budget`. */
export async function providerPeriodSpend(
  tx: DbTx,
  scope: Scope,
  provider: ProviderId,
  budget: Pick<ProviderBudget, "anchorDay">,
  registry: ModelRegistry | undefined,
  now = new Date(),
): Promise<ProviderPeriodSpend> {
  const period = providerPeriod(budget.anchorDay, now);
  const rows = await tx.budgetReservation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: period.start, lt: period.end },
      state: { not: "released" },
      model: { not: null },
    },
    select: { model: true, state: true, amountMicros: true, settledMicros: true },
  });
  const spend: ProviderPeriodSpend = {
    spentMicros: 0,
    settledMicros: 0,
    pendingMicros: 0,
    unknownMicros: 0,
    count: 0,
    periodStart: period.start,
    periodEnd: period.end,
  };
  for (const row of rows) {
    if (providerOfModel(row.model!, registry) !== provider) continue;
    const micros = Number(
      row.state === "settled" ? row.settledMicros : row.amountMicros,
    );
    spend.count++;
    spend.spentMicros += micros;
    if (row.state === "settled") spend.settledMicros += micros;
    else if (row.state === "unknown") spend.unknownMicros += micros;
    else spend.pendingMicros += micros;
  }
  return spend;
}

export type ProviderBudgetStatus = {
  provider: ProviderId;
  configured: boolean;
  budget: ProviderBudget | null;
  level: ProviderBudgetLevel | null;
  spend: ProviderPeriodSpend | null;
};

/** The status of a provider's budget for the admin view and the attention items. */
export async function providerBudgetStatus(
  tx: DbTx,
  scope: Scope,
  provider: ProviderId,
  now = new Date(),
): Promise<ProviderBudgetStatus> {
  const { providerBudgets, models } = await runtimeProviderBudgets(tx, scope);
  const budget = provider === "anthropic" ? providerBudgets?.anthropic : undefined;
  if (!budget)
    return { provider, configured: false, budget: null, level: null, spend: null };
  const spend = await providerPeriodSpend(tx, scope, provider, budget, models, now);
  return {
    provider,
    configured: true,
    budget,
    level: providerBudgetLevel(budget, spend.spentMicros),
    spend,
  };
}

/**
 * Whether a reservation of `amount` for `model` would pass the provider's
 * stop threshold; `PROVIDER_BUDGET_STOP` (409) when it would not. Called
 * inside `reserve` under the project lock, so parallel calls of one project
 * check one after the other. Models of a provider without a budget pass.
 */
export async function assertProviderBudget(
  tx: DbTx,
  scope: Scope,
  model: string,
  amount: number,
  now = new Date(),
) {
  const { providerBudgets, models } = await runtimeProviderBudgets(tx, scope);
  const provider = providerOfModel(model, models);
  const budget = provider === "anthropic" ? providerBudgets?.anthropic : undefined;
  if (!budget) return null;
  const spend = await providerPeriodSpend(tx, scope, provider, budget, models, now);
  if (spend.spentMicros + amount > budget.stopMicros)
    throw new DomainError(PROVIDER_BUDGET_STOP, 409);
  return { provider, budget, spend };
}

/** Whether a call of `amount` for `model` would be stopped, without throwing. */
export async function providerBudgetStops(
  tx: DbTx,
  scope: Scope,
  model: string,
  amount: number,
  now = new Date(),
) {
  try {
    await assertProviderBudget(tx, scope, model, amount, now);
    return false;
  } catch (error) {
    if (error instanceof DomainError && error.code === PROVIDER_BUDGET_STOP)
      return true;
    throw error;
  }
}

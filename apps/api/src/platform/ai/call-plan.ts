import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  providerOfModel,
  resolveRoute,
  type ModelRoute,
  type OpenAiRuntimeConfig,
  type ProviderId,
  type TaskClass,
} from "../../../../../packages/ai/src/index.ts";
import { providerBudgetStops } from "./provider-budget.ts";

export type CallPlan = {
  route: ModelRoute;
  provider: ProviderId;
  estimateMicros: number;
  /** The model the task's own route named when the budget fallback replaced it. */
  fallbackFrom: string | null;
};

/**
 * The route and estimate of one paid call (plan D-A7). The task's route is
 * resolved as before; when its provider's budget would stop the call before
 * transmission and the owner saved `fallback.onProviderBudgetStop: "openai"`,
 * the task's OpenAI tier route is used instead (verified and priced, or the
 * stop stands). `reserve` repeats the budget check, so a race between two
 * calls of one project still fails closed.
 */
export async function planCall(
  tx: DbTx,
  scope: Scope,
  taskClass: TaskClass,
  runtime: OpenAiRuntimeConfig,
  estimate: (route: ModelRoute) => number,
  now = new Date(),
): Promise<CallPlan> {
  const route = resolveRoute(taskClass, runtime);
  const provider = providerOfModel(route.model, runtime.models);
  const estimateMicros = estimate(route);
  if (
    provider === "anthropic" &&
    runtime.fallback?.onProviderBudgetStop === "openai" &&
    (await providerBudgetStops(tx, scope, route.model, estimateMicros, now))
  ) {
    const fallback = resolveRoute(taskClass, runtime, { provider: "openai" });
    return {
      route: fallback,
      provider: "openai",
      estimateMicros: estimate(fallback),
      fallbackFrom: route.model,
    };
  }
  return { route, provider, estimateMicros, fallbackFrom: null };
}

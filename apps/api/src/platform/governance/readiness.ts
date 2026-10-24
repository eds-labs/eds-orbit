import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { registeredReadiness } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { effectiveAiStatus, textModelReady } from "../ai/openai-configuration.ts";
import { requireSpendMandate } from "../ai/spend-mandate.ts";
import type { ProjectReadiness } from "./types.ts";

/**
 * The project's readiness: the registered provider of an enabled module
 * (Marketing's go-live readiness, WP2.1f), else the platform's own AI
 * readiness, so a project without Marketing is not judged by Marketing's
 * blockers (plan finding F7).
 */
export async function projectReadiness(
  tx: DbTx,
  scope: Scope,
): Promise<ProjectReadiness> {
  const provider = registeredReadiness(await enabledModules(tx, scope));
  return provider ? provider(tx, scope) : platformReadiness(tx, scope);
}

/**
 * Whether paid AI can run: an active spending authority with paid use
 * allowed, and a text model whose provider has a key. Codes as in the
 * Marketing readiness, so clients read them the same way.
 */
export async function platformReadiness(
  tx: DbTx,
  scope: Scope,
  now = Date.now(),
): Promise<ProjectReadiness> {
  const mandate = await requireSpendMandate(tx, scope).catch(() => null);
  const limits = mandate?.limits;
  const budget = Boolean(
    limits &&
      limits.approvedPaidTests &&
      Date.parse(limits.startAt) <= now &&
      Date.parse(limits.endAt) > now &&
      limits.dailyBudgetMicros > 0 &&
      limits.monthlyBudgetMicros > 0 &&
      limits.perRunBudgetMicros > 0,
  );
  const model = await effectiveAiStatus(tx, scope)
    .then(textModelReady)
    .catch(() => false);
  const project = await tx.project.findUnique({
    where: { id: scope.projectId },
    select: { paused: true },
  });
  const blockers = [
    ...(!budget ? ["APPROVED_PAID_BUDGET_REQUIRED"] : []),
    ...(!model ? ["VERIFIED_OPENAI_MODELS_REQUIRED"] : []),
    ...(project?.paused ? ["PROJECT_PAUSED"] : []),
  ];
  // The state names of the Marketing readiness: ready, or not configured.
  return { state: blockers.length ? "not_configured" : "live_ready", blockers };
}

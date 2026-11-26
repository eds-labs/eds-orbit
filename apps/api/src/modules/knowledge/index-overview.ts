import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { validateActiveIndexEvaluation } from "../../../../../packages/knowledge/src/index.ts";
import { ownerEnabled } from "../../platform/modules/contributions.ts";
import { enabledModules } from "../../platform/modules/enforcement.ts";
import { effectiveRole } from "../../platform/tenancy/module-roles.ts";
import { indexRefreshStatus } from "./index-refresh.ts";

export async function knowledgeIndexOverview(tx: DbTx, s: Scope) {
  const active = await tx.knowledgeIndex.findFirst({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      state: "active",
    },
    select: { evaluation: true },
  });
  const refresh = await indexRefreshStatus(tx, s);
  const live = active ? await validateActiveIndexEvaluation(tx, s) : null;
  const evaluation = active?.evaluation as { executedAt?: string } | undefined;
  const state = live?.valid
    ? "current"
    : refresh.run?.status === "running"
      ? "refreshing"
      : refresh.run?.status === "failed"
        ? "action_required"
        : refresh.autoEnabled
          ? "waiting"
          : "manual";
  return {
    state,
    lastSuccessAt: refresh.lastSuccessAt ?? evaluation?.executedAt ?? null,
    nextAttemptAt: refresh.nextAttemptAt ?? null,
    stage: refresh.run?.status === "running" ? refresh.run.stage : null,
    marketingBlocked:
      effectiveRole(s, "marketing") !== "none" &&
      ownerEnabled("marketing", await enabledModules(tx, s)) &&
      live?.valid === false,
  };
}

import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data } from "../shared.ts";
import {
  activePolicyRecord,
  activeSpendPolicyRecord,
  requireSpendMandate,
} from "./spend-mandate.ts";
import { saveSpendPolicy } from "./spend-policy.ts";

// The backfill of ADR 0015: each project's active Marketing policy budget
// becomes a platform spending authority with the same limits and window.
// It only adds records; Marketing policies stay unchanged.

export type BackfillRow = {
  workspaceId: string;
  projectId: string;
  name: string;
  action: "create" | "skip_platform_exists" | "skip_no_policy" | "skip_invalid";
  sourcePolicyId?: string;
  limits?: {
    approvedPaidUse: boolean;
    dailyBudgetMicros: number;
    monthlyBudgetMicros: number;
    perRunBudgetMicros: number;
    startAt: string;
    endAt: string;
  };
  code?: string;
};

/** What the backfill would do (dry run) or did (`apply`), per project. */
export async function backfillSpendPolicies(
  options: { workspaceId?: string; apply?: boolean } = {},
): Promise<BackfillRow[]> {
  const projects = await authDb.project.findMany({
    where: options.workspaceId ? { workspaceId: options.workspaceId } : {},
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const rows: BackfillRow[] = [];
  for (const project of projects) {
    const base = {
      workspaceId: project.workspaceId,
      projectId: project.id,
      name: project.name,
    };
    // One transaction per project: the check and the write see the same state.
    rows.push(
      await scoped(project.workspaceId, project.id, async (tx) => {
        const scope = {
          workspaceId: project.workspaceId,
          projectId: project.id,
        } as Scope;
        if (await activeSpendPolicyRecord(tx, scope))
          return { ...base, action: "skip_platform_exists" as const };
        const policy = await activePolicyRecord(tx, scope);
        if (!policy) return { ...base, action: "skip_no_policy" as const };
        let mandate;
        try {
          mandate = await requireSpendMandate(tx, scope);
        } catch (error) {
          return {
            ...base,
            action: "skip_invalid" as const,
            sourcePolicyId: policy.id,
            code: (error as { code?: string }).code ?? "POLICY_INVALID",
          };
        }
        const limits = {
          approvedPaidUse: mandate.limits.approvedPaidTests,
          dailyBudgetMicros: mandate.limits.dailyBudgetMicros,
          monthlyBudgetMicros: mandate.limits.monthlyBudgetMicros,
          perRunBudgetMicros: mandate.limits.perRunBudgetMicros,
          startAt: mandate.limits.startAt,
          endAt: mandate.limits.endAt,
        };
        if (options.apply)
          // The record is attributed to whoever activated the source policy.
          await saveSpendPolicy(
            tx,
            {
              ...scope,
              userId: String(data(policy).activatedBy ?? "system"),
              role: "owner",
            },
            { profile: "custom", ...limits },
            { source: { id: policy.id, version: policy.version } },
          );
        return {
          ...base,
          action: "create" as const,
          sourcePolicyId: policy.id,
          limits,
        };
      }),
    );
  }
  return rows;
}

import type { RetentionContribution } from "../../governance/types.ts";

const DAY = 86_400_000;
/** Finished work orders are kept this long by default (plan T-4). */
export const WORK_ORDER_RETENTION_DAYS = 90;
/** Agent runs and their spans are kept this long by default (plan T-4). */
export const AGENT_RUN_RETENTION_DAYS = 180;

/**
 * Agent records under the project's retention action (ADR 0021, plan WP1.4).
 * The defaults are ceilings: a shorter project retention period purges
 * earlier, a longer one does not keep these records longer.
 *
 * - Work orders that finished before the cutoff, as whole delegation trees:
 *   a root is purged only when none of its descendants is unfinished or
 *   finished after the cutoff, and its descendants go with it (cascade). A
 *   work order that never finished is not purged here.
 * - Agent runs that started before the cutoff, with their spans (the span
 *   foreign key cascades). No other table has a foreign key to AgentRun:
 *   BudgetReservation, SupportMessage, WorkComment and the other
 *   `agentRunId` columns are plain references that stay as recorded, so no
 *   reservation or cost record is changed.
 */
export const agentWorkRetention: RetentionContribution = async (
  tx,
  scope,
  { cutoff, at },
) => {
  const later = (days: number) =>
    new Date(Math.max(cutoff.valueOf(), at.valueOf() - days * DAY));
  const workOrderCutoff = later(WORK_ORDER_RETENTION_DAYS);
  const runCutoff = later(AGENT_RUN_RETENTION_DAYS);
  // Whole trees only: a root (no parent) whose descendants, two levels at
  // most (ADR 0021), all finished before the cutoff. The cascade removes
  // the descendants with it.
  const workOrders = await tx.$executeRaw`
    DELETE FROM "AgentWorkOrder" w
     WHERE w."workspaceId" = ${scope.workspaceId}::uuid
       AND w."projectId" = ${scope.projectId}::uuid
       AND w."parentId" IS NULL
       AND w."finishedAt" < ${workOrderCutoff}
       AND NOT EXISTS (
         SELECT 1 FROM "AgentWorkOrder" d
           LEFT JOIN "AgentWorkOrder" p
             ON p."workspaceId" = d."workspaceId"
            AND p."projectId" = d."projectId"
            AND p."id" = d."parentId"
          WHERE d."workspaceId" = w."workspaceId"
            AND d."projectId" = w."projectId"
            AND (d."parentId" = w."id" OR d."rootId" = w."id" OR p."parentId" = w."id")
            AND (d."finishedAt" IS NULL OR d."finishedAt" >= ${workOrderCutoff})
       )`;
  const runs = await tx.agentRun.deleteMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      startedAt: { lt: runCutoff },
    },
  });
  const counts: Record<string, number> = {};
  if (workOrders) counts.agentWorkOrders = workOrders;
  if (runs.count) counts.agentRuns = runs.count;
  return {
    audit: counts,
    result: Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [
        "purged" + k[0]!.toUpperCase() + k.slice(1),
        v,
      ]),
    ),
  };
};

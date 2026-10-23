import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { sourceIndexStatus } from "../../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/**
 * Each source's search index state (plans/knowledge-indexing-repair.md)
 * with the project's newest work records, newest first, so a source shows
 * its pending and failed embedding jobs and their last error.
 */
export async function knowledgeIndexStatus(tx: DbTx, scope: Scope) {
  const jobs = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "jobs",
    },
    select: { data: true },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  return sourceIndexStatus(tx, scope, {
    jobs: jobs.map((job) => job.data as Record<string, unknown>),
  });
}

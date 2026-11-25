import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { data, DomainError } from "../shared.ts";
import { actorScope } from "../tenancy/member-scope.ts";

export const INDEX_REFRESH_RUNS = "knowledge_index_refresh_runs";

export const refreshRunWhere = (s: Scope) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
  kind: INDEX_REFRESH_RUNS,
});

export async function requireRefreshOwner(tx: DbTx, s: Scope, userId: string) {
  await assertModuleEnabled(tx, s, "knowledge");
  const actor = await actorScope(s.workspaceId, s.projectId, userId);
  if (actor?.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  return actor;
}

/** The normal manual jobs do not require a refresh run. Managed batches do. */
export async function assertManagedIndexRefresh(
  tx: DbTx,
  s: Scope,
  indexId: string,
) {
  const run = await tx.entity.findFirst({
    where: {
      ...refreshRunWhere(s),
      data: { path: ["indexId"], equals: indexId },
    },
  });
  if (!run) return;
  const value = data(run);
  if (value.status !== "running")
    throw new DomainError("INDEX_REFRESH_STOPPED", 409);
  await requireRefreshOwner(tx, s, value.ownerId);
}

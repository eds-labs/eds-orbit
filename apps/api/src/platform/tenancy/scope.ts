import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/**
 * A project-scoped transaction that also sets `app.user_id`, so row-level
 * security admits rows private to the acting user (the chat tables).
 */
export async function userScoped<T>(
  scope: Scope,
  work: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
    return work(tx);
  });
}

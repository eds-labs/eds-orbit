import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { publicEntity } from "../shared.ts";
import { unexportedKinds } from "../modules/contributions.ts";
import { hiddenKinds } from "../tenancy/module-roles.ts";

/**
 * The project export (WP1.8): every entity in its public projection, except
 * the kinds their owner declares `exported: false` (credentials, OAuth state,
 * evidence), and the kinds of modules the member has no access to (WP4.5).
 */
export async function exportProject(tx: DbTx, scope: Scope) {
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    entities: (
      await tx.entity.findMany({
        where: {
          projectId: scope.projectId,
          kind: { notIn: [...unexportedKinds(), ...hiddenKinds(scope)] },
        },
      })
    ).map(publicEntity),
  };
}

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";

// The social module is opt-in twice, like issues and finance: ORBIT_SOCIAL
// must be on for the installation, and the project's owner must have
// enabled the module (an explicit ProjectModule row).

/** True while the module is switched on for this installation (ORBIT_SOCIAL). */
export const socialSwitchedOn = () => loadConfig().ORBIT_SOCIAL === "true";

/** True when the module may run in the project. */
export async function socialActive(tx: DbTx, scope: Scope) {
  if (!socialSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "social",
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 SOCIAL_DISABLED unless the module may run in the project. */
export async function requireSocial(tx: DbTx, scope: Scope) {
  if (!(await socialActive(tx, scope)))
    throw new DomainError("SOCIAL_DISABLED", 404);
}

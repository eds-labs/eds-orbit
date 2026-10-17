import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";

// Support is opt-in twice (WP5.1): ORBIT_SUPPORT must be on for the
// installation, and the project's owner must have enabled the module. The
// explicit row matters because, while ORBIT_MODULES is off, the platform
// counts every module as enabled.

/** True while support is switched on for this installation (ORBIT_SUPPORT). */
export const supportSwitchedOn = () => loadConfig().ORBIT_SUPPORT === "true";

/** True when support may run in the project. */
export async function supportActive(tx: DbTx, scope: Scope) {
  if (!supportSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "support",
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 SUPPORT_DISABLED unless support may run in the project. */
export async function requireSupport(tx: DbTx, scope: Scope) {
  if (!(await supportActive(tx, scope)))
    throw new DomainError("SUPPORT_DISABLED", 404);
}

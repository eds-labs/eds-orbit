import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";
import { CMS_MODULE_ID } from "./manifest.ts";

// The content module is opt-in twice: ORBIT_CMS must be on for the
// installation, and the project's owner must have enabled the module (an
// explicit ProjectModule row).

/** True while the module is switched on for this installation (ORBIT_CMS). */
export const cmsSwitchedOn = () => loadConfig().ORBIT_CMS === "true";

/** True when the module may run in the project. */
export async function cmsActive(tx: DbTx, scope: Scope) {
  if (!cmsSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: CMS_MODULE_ID,
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 CMS_DISABLED unless the module may run in the project. */
export async function requireCms(tx: DbTx, scope: Scope) {
  if (!(await cmsActive(tx, scope))) throw new DomainError("CMS_DISABLED", 404);
}

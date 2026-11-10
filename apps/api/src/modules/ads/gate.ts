import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";
import { ADS_MODULE_ID } from "./manifest.ts";

// The ads module is opt-in twice: ORBIT_ADS must be on for the installation,
// and the project's owner must have enabled the module (an explicit
// ProjectModule row).

/** True while the module is switched on for this installation (ORBIT_ADS). */
export const adsSwitchedOn = () => loadConfig().ORBIT_ADS === "true";

/** True when the module may run in the project. */
export async function adsActive(tx: DbTx, scope: Scope) {
  if (!adsSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: ADS_MODULE_ID,
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 ADS_DISABLED unless the module may run in the project. */
export async function requireAds(tx: DbTx, scope: Scope) {
  if (!(await adsActive(tx, scope))) throw new DomainError("ADS_DISABLED", 404);
}

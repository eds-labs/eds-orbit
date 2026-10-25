import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";

// Project management is opt-in twice, like support and finance: ORBIT_WORK
// must be on for the installation, and the project's owner must have
// enabled the module (an explicit ProjectModule row).

/** True while the module is switched on for this installation (ORBIT_WORK). */
export const workSwitchedOn = () => loadConfig().ORBIT_WORK === "true";

/** True when the module may run in the project. */
export async function workActive(tx: DbTx, scope: Scope) {
  if (!workSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "work",
      },
    },
  });
  return row?.enabled === true;
}

/** True while the AI project manager is switched on (ORBIT_WORK_PM, ADR 0017). */
export const pmSwitchedOn = () =>
  workSwitchedOn() && loadConfig().ORBIT_WORK_PM === "true";

/** True when the AI project manager may run in the project. */
export async function pmActive(tx: DbTx, scope: Scope) {
  return pmSwitchedOn() && (await workActive(tx, scope));
}

/** Throws 404 WORK_PM_DISABLED unless the AI project manager may run. */
export async function requirePm(tx: DbTx, scope: Scope) {
  if (!(await pmActive(tx, scope)))
    throw new DomainError("WORK_PM_DISABLED", 404);
}

/** Throws 404 WORK_DISABLED unless the module may run in the project. */
export async function requireWork(tx: DbTx, scope: Scope) {
  if (!(await workActive(tx, scope)))
    throw new DomainError("WORK_DISABLED", 404);
}

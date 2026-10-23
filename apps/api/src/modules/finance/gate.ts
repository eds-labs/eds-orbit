import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";

// Finance is opt-in twice, like support: ORBIT_FINANCE must be on for the
// installation, and the project's owner must have enabled the module. The
// explicit row matters because, while ORBIT_MODULES is off, the platform
// counts every module as enabled.

/** True while finance is switched on for this installation (ORBIT_FINANCE). */
export const financeSwitchedOn = () => loadConfig().ORBIT_FINANCE === "true";

/** True when finance may run in the project. */
export async function financeActive(tx: DbTx, scope: Scope) {
  if (!financeSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "finance",
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 FINANCE_DISABLED unless finance may run in the project. */
export async function requireFinance(tx: DbTx, scope: Scope) {
  if (!(await financeActive(tx, scope)))
    throw new DomainError("FINANCE_DISABLED", 404);
}

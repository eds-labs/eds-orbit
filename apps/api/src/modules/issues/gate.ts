import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";

// The issue center is opt-in twice, like support, finance and work:
// ORBIT_ISSUES must be on for the installation, and the project's owner
// must have enabled the module (an explicit ProjectModule row).

/** True while the module is switched on for this installation (ORBIT_ISSUES). */
export const issuesSwitchedOn = () => loadConfig().ORBIT_ISSUES === "true";

/** True when the module may run in the project. */
export async function issuesActive(tx: DbTx, scope: Scope) {
  if (!issuesSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "issues",
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 ISSUES_DISABLED unless the module may run in the project. */
export async function requireIssues(tx: DbTx, scope: Scope) {
  if (!(await issuesActive(tx, scope)))
    throw new DomainError("ISSUES_DISABLED", 404);
}

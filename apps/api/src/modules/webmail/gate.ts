import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../../shared.ts";
import { webmailConfigured } from "./guard.ts";

// Webmail is opt-in twice, like finance: ORBIT_WEBMAIL must be on for the
// installation, and the project's owner must have enabled the module. The
// explicit row matters because, while ORBIT_MODULES is off, the platform
// counts every module as enabled.

/** True while webmail is switched on and configured for this installation. */
export const webmailSwitchedOn = () => webmailConfigured(loadConfig());

/** True when webmail may run in the project. */
export async function webmailActive(tx: DbTx, scope: Scope) {
  if (!webmailSwitchedOn()) return false;
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: "webmail",
      },
    },
  });
  return row?.enabled === true;
}

/** Throws 404 WEBMAIL_DISABLED unless webmail may run in the project. */
export async function requireWebmail(tx: DbTx, scope: Scope) {
  if (!(await webmailActive(tx, scope)))
    throw new DomainError("WEBMAIL_DISABLED", 404);
}

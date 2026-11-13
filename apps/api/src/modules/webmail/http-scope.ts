import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { requireWebmail } from "./gate.ts";

// How every webmail route runs: the member's permission in the module, then
// the module being on in the project (404 WEBMAIL_DISABLED), then one project
// transaction. WEBMAIL_USE only opens the module: the grant decides per mailbox.

export const WEBMAIL_BASE = "/api/projects/:projectId/webmail";

export type Params = Record<string, string> & { projectId: string };
type Req = Parameters<typeof scopeFor>[1];

export async function inWebmail<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireWebmail(tx, scope);
    return work(tx, scope, params);
  });
}

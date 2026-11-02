import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { requireSocial } from "./gate.ts";

// How every social route runs: the member's permission in the module, then
// the module being on in the project (404 SOCIAL_DISABLED), then one project
// transaction.

export const SOCIAL_BASE = "/api/projects/:projectId/social";

export type Params = Record<string, string> & { projectId: string };
type Req = Parameters<typeof scopeFor>[1];

export async function inSocial<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSocial(tx, scope);
    return work(tx, scope, params);
  });
}

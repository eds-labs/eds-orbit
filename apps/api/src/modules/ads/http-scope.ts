import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { requireAds } from "./gate.ts";
import { ADS_MODULE_ID } from "./manifest.ts";

// How every ads route runs: the member's permission in the module, then the
// module being on in the project (404 ADS_DISABLED), then one project
// transaction.

export const ADS_BASE = `/api/projects/:projectId/${ADS_MODULE_ID}`;

export type Params = Record<string, string> & { projectId: string };
type Req = Parameters<typeof scopeFor>[1];

export async function inAds<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireAds(tx, scope);
    return work(tx, scope, params);
  });
}

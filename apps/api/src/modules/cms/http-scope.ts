import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { requireCms } from "./gate.ts";
import { CMS_MODULE_ID } from "./manifest.ts";

// How every internal content route runs: the member's permission in the
// module, then the module being on in the project (404 CMS_DISABLED), then
// one project transaction. The versioned /api/v1 routes authenticate API
// keys instead (CH1.1, CH1.12).

export const CMS_BASE = `/api/projects/:projectId/${CMS_MODULE_ID}`;

export type Params = Record<string, string> & { projectId: string };
type Req = Parameters<typeof scopeFor>[1];

export async function inCms<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireCms(tx, scope);
    return work(tx, scope, params);
  });
}

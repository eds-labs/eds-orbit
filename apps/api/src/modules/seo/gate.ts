import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  entitled,
  entitlementsFor,
} from "../../platform/entitlements/entitlements.ts";
import { moduleScope } from "../../platform/tenancy/module-roles.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { DomainError } from "../../shared.ts";
import { SEO_MODULE_ID } from "./manifest.ts";

export const seoSwitchedOn = () => loadConfig().ORBIT_SEO === "true";

export async function requireSeoAccess(
  tx: DbTx,
  scope: Scope,
  permission: PermissionDef,
) {
  authorize(moduleScope(scope, SEO_MODULE_ID), permission);
  if (!seoSwitchedOn()) throw new DomainError("SEO_DISABLED", 404);
  const row = await tx.projectModule.findUnique({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: SEO_MODULE_ID,
      },
    },
    select: { enabled: true },
  });
  if (!row?.enabled) throw new DomainError("SEO_DISABLED", 404);
  const entitlements = await entitlementsFor(scope.workspaceId);
  if (!entitled(entitlements, { module: SEO_MODULE_ID }))
    throw new DomainError("SEO_ENTITLEMENT_REQUIRED", 403);
  return entitlements;
}

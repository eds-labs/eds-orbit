import { z } from "zod";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import {
  moduleAvailable,
  registeredRegistry,
} from "../modules/contributions.ts";

// Module-level roles (WP4.5, plans/orbit-modularization/07): a member's role
// in one module overrides the project role there; "none" hides the module.
// Owners always keep their role. Off unless ORBIT_MODULE_ROLES is "true".

export type ModuleRole = "editor" | "viewer" | "none";
export const moduleRole = z.enum(["editor", "viewer", "none"]);

export function moduleRolesEnabled() {
  return loadConfig().ORBIT_MODULE_ROLES === "true";
}

/** The member's role in a module: the override, else the project role. */
export function effectiveRole(
  scope: Scope,
  moduleId: string | undefined,
): Scope["role"] | "none" {
  if (!moduleId || moduleId === "platform" || scope.role === "owner")
    return scope.role;
  return scope.moduleRoles?.[moduleId] ?? scope.role;
}

/**
 * The scope a module's code runs with for this member: the effective role,
 * or 404 MODULE_NOT_AVAILABLE when the member has no access to the module.
 */
export function moduleScope(scope: Scope, moduleId: string | undefined): Scope {
  const role = effectiveRole(scope, moduleId);
  if (role === "none") throw new DomainError("MODULE_NOT_AVAILABLE", 404);
  return role === scope.role ? scope : { ...scope, role };
}

/**
 * The member's highest role in any module, for checks made before the module
 * is known: a viewer raised to editor in one module counts as an editor.
 */
export function highestRole(scope: Scope): Scope["role"] {
  if (scope.role !== "viewer") return scope.role;
  return Object.values(scope.moduleRoles ?? {}).includes("editor")
    ? "editor"
    : "viewer";
}

/** The modules the member has no access to (never any for owners). */
export function hiddenModules(scope: Scope): string[] {
  if (scope.role === "owner") return [];
  return Object.entries(scope.moduleRoles ?? {})
    .filter(([, role]) => role === "none")
    .map(([id]) => id);
}

/**
 * The entity kinds of the modules the member has no access to: the records
 * platform reads that span modules (export, dashboard) leave out.
 */
export function hiddenKinds(scope: Scope): string[] {
  const hidden = hiddenModules(scope);
  if (!hidden.length) return [];
  return [...registeredRegistry().kindOwner]
    .filter(([, owner]) => hidden.includes(owner))
    .map(([kind]) => kind);
}

/**
 * The modules the member may use, intersected with the project's enabled
 * modules: the set the platform filters tools, prompt fragments and
 * conversation sections by. Unchanged without a "none" override.
 */
export function visibleModules(
  scope: Scope,
  enabled?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  const hidden = hiddenModules(scope);
  if (!hidden.length) return enabled;
  const base = enabled ?? new Set(registeredRegistry().order);
  return new Set([...base].filter((id) => !hidden.includes(id)));
}

/** A member's module overrides, keyed by module (owners have none). */
export async function memberModuleRoles(projectId: string, userId: string) {
  const rows = await authDb.projectMemberModuleRole.findMany({
    where: { projectId, userId },
    orderBy: { moduleId: "asc" },
  });
  return Object.fromEntries(
    rows.map((row) => [row.moduleId, row.role as ModuleRole]),
  );
}

export const moduleRolesInput = z
  .object({
    // A module id with its role; null removes the override.
    roles: z.record(z.string(), moduleRole.nullable()),
  })
  .strict();

/**
 * Writes module overrides for a non-owner project member inside `tx`
 * (ADR 0013 administration and invitations). Unknown or unavailable modules
 * are refused; null removes an override. The caller authorizes and audits.
 */
export async function writeModuleRoles(
  tx: Pick<DbTx, "projectMemberModuleRole">,
  target: { workspaceId: string; projectId: string; userId: string },
  roles: Record<string, ModuleRole | null>,
  changedBy: string,
) {
  if (!Object.keys(roles).length) return;
  if (!moduleRolesEnabled())
    throw new DomainError("MODULE_ROLES_DISABLED", 409);
  const known = new Set(registeredRegistry().order.filter(moduleAvailable));
  for (const id of Object.keys(roles))
    if (!known.has(id)) throw new DomainError("MODULE_NOT_FOUND", 404);
  for (const [moduleId, role] of Object.entries(roles)) {
    if (role === null)
      await tx.projectMemberModuleRole.deleteMany({
        where: { projectId: target.projectId, userId: target.userId, moduleId },
      });
    else
      await tx.projectMemberModuleRole.upsert({
        where: {
          projectId_userId_moduleId: {
            projectId: target.projectId,
            userId: target.userId,
            moduleId,
          },
        },
        create: { ...target, moduleId, role, changedBy },
        update: { role, changedBy },
      });
  }
}

/**
 * Sets a member's module roles (project owners only, while the flag is on).
 * Owners cannot get overrides; unknown and unavailable modules are refused.
 * Audited.
 */
export async function setMemberModuleRoles(
  owner: Scope,
  userId: string,
  raw: unknown,
) {
  if (!moduleRolesEnabled()) throw new DomainError("NOT_FOUND", 404);
  if (owner.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const { roles } = moduleRolesInput.parse(raw);
  const known = new Set(registeredRegistry().order.filter(moduleAvailable));
  for (const id of Object.keys(roles))
    if (!known.has(id)) throw new DomainError("MODULE_NOT_FOUND", 404);
  const member = await authDb.projectMember.findUnique({
    where: { projectId_userId: { projectId: owner.projectId, userId } },
  });
  if (!member || member.workspaceId !== owner.workspaceId)
    throw new DomainError("MEMBER_NOT_FOUND", 404);
  if (member.role === "owner")
    throw new DomainError("OWNER_HAS_NO_MODULE_ROLES", 409);
  await authDb.$transaction(async (tx) => {
    for (const [moduleId, role] of Object.entries(roles)) {
      const key = {
        projectId_userId_moduleId: {
          projectId: owner.projectId,
          userId,
          moduleId,
        },
      };
      if (role === null)
        await tx.projectMemberModuleRole.deleteMany({
          where: { projectId: owner.projectId, userId, moduleId },
        });
      else
        await tx.projectMemberModuleRole.upsert({
          where: key,
          create: {
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            userId,
            moduleId,
            role,
            changedBy: owner.userId,
          },
          update: { role, changedBy: owner.userId },
        });
    }
  });
  const current = await memberModuleRoles(owner.projectId, userId);
  await scoped(owner.workspaceId, owner.projectId, (tx) =>
    audit(tx, owner, "member.module_role_changed", userId, {
      changes: roles,
      roles: current,
    }),
  );
  return { userId, roles: current };
}

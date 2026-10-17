import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { ValidatedRegistry } from "../../../../../packages/module-contracts/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import { moduleAvailable } from "./contributions.ts";

/** Owners may switch modules (ORBIT_MODULES); activation is not yet enforced. */
export function moduleSwitchingEnabled() {
  return loadConfig().ORBIT_MODULES === "true";
}

export type ModuleState = {
  id: string;
  displayName: { en: string; de: string };
  version: string;
  dependsOn: readonly string[];
  enabled: boolean;
  /** True when an owner or the migration recorded the choice; false: registry default. */
  explicit: boolean;
  changedBy: string | null;
  changedAt: string | null;
};

/**
 * Every available module with its state in the project, in dependency
 * order. A module without a ProjectModule row has its registry default; an
 * unavailable module (WP5.1) is left out, so it also counts as disabled.
 */
export async function listModuleStates(
  tx: DbTx,
  scope: Scope,
  registry: ValidatedRegistry,
): Promise<ModuleState[]> {
  const rows = await tx.projectModule.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  return registry.order.filter(moduleAvailable).map((id) => {
    const module = registry.modules.find((m) => m.id === id)!;
    const row = rows.find((r) => r.moduleId === id);
    return {
      id,
      displayName: module.displayName,
      version: module.version,
      dependsOn: module.dependsOn,
      enabled: row ? row.enabled : module.defaultEnabled,
      explicit: Boolean(row),
      changedBy: row?.changedBy ?? null,
      changedAt: row ? row.updatedAt.toISOString() : null,
    };
  });
}

/**
 * Enables or disables a module for the project. Enabling needs every module
 * it depends on enabled; disabling is refused while an enabled module
 * depends on it. Nothing is deleted: the row records the choice.
 */
export async function setModuleEnabled(
  tx: DbTx,
  scope: Scope,
  registry: ValidatedRegistry,
  moduleId: string,
  enabled: boolean,
): Promise<ModuleState[]> {
  const module = registry.modules.find((m) => m.id === moduleId);
  if (!module || !moduleAvailable(moduleId))
    throw new DomainError("MODULE_NOT_FOUND", 404);
  const states = await listModuleStates(tx, scope, registry);
  const current = states.find((s) => s.id === moduleId)!;
  if (enabled) {
    const missing = module.dependsOn.filter(
      (dep) => !states.find((s) => s.id === dep)?.enabled,
    );
    if (missing.length)
      throw new DomainError("MODULE_DEPENDENCY_DISABLED", 409);
  } else {
    const dependents = states.filter(
      (s) => s.enabled && s.dependsOn.includes(moduleId),
    );
    if (dependents.length) throw new DomainError("MODULE_REQUIRED", 409);
  }
  if (current.explicit && current.enabled === enabled) return states;
  await tx.projectModule.upsert({
    where: {
      workspaceId_projectId_moduleId: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId,
      },
    },
    create: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      moduleId,
      enabled,
      moduleVersion: module.version,
      changedBy: scope.userId,
    },
    update: { enabled, moduleVersion: module.version, changedBy: scope.userId },
  });
  await audit(
    tx,
    scope,
    enabled ? "module.enabled" : "module.disabled",
    moduleId,
    { previous: current.enabled, explicitBefore: current.explicit },
  );
  return listModuleStates(tx, scope, registry);
}

/** Records the registry defaults for a new project, as the migration did for existing ones. */
export async function recordDefaultModules(
  tx: DbTx,
  scope: Scope,
  registry: ValidatedRegistry,
) {
  await tx.projectModule.createMany({
    data: registry.modules
      .filter((m) => moduleAvailable(m.id))
      .map((m) => ({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId: m.id,
        enabled: m.defaultEnabled,
        moduleVersion: m.version,
        changedBy: scope.userId,
      })),
    skipDuplicates: true,
  });
}

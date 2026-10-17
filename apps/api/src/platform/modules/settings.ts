import type { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import { registeredRegistry } from "./contributions.ts";

// Module settings (WP5.1): each module's project settings live in its
// ProjectModule row, versioned. The module owns the schema and defaults;
// the platform stores, versions and audits them, never their values.

const where = (scope: Scope, moduleId: string) => ({
  workspaceId_projectId_moduleId: {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    moduleId,
  },
});

/** The module's settings in the project, or its defaults while none are saved. */
export async function readModuleSettings<T>(
  tx: DbTx,
  scope: Scope,
  moduleId: string,
  schema: z.ZodType<T>,
  defaults: () => T,
): Promise<{ settings: T; version: number }> {
  const row = await tx.projectModule.findUnique({
    where: where(scope, moduleId),
  });
  const stored = row?.settings as Record<string, unknown> | undefined;
  if (!row || !stored || !Object.keys(stored).length)
    return { settings: defaults(), version: row?.settingsVersion ?? 1 };
  // Settings saved by an older module version lack later keys: today's
  // defaults fill them, so a deploy that adds a setting stops nothing.
  return {
    settings: schema.parse(withDefaults(defaults(), stored)),
    version: row.settingsVersion,
  };
}

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Stored values over the defaults, object by object; arrays are replaced. */
function withDefaults(defaults: unknown, stored: unknown): unknown {
  if (!plain(defaults) || !plain(stored)) return stored;
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored))
    merged[key] = key in defaults ? withDefaults(defaults[key], value) : value;
  return merged;
}

/**
 * Saves the module's settings when `expectedVersion` is the stored version;
 * otherwise 409 SETTINGS_VERSION_CONFLICT. Audits the new version, not the
 * values.
 */
export async function writeModuleSettings<T>(
  tx: DbTx,
  scope: Scope,
  moduleId: string,
  schema: z.ZodType<T>,
  value: unknown,
  expectedVersion: number,
): Promise<{ settings: T; version: number }> {
  const module = registeredRegistry().modules.find((m) => m.id === moduleId);
  if (!module) throw new DomainError("MODULE_NOT_FOUND", 404);
  const settings = schema.parse(value);
  const row = await tx.projectModule.findUnique({
    where: where(scope, moduleId),
  });
  if ((row?.settingsVersion ?? 1) !== expectedVersion)
    throw new DomainError("SETTINGS_VERSION_CONFLICT", 409);
  const version = expectedVersion + 1;
  const json = settings as Prisma.InputJsonValue;
  if (row)
    await tx.projectModule.update({
      where: where(scope, moduleId),
      data: {
        settings: json,
        settingsVersion: version,
        changedBy: scope.userId,
      },
    });
  else
    await tx.projectModule.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        moduleId,
        enabled: module.defaultEnabled,
        moduleVersion: module.version,
        settings: json,
        settingsVersion: version,
        changedBy: scope.userId,
      },
    });
  await audit(tx, scope, "module.settings_changed", moduleId, {
    moduleId,
    version,
  });
  return { settings, version };
}

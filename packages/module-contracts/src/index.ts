// Module contracts for the Orbit Platform (ADR 0009, plans/orbit-modularization
// 03-module-contracts.md). Types and validation only, no runtime dependency on
// the apps: the API, the worker and later the web shell read the same shapes.
// Capability fields (routes, jobs, tools, action types, scheduler hooks) are
// added by the work packages that open those registries (WP1.6, WP2.1).
import { z } from "zod";

export const MODULE_ID = /^[a-z][a-z0-9_]{1,30}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ROLES = ["owner", "editor", "viewer"] as const;

export type ModuleId = string;
export type Role = (typeof ROLES)[number];

/** A kind in the shared Entity table and the module that owns its records. */
export type EntityKindDef = {
  kind: string;
  description: string;
};

/** A permission key, mapped to the existing project roles (AD-07). */
export type PermissionDef = {
  key: string;
  description: string;
  defaultRoles: readonly Role[];
  sensitive?: boolean;
};

/** The server side of a module, as registered in the static module registry. */
export type ServerModule = {
  id: ModuleId;
  version: string;
  displayName: { en: string; de: string };
  /** Hard dependencies: this module can be enabled only with these. */
  dependsOn: readonly ModuleId[];
  /** Enabled for existing projects when activation is introduced (WP1.4). */
  defaultEnabled: boolean;
  entityKinds: readonly EntityKindDef[];
  /** Physical tables owned by the module (RLS matrix, grants). */
  tables: readonly string[];
  permissions: readonly PermissionDef[];
};

const kindName = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);
const serverModuleSchema = z
  .object({
    id: z.string().regex(MODULE_ID),
    version: z.string().regex(SEMVER),
    displayName: z
      .object({ en: z.string().min(1), de: z.string().min(1) })
      .strict(),
    dependsOn: z.array(z.string().regex(MODULE_ID)),
    defaultEnabled: z.boolean(),
    entityKinds: z.array(
      z.object({ kind: kindName, description: z.string().min(1) }).strict(),
    ),
    tables: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)),
    permissions: z.array(
      z
        .object({
          key: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/),
          description: z.string().min(1),
          defaultRoles: z.array(z.enum(ROLES)),
          sensitive: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** What the platform itself owns, declared beside the modules. */
export type PlatformDeclaration = {
  entityKinds: readonly EntityKindDef[];
  tables: readonly string[];
};

/** A registry that passed validation, with the lookups the platform needs. */
export type ValidatedRegistry = {
  modules: readonly ServerModule[];
  /** Modules ordered so every module follows its dependencies. */
  order: readonly ModuleId[];
  /** Entity kind -> owning module id, or "platform". */
  kindOwner: ReadonlyMap<string, ModuleId | "platform">;
  /** Table -> owning module id, or "platform". */
  tableOwner: ReadonlyMap<string, ModuleId | "platform">;
};

export class RegistryError extends Error {
  constructor(public problems: string[]) {
    super(`MODULE_REGISTRY_INVALID: ${problems.join("; ")}`);
  }
}

/**
 * Checks the static module list once at startup: valid manifests, unique
 * ids, known and acyclic dependencies, and exactly one owner for every
 * entity kind, table and permission key. Throws RegistryError otherwise.
 */
export function validateRegistry(
  modules: readonly ServerModule[],
  platform: PlatformDeclaration,
): ValidatedRegistry {
  const problems: string[] = [];
  for (const m of modules) {
    const parsed = serverModuleSchema.safeParse(m);
    if (!parsed.success)
      problems.push(
        `${m.id ?? "?"}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`,
      );
  }
  const ids = new Set<string>();
  for (const m of modules) {
    if (ids.has(m.id)) problems.push(`duplicate module id ${m.id}`);
    ids.add(m.id);
    if (m.id === "platform") problems.push("module id platform is reserved");
  }
  for (const m of modules)
    for (const dep of m.dependsOn) {
      if (dep === m.id) problems.push(`${m.id} depends on itself`);
      else if (!ids.has(dep))
        problems.push(`${m.id} depends on unknown module ${dep}`);
    }
  // Kahn's algorithm; leftovers form a cycle.
  const order: string[] = [];
  const pending = new Map(
    modules.map((m) => [
      m.id,
      new Set(m.dependsOn.filter((d) => ids.has(d) && d !== m.id)),
    ]),
  );
  while (pending.size) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length) {
      problems.push(
        `dependency cycle among ${[...pending.keys()].sort().join(", ")}`,
      );
      break;
    }
    for (const id of ready) {
      order.push(id);
      pending.delete(id);
      for (const deps of pending.values()) deps.delete(id);
    }
  }
  const claim = (
    map: Map<string, string>,
    what: string,
    name: string,
    owner: string,
  ) => {
    const prior = map.get(name);
    if (prior)
      problems.push(`${what} ${name} claimed by ${prior} and ${owner}`);
    else map.set(name, owner);
  };
  const kindOwner = new Map<string, string>();
  const tableOwner = new Map<string, string>();
  const permissionOwner = new Map<string, string>();
  for (const def of platform.entityKinds)
    claim(kindOwner, "entity kind", def.kind, "platform");
  for (const table of platform.tables)
    claim(tableOwner, "table", table, "platform");
  for (const m of modules) {
    for (const def of m.entityKinds)
      claim(kindOwner, "entity kind", def.kind, m.id);
    for (const table of m.tables) claim(tableOwner, "table", table, m.id);
    for (const p of m.permissions) {
      if (!p.key.startsWith(m.id + "."))
        problems.push(`permission ${p.key} of ${m.id} lacks the module prefix`);
      claim(permissionOwner, "permission", p.key, m.id);
    }
  }
  if (problems.length) throw new RegistryError(problems);
  return { modules, order, kindOwner, tableOwner };
}

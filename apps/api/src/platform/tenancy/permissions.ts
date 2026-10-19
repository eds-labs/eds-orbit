import type {
  PermissionDef,
  Role,
} from "../../../../../packages/module-contracts/src/index.ts";
import { DomainError } from "../shared.ts";

/**
 * The permission catalogue (ADR 0009, AD-07). Keys are declared by the
 * platform and by modules and mapped to the three project roles; modules
 * pass the definition itself, so a check never depends on a runtime lookup.
 * The first catalogue reproduces the role checks Orbit had before it.
 */
const ALL: readonly Role[] = ["owner", "editor", "viewer"];
const WRITERS: readonly Role[] = ["owner", "editor"];
const OWNERS: readonly Role[] = ["owner"];

export function permission(
  key: string,
  description: string,
  defaultRoles: readonly Role[],
): PermissionDef {
  return { key, description, defaultRoles };
}

/** Any project member may read. */
export const PROJECT_READ = permission(
  "platform.project.read",
  "Read the project",
  ALL,
);
/** Owners and editors may change project content. */
export const PROJECT_WRITE = permission(
  "platform.project.write",
  "Change project content",
  WRITERS,
);
/** Owners administer the project. */
export const PROJECT_OWN = permission(
  "platform.project.own",
  "Administer the project",
  OWNERS,
);

export function can(scope: { role: Role }, required: PermissionDef) {
  return required.defaultRoles.includes(scope.role);
}

/** Throws `code` (403) unless the scope's role holds the permission. */
export function authorize(
  scope: { role: Role },
  required: PermissionDef,
  code = "FORBIDDEN",
) {
  if (!can(scope, required)) throw new DomainError(code, 403);
}

/**
 * One permission per action of POST /api/projects/:id/actions/:action, keyed
 * `<module>.action.<name>`: owner-only, writer (owner and editor) or read
 * (any member).
 */
export function actionPermissions(
  module: string,
  groups: { owner?: string[]; write?: string[]; read?: string[] },
): Record<string, PermissionDef> {
  const entries: [string, PermissionDef][] = [];
  for (const [roles, names] of [
    [OWNERS, groups.owner ?? []],
    [WRITERS, groups.write ?? []],
    [ALL, groups.read ?? []],
  ] as const)
    for (const name of names)
      entries.push([
        name,
        permission(
          `${module}.action.${name.replaceAll("-", "_")}`,
          `Action ${name}`,
          roles,
        ),
      ]);
  return Object.fromEntries(entries);
}

export const platformActionPermissions = actionPermissions("platform", {
  owner: [
    "add-member",
    "ai-provider-configure",
    "connector",
    "connector-health",
    "email-connect",
    "email-disconnect",
    "openai-configure",
    "pause",
    "project-settings",
    "resolve-exception",
    "retention",
  ],
});

/** Everything the platform declares, for the registry's uniqueness check. */
export const platformPermissions: readonly PermissionDef[] = [
  PROJECT_READ,
  PROJECT_WRITE,
  PROJECT_OWN,
  ...Object.values(platformActionPermissions),
];

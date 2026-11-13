import type {
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
} from "./types";

// URL scheme of the settings center:
//   /manage                          picks a scope (see defaultScope)
//   /manage/system[/<area>/…]        system
//   /manage/o/:orgId[/<area>/…]      organization
//   /manage/p/:projectId[/<area>/…]  project
//   /manage/me[/<area>/…]            account

/** Reads the already decoded segments after "manage"; null is not a scope. */
export function parseManagePath(
  parts: readonly string[],
): ManageTarget | null {
  const [first, ...tail] = parts;
  if (first === undefined) return { scope: null, area: null, rest: [] };
  const target = (scope: ManageScope, after: readonly string[]) => ({
    scope,
    area: after[0] ?? null,
    rest: after.slice(1),
  });
  if (first === "system") return target({ kind: "system" }, tail);
  if (first === "me") return target({ kind: "account" }, tail);
  if (first === "o" || first === "p") {
    const [id, ...after] = tail;
    if (!id) return null;
    return target(
      first === "o"
        ? { kind: "organization", organizationId: id }
        : { kind: "project", projectId: id },
      after,
    );
  }
  return null;
}

/** The address of a scope, optionally of an area and below. */
export function manageHref(
  scope: ManageScope,
  area?: string,
  ...rest: string[]
): string {
  const head =
    scope.kind === "system"
      ? ["system"]
      : scope.kind === "account"
        ? ["me"]
        : scope.kind === "organization"
          ? ["o", scope.organizationId]
          : ["p", scope.projectId];
  const tail = area ? [area, ...rest] : [];
  return ["/manage", ...[...head, ...tail].map(encodeURIComponent)].join("/");
}

export function scopeKey(scope: ManageScope): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "account":
      return "me";
    case "organization":
      return `o:${scope.organizationId}`;
    case "project":
      return `p:${scope.projectId}`;
  }
}

/** Where a bare /manage leads: the last project, else the first scope held. */
export function defaultScope(
  caps: ManagementCapabilities,
  lastProjectId: string | null,
): ManageScope | null {
  const project =
    caps.projects.find((p) => p.id === lastProjectId) ?? caps.projects[0];
  if (project) return { kind: "project", projectId: project.id };
  if (caps.account.length) return { kind: "account" };
  if (caps.system.length) return { kind: "system" };
  const organization = caps.organizations[0];
  return organization
    ? { kind: "organization", organizationId: organization.id }
    : null;
}

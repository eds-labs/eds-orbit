import { manageHref } from "../routes";
import type { ManageScope, ManagementCapabilities, ScopeKind } from "../types";
import { setupOffers } from "./catalog";
import type { CatalogEntry, IntegrationState } from "./types";

// The pure rules of the guided setup: which steps an entry has in a scope,
// whose they are and whether they are done. The setup page and the catalog's
// "Set up" link both read them, so there is one rule table. Display hints
// only: every write keeps its server check.

// A value of a newer API must not break the page.
export const storageOf = (entry: CatalogEntry): readonly string[] =>
  Array.isArray(entry.storage) ? entry.storage : [];

export type SetupStepId = "choose" | "configure" | "check" | "authorize" | "assign" | "validate";
export type SetupWho = "admin" | "owner" | "projectOwner" | "anyone";
export type SetupStep = {
  id: SetupStepId;
  who: SetupWho;
  done: boolean;
  mine: boolean;
  href: string | null;
  /**
   * Whether this scope can see the step's result. A step that is not
   * observable is never done and never current; it follows in the project.
   */
  observable: boolean;
};
export type SetupRole = { admin: boolean; organizationOwner: boolean; projectOwner: boolean };

export function setupSteps(input: {
  scope: ScopeKind;
  entry: CatalogEntry;
  role: SetupRole;
  /** States of the provider's records as the server sent them, in the current scope. */
  states: readonly IntegrationState[];
  granted: boolean;
  bound: boolean;
  /** Project scope: a record of this provider with scope "project" exists; else false. */
  projectStored: boolean;
  links: { organization: string | null; project: string | null };
}): SetupStep[] {
  const { scope, entry, role, states, granted, bound, projectStored, links } = input;
  const central = storageOf(entry).includes("central");
  // A project runs a project-only entry, or its own record of an entry with
  // both storages, without anything from the organization (ledger P3-R22).
  const ownRecord = scope === "project" && (!central || projectStored);
  const configureWho: SetupWho =
    scope === "system" ? "admin" : ownRecord ? "projectOwner" : "owner";
  const covers = (who: SetupWho) =>
    who === "anyone" ||
    (who === "admin" && role.admin) ||
    (who === "owner" && role.organizationOwner) ||
    (who === "projectOwner" && (role.projectOwner || role.organizationOwner));
  // Where a step is done: an owner's in the organization, a project owner's in
  // the project, an administrator's in the system; "anyone" here.
  const doneIn = (who: SetupWho): ScopeKind =>
    who === "owner" ? "organization" : who === "projectOwner" ? "project" : who === "admin" ? "system" : scope;
  // A link leads to where the step is done when that is another scope the
  // member may open, whoever's step it is (ledger P3-R26 V5); a step done in
  // this scope has none.
  const linkOf = (who: SetupWho) =>
    doneIn(who) === scope
      ? null
      : who === "owner"
        ? links.organization
        : who === "projectOwner"
          ? links.project
          : null;
  const step = (
    id: SetupStepId,
    who: SetupWho,
    done: boolean,
    observable = true,
  ): SetupStep => {
    const mine = covers(who);
    return {
      id,
      who,
      done: observable && done,
      mine,
      href: linkOf(who),
      observable,
    };
  };
  // A state newer than this build counts as set up, never as checked.
  const some = (...wanted: string[]) => states.some((s) => wanted.includes(s));
  // A system administrator does not see project bindings (by design), and an
  // organization sees bindings but not a project's final check.
  return [
    step("choose", "anyone", true),
    step("configure", configureWho, states.some((s) => s !== "not_set_up")),
    step("check", configureWho, some("verified", "ready")),
    ...(central && !ownRecord
      ? [step("authorize", scope === "system" ? "admin" : "owner", granted)]
      : []),
    step("assign", "projectOwner", bound, scope !== "system"),
    step("validate", "projectOwner", some("ready"), scope === "project"),
  ];
}

/**
 * Who the member is for the step list, from the capabilities answer: each
 * role by a capability only that role receives (apps/api management
 * capabilities). `system.connections` only system administrators;
 * `organization.connections` only owners of that organization;
 * `project.members` only project owners (an organization owner is owner of
 * every project of it), never editors or viewers. With ORBIT_ADMINISTRATION
 * off the server lists no organization at all, so an organization owner then
 * reads here as a project owner only.
 */
export function setupRole(
  scope: ManageScope,
  caps: ManagementCapabilities | null | undefined,
): SetupRole {
  if (!caps) return { admin: false, organizationOwner: false, projectOwner: false };
  const admin = caps.system.includes("system.connections");
  const ownsOrganization = (id: string) =>
    caps.organizations.some(
      (o) => o.id === id && o.capabilities.includes("organization.connections"),
    );
  switch (scope.kind) {
    case "organization":
      return { admin, organizationOwner: ownsOrganization(scope.organizationId), projectOwner: false };
    case "project": {
      const project = caps.projects.find((p) => p.id === scope.projectId);
      return {
        admin,
        organizationOwner: project ? ownsOrganization(project.workspaceId) : false,
        projectOwner: project?.capabilities.includes("project.members") ?? false,
      };
    }
    // No single organization or project is meant in the system scope.
    default:
      return { admin, organizationOwner: false, projectOwner: false };
  }
}

/**
 * Where another scope's steps are done. Only a project has one organization
 * to point to, and only when the member may open its setup; the member is
 * already in the project, and the system and an organization have no single
 * target. The organization link exists only when the member owns the
 * organization: its steps are then their own, done there, and "Open" leads
 * to them.
 */
export function setupLinks(
  scope: ManageScope,
  entryId: string,
  caps: ManagementCapabilities | null | undefined,
): { organization: string | null; project: string | null } {
  if (scope.kind !== "project" || !caps) return { organization: null, project: null };
  const project = caps.projects.find((p) => p.id === scope.projectId);
  const organization = project
    ? caps.organizations.find(
        (o) =>
          o.id === project.workspaceId &&
          o.capabilities.includes("organization.connections"),
      )
    : undefined;
  return {
    organization: organization
      ? manageHref(
          { kind: "organization", organizationId: organization.id },
          "integrations",
          "setup",
          entryId,
        )
      : null,
    project: null,
  };
}

/**
 * Whether the member holds a step of the entry in the scope: the catalog
 * offers "Set up" only then. "choose" is everyone's and does not count.
 */
export function hasOwnStep(
  entry: CatalogEntry,
  scope: ManageScope,
  caps: ManagementCapabilities | null | undefined,
): boolean {
  return setupSteps({
    scope: scope.kind,
    entry,
    role: setupRole(scope, caps),
    states: [],
    granted: false,
    bound: false,
    projectStored: false,
    links: { organization: null, project: null },
  }).some((step) => step.who !== "anyone" && step.mine);
}

export { setupOffers };

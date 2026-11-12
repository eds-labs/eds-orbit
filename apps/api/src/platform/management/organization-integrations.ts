import { authDb, scopedRead } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { connectionsEnabled } from "../connections/central.ts";
import {
  integrationState,
  type IntegrationCategory,
  type IntegrationState,
} from "../connections/integrations.ts";
import { businessProjectsWhere, projectMembership } from "../tenancy/member-scope.ts";
import { catalogCategories } from "./integration-catalog.ts";
import {
  projectIntegrationRecords,
  publicIntegration,
  type ContributionFailure,
  type ProjectIntegration,
  type ProjectIntegrationRecord,
} from "./project-integrations.ts";

// Which central connections and project integrations an organization's
// projects use (ADR 0027, D-4). For the organization's owners only; the
// caller checks ownership. Metadata only: every field is picked explicitly,
// so no secret, config or health payload can reach the answer. Personal
// spaces and other organizations never appear.

export type OrganizationIntegrations = {
  connections: Array<{
    id: string;
    provider: string;
    label: string;
    category: IntegrationCategory;
    scope: "system" | "workspace";
    state: IntegrationState;
    checkedAt: string | null;
    /** Projects of this organization holding an active grant of it. */
    projects: Array<{ id: string; name: string; bound: boolean }>;
  }>;
  projects: Array<{ id: string; name: string; integrations: ProjectIntegration[] }>;
};

const byName = <T extends { id: string }>(name: (x: T) => string) => (a: T, b: T) =>
  name(a).localeCompare(name(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Called with the project id when a module's contribution throws. */
export type OrganizationContributionFailure = (
  projectId: string,
  ...failure: Parameters<ContributionFailure>
) => void;

export async function organizationIntegrations(
  userId: string,
  workspaceId: string,
  onFailure?: OrganizationContributionFailure,
): Promise<OrganizationIntegrations> {
  // The organization's business projects, each read with the owner's own
  // membership, exactly as the project route reads it.
  const rows = await authDb.project.findMany({
    where: { workspaceId, ...businessProjectsWhere(userId) },
    select: { id: true, name: true },
  });
  const projects: Array<{ id: string; name: string; records: ProjectIntegrationRecord[] }> = [];
  for (const project of rows.sort(byName((x) => x.name))) {
    const membership = await projectMembership(project.id, userId);
    if (!membership?.role || membership.workspaceId !== workspaceId) continue;
    const scope: Scope = {
      workspaceId,
      projectId: project.id,
      userId,
      role: membership.role,
      ...(membership.moduleRoles ? { moduleRoles: membership.moduleRoles } : {}),
    };
    const records = await scopedRead(workspaceId, project.id, (tx) =>
      projectIntegrationRecords(tx, scope, (moduleId, error) => onFailure?.(project.id, moduleId, error)),
    );
    projects.push({ id: project.id, name: project.name, records });
  }

  return {
    connections: connectionsEnabled() ? await connectionUsage(workspaceId, projects) : [],
    projects: projects.map((p) => ({ id: p.id, name: p.name, integrations: p.records.map(publicIntegration) })),
  };
}

/**
 * The connections an owner manages or uses (the set listConnections gives an
 * owner), read on the control plane. Unlike the project read, nothing hides a
 * disabled connection here, so `disabled` comes from `disabledAt`.
 */
async function connectionUsage(
  workspaceId: string,
  projects: Array<{ id: string; name: string; records: ProjectIntegrationRecord[] }>,
): Promise<OrganizationIntegrations["connections"]> {
  const rows = await authDb.connection.findMany({
    where: {
      revokedAt: null,
      OR: [
        { scope: "workspace", workspaceId },
        { scope: "system", grants: { some: { workspaceId, projectId: null, revokedAt: null } } },
      ],
    },
    select: {
      id: true,
      provider: true,
      label: true,
      scope: true,
      status: true,
      disabledAt: true,
      health: true,
      // Only this organization's active project grants.
      grants: {
        where: { workspaceId, revokedAt: null, projectId: { not: null } },
        select: { projectId: true },
      },
    },
  });
  const categories = catalogCategories();
  return rows
    .map((c) => {
      const scope = c.scope === "system" ? ("system" as const) : ("workspace" as const);
      const at = (c.health as { at?: unknown } | null)?.at;
      const granted = new Set(c.grants.map((g) => g.projectId));
      return {
        id: c.id,
        provider: c.provider,
        label: c.label,
        category: categories.get(c.provider) ?? "other",
        scope,
        state: integrationState({
          kind: "central",
          status: c.status,
          disabled: Boolean(c.disabledAt),
          revoked: false,
          grant: scope === "system" ? "active" : "none",
          binding: "not_needed",
        }),
        checkedAt: typeof at === "string" ? at : null,
        // Only the projects listed above: a grant on a personal space or on a
        // project the owner cannot read never surfaces its id or name.
        projects: projects
          .filter((p) => granted.has(p.id))
          .map((p) => ({
            id: p.id,
            name: p.name,
            bound: p.records.some((r) => r.connectionId === c.id && r.bound),
          })),
      };
    })
    .sort(byName((x) => x.label));
}

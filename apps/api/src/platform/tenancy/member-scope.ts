import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { moduleRolesEnabled } from "./module-roles.ts";

/**
 * Who may reach a project at all (ADR 0022): workspace owners every business
 * project and library, members their projects, and a personal space only
 * its own user (a membership row and `personalUserId` both). Org owners and
 * system administrators get no implicit access to someone's personal space.
 */
export function accessibleProjectsWhere(userId: string) {
  return {
    OR: [
      {
        kind: { not: "personal" },
        workspace: { members: { some: { userId, role: "owner" } } },
      },
      { kind: { not: "personal" }, members: { some: { userId } } },
      { kind: "personal", personalUserId: userId, members: { some: { userId } } },
    ],
  };
}

/**
 * The business projects a user may reach, for lists and cross-project
 * summaries: every accessible project except personal spaces, which no
 * business list shows (ADR 0022). The own personal space is reached through
 * the assistant only.
 */
export function businessProjectsWhere(userId: string) {
  return {
    kind: { not: "personal" },
    OR: [
      { workspace: { members: { some: { userId, role: "owner" } } } },
      { members: { some: { userId } } },
    ],
  };
}

/**
 * A user's current access to a project: workspace owners act as project
 * owners of business projects, everyone else needs a project membership,
 * and a personal space admits only its own user (ADR 0022). Null without
 * access, and always null for a deactivated user (ADR 0013): this one check
 * covers API requests, the worker's actor checks and the MCP principal.
 */
export async function projectMembership(projectId: string, userId: string) {
  const active = await authDb.user.findFirst({
    where: { id: userId, banned: false },
    select: { id: true },
  });
  if (!active) return null;
  const project = await authDb.project.findFirst({
    where: { id: projectId, ...accessibleProjectsWhere(userId) },
    include: {
      members: {
        where: { userId },
        // Module-level roles (WP4.5), read only while the flag is on.
        ...(moduleRolesEnabled() ? { include: { moduleRoles: true } } : {}),
      },
      workspace: { include: { members: { where: { userId } } } },
    },
  });
  if (!project) return null;
  // A personal space's owner role comes from its own membership only.
  const role =
    project.kind !== "personal" &&
    project.workspace.members.find((x) => x.role === "owner")
    ? "owner"
    : (project.members[0]?.role as Scope["role"] | undefined);
  // Owners keep their role in every module; overrides apply to the others.
  const rows =
    role && role !== "owner"
      ? ((
          project.members[0] as {
            moduleRoles?: Array<{ moduleId: string; role: string }>;
          }
        )?.moduleRoles ?? [])
      : [];
  const moduleRoles = rows.length
    ? (Object.fromEntries(rows.map((r) => [r.moduleId, r.role])) as NonNullable<
        Scope["moduleRoles"]
      >)
    : undefined;
  return {
    workspaceId: project.workspaceId,
    role,
    ...(moduleRoles ? { moduleRoles } : {}),
  };
}

/**
 * Scope of the user who queued a job, read again when the job runs. The
 * worker's own infrastructure role never stands in for the user's role.
 */
export async function actorScope(
  workspaceId: string,
  projectId: string,
  userId: string,
): Promise<Scope | null> {
  const membership = await projectMembership(projectId, userId);
  if (!membership?.role || membership.workspaceId !== workspaceId) return null;
  return {
    workspaceId,
    projectId,
    userId,
    role: membership.role,
    ...(membership.moduleRoles ? { moduleRoles: membership.moduleRoles } : {}),
  };
}

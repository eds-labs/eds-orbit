import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { moduleRolesEnabled } from "./module-roles.ts";

/**
 * A user's current access to a project: workspace owners act as project
 * owners, everyone else needs a project membership. Null without access,
 * and always null for a deactivated user (ADR 0013): this one check covers
 * API requests, the worker's actor checks and the MCP principal.
 */
export async function projectMembership(projectId: string, userId: string) {
  const active = await authDb.user.findFirst({
    where: { id: userId, banned: false },
    select: { id: true },
  });
  if (!active) return null;
  const project = await authDb.project.findFirst({
    where: {
      id: projectId,
      OR: [
        {
          workspace: { members: { some: { userId, role: "owner" } } },
        },
        { members: { some: { userId } } },
      ],
    },
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
  const role = project.workspace.members.find((x) => x.role === "owner")
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

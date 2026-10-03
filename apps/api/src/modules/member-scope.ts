import { authDb } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";

/**
 * A user's current access to a project: workspace owners act as project
 * owners, everyone else needs a project membership. Null without access.
 */
export async function projectMembership(projectId: string, userId: string) {
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
      members: { where: { userId } },
      workspace: { include: { members: { where: { userId } } } },
    },
  });
  if (!project) return null;
  const role = project.workspace.members.find((x) => x.role === "owner")
    ? "owner"
    : (project.members[0]?.role as Scope["role"] | undefined);
  return { workspaceId: project.workspaceId, role };
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
  return { workspaceId, projectId, userId, role: membership.role };
}

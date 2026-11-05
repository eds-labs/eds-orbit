import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { accessibleBusinessProjects } from "../agents/project-reads.ts";
import { isProjectRefusal, projectMemberScope } from "../agents/project-calls.ts";

// Reads across the user's business projects for digests, briefings and the
// cross-project summary (ADR 0023 item 2): one project at a time, each in
// its own transaction with the user's current scope there, never a write
// and never one transaction around several projects. A project the user
// lost access to since the list was read contributes nothing.

export type ProjectRead<T> = { projectId: string; projectName: string; value: T };

export async function readUserProjects<T>(
  input: { workspaceId: string; userId: string; projectIds?: readonly string[] | null },
  read: (tx: DbTx, member: Scope, project: { id: string; name: string }) => Promise<T>,
  options: { userRows?: boolean } = {},
): Promise<ProjectRead<T>[]> {
  const { projects } = await accessibleBusinessProjects(input.workspaceId, input.userId);
  const wanted = input.projectIds?.length
    ? projects.filter((p) => input.projectIds!.includes(p.id))
    : projects;
  const out: ProjectRead<T>[] = [];
  for (const project of wanted) {
    let member: Scope;
    try {
      member = await projectMemberScope({
        workspaceId: input.workspaceId,
        userId: input.userId,
        projectId: project.id,
        businessOnly: true,
      });
    } catch (error) {
      if (isProjectRefusal(error)) continue;
      throw error;
    }
    const value = await scoped(input.workspaceId, project.id, async (tx) => {
      // Notices are private to their member (row-level security).
      if (options.userRows)
        await tx.$executeRaw`SELECT set_config('app.user_id',${input.userId},true)`;
      return read(tx, member, project);
    });
    out.push({ projectId: project.id, projectName: project.name, value });
  }
  return out;
}

/** The user's account fields the senders need: address, language, whether active. */
export async function userContact(userId: string) {
  const user = await authDb.user.findUnique({
    where: { id: userId },
    select: { email: true, locale: true, banned: true },
  });
  if (!user || user.banned) return null;
  return { email: user.email, locale: (user.locale === "de" ? "de" : "en") as "en" | "de" };
}

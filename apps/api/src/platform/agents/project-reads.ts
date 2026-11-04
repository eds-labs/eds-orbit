/**
 * Cross-project reads for user tools (ADR 0022, plan agent-platform-phase-3
 * §2.2): the pattern of GET /api/action-requests/summary as a helper. Each
 * project is read one at a time, in its own `scoped()` transaction, with the
 * member's current scope there (actorScope), inside `inProjectCall`, so no
 * project's rules or locks reach into another. Every value is labelled with
 * its project; a project without access contributes only a refusal code,
 * and a project the user may not reach is never named.
 */
import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { businessProjectsWhere } from "../tenancy/member-scope.ts";
import {
  inProjectCall,
  isProjectRefusal,
  projectMemberScope,
  type ProjectRefusalCode,
} from "./project-calls.ts";

/** Projects one cross-project read covers at most (plan R3-2). */
export const PERSONAL_PROJECT_LIMIT = 50;

export type ProjectRef = { id: string; name: string };

/** A value read in one project, labelled with it. */
export type ProjectValue<T> = { projectId: string; projectName: string; value: T };
/**
 * A project that contributed nothing: the code only. The name is given only
 * for a project the user may reach (`projects_list` shows it anyway).
 */
export type ProjectRefusal = {
  projectId: string;
  projectName?: string;
  refusal: ProjectRefusalCode;
};
export type PerProject<T> = ProjectValue<T> | ProjectRefusal;

export const isRefusal = <T>(entry: PerProject<T>): entry is ProjectRefusal =>
  "refusal" in entry;

/**
 * The business projects the user may reach in the workspace (never a
 * personal space), by name then id, at most `limit`, with whether more
 * exist.
 */
export async function accessibleBusinessProjects(
  workspaceId: string,
  userId: string,
  limit = PERSONAL_PROJECT_LIMIT,
): Promise<{ projects: ProjectRef[]; truncated: boolean }> {
  const rows = await authDb.project.findMany({
    where: { workspaceId, ...businessProjectsWhere(userId) },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return { projects: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Reads every requested project (all accessible business projects when
 * none are named), one at a time, each in its own transaction with the
 * member's scope there. A requested project outside the user's reach is a
 * PROJECT_FORBIDDEN refusal without a name; `read` refuses a part it may not
 * show by throwing ProjectCallRefused. Other errors fail the read.
 */
export async function readEachProject<T>(
  input: {
    workspaceId: string;
    userId: string;
    projectIds?: readonly string[] | null;
  },
  read: (tx: DbTx, scope: Scope, project: ProjectRef) => Promise<T>,
): Promise<PerProject<T>[]> {
  const { projects } = await accessibleBusinessProjects(
    input.workspaceId,
    input.userId,
  );
  const byId = new Map(projects.map((project) => [project.id, project]));
  const wanted = input.projectIds?.length
    ? [...new Set(input.projectIds)].slice(0, PERSONAL_PROJECT_LIMIT)
    : projects.map((project) => project.id);
  const out: PerProject<T>[] = [];
  for (const projectId of wanted) {
    const project = byId.get(projectId);
    if (!project) {
      out.push({ projectId, refusal: "PROJECT_FORBIDDEN" });
      continue;
    }
    out.push(await readOneProject(input, project, read));
  }
  return out;
}

async function readOneProject<T>(
  input: { workspaceId: string; userId: string },
  project: ProjectRef,
  read: (tx: DbTx, scope: Scope, project: ProjectRef) => Promise<T>,
): Promise<PerProject<T>> {
  return inProjectCall(project.id, async () => {
    let scope: Scope;
    try {
      scope = await projectMemberScope({
        ...input,
        projectId: project.id,
        businessOnly: true,
      });
    } catch (error) {
      // Access lost since the list was read: no name.
      if (isProjectRefusal(error))
        return { projectId: project.id, refusal: error.refusal };
      throw error;
    }
    try {
      const value = await scoped(scope.workspaceId, project.id, (tx) =>
        read(tx, scope, project),
      );
      return { projectId: project.id, projectName: project.name, value };
    } catch (error) {
      if (isProjectRefusal(error))
        return {
          projectId: project.id,
          projectName: project.name,
          refusal: error.refusal,
        };
      throw error;
    }
  });
}

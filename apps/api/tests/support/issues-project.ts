import { randomUUID } from "node:crypto";
import { authDb, scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";

/**
 * A synthetic project for the issue center (ADR 0018): an owner, an editor
 * and a viewer, with the given modules enabled (issues by default). No
 * test reaches a provider.
 */
export async function createIssuesProject(
  options: { name?: string; modules?: string[] } = {},
) {
  const users: string[] = [];
  const user = async (role: string) => {
    const row = await authDb.user.create({
      data: { id: randomUUID(), name: `Synthetic issues ${role}`, email: `${randomUUID()}@example.invalid` },
    });
    users.push(row.id);
    return row.id;
  };
  const [o, e, v] = [await user("owner"), await user("editor"), await user("viewer")];
  const workspace = await authDb.workspace.create({
    data: {
      name: options.name ?? "Synthetic issues",
      members: { create: [
        { userId: o, role: "owner" },
        { userId: e, role: "viewer" },
        { userId: v, role: "viewer" },
      ] },
    },
  });
  const project = await authDb.project.create({
    data: { workspaceId: workspace.id, name: options.name ?? "Synthetic issues" },
  });
  for (const [userId, role] of [[e, "editor"], [v, "viewer"]] as const)
    await authDb.projectMember.create({
      data: { workspaceId: workspace.id, projectId: project.id, userId, role },
    });
  const owner: Scope = { workspaceId: workspace.id, projectId: project.id, userId: o, role: "owner" };
  const editor: Scope = { ...owner, userId: e, role: "editor" };
  const viewer: Scope = { ...owner, userId: v, role: "viewer" };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const enable = (moduleId: string) =>
    run((tx) =>
      tx.projectModule.upsert({
        where: {
          workspaceId_projectId_moduleId: { workspaceId: owner.workspaceId, projectId: owner.projectId, moduleId },
        },
        create: { workspaceId: owner.workspaceId, projectId: owner.projectId, moduleId, enabled: true, moduleVersion: "1.0.0", changedBy: o },
        update: { enabled: true },
      }),
    );
  for (const moduleId of options.modules ?? ["issues"]) await enable(moduleId);
  return {
    owner,
    editor,
    viewer,
    run,
    enable,
    /** Adds a project member with the given role. */
    async member(role: Scope["role"]): Promise<Scope> {
      const userId = await user(role);
      await authDb.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId, role: "viewer" } });
      await authDb.projectMember.create({
        data: { workspaceId: owner.workspaceId, projectId: owner.projectId, userId, role },
      });
      return { ...owner, userId, role };
    },
    async cleanup() {
      await authDb.workspace.deleteMany({ where: { id: workspace.id } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
    },
  };
}

/** Sets the given environment switches for a suite and restores them after. */
export { withEnv } from "./work-pm-project.ts";

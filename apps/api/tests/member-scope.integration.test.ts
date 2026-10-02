import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { actorScope } from "../src/modules/member-scope.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Current project scope of a queued job's actor",
  () => {
    const users: string[] = [];
    const workspaces: string[] = [];
    let workspaceId: string, projectId: string, owner: string, viewer: string;
    const syntheticUser = async () => {
      const row = await authDb.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic job actor",
          email: `${randomUUID()}@example.invalid`,
        },
      });
      users.push(row.id);
      return row.id;
    };
    // Same shape as the add-member action: workspace viewer plus a project role.
    const addProjectMember = async (userId: string, role: string) => {
      await authDb.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { workspaceId, userId, role: "viewer" },
        update: {},
      });
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId, role },
      });
    };
    beforeAll(async () => {
      owner = await syntheticUser();
      viewer = await syntheticUser();
      const workspace = await authDb.workspace.create({
        data: {
          name: "Actor scope",
          members: { create: { userId: owner, role: "owner" } },
        },
      });
      workspaces.push(workspace.id);
      workspaceId = workspace.id;
      projectId = (
        await authDb.project.create({
          data: { workspaceId, name: "Actor scope project" },
        })
      ).id;
      await addProjectMember(viewer, "viewer");
    });
    afterAll(async () => {
      await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
      await closeDatabase();
    });

    it("uses the project role of a project member", async () => {
      expect(await actorScope(workspaceId, projectId, viewer)).toEqual({
        workspaceId,
        projectId,
        userId: viewer,
        role: "viewer",
      });
    });

    it("treats a workspace owner as project owner", async () => {
      expect((await actorScope(workspaceId, projectId, owner))?.role).toBe(
        "owner",
      );
    });

    it("refuses a user who lost project access after queueing", async () => {
      const former = await syntheticUser();
      await addProjectMember(former, "editor");
      expect((await actorScope(workspaceId, projectId, former))?.role).toBe(
        "editor",
      );
      await authDb.projectMember.delete({
        where: { projectId_userId: { projectId, userId: former } },
      });
      expect(await actorScope(workspaceId, projectId, former)).toBeNull();
    });

    it("refuses a project that is not in the job's workspace", async () => {
      const other = await authDb.workspace.create({
        data: {
          name: "Other actor workspace",
          members: { create: { userId: owner, role: "owner" } },
        },
      });
      workspaces.push(other.id);
      expect(await actorScope(other.id, projectId, owner)).toBeNull();
    });
  },
);

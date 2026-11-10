import { randomUUID } from "node:crypto";
import { authDb, scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { moduleRegistry } from "../../src/modules/registry.ts";
import { ensurePersonalSpace } from "../../src/platform/assistant/personal-space.ts";
import { data, entity } from "../../src/platform/shared.ts";
import { eventJob, eventView } from "../../src/platform/events/events.ts";

// A synthetic organization for the proactive suites (ADR 0023): users are
// created directly (no sign-in, so no auth rate limit), an organization
// owner, an editor and a viewer in one business project, and personal
// spaces on request. Everything is removed with the workspace.

export type ProactiveFixture = Awaited<ReturnType<typeof proactiveFixture>>;

export async function proactiveFixture(name = "Synthetic proactive org") {
  const users: string[] = [];
  const user = async (label: string, locale: "en" | "de" | null = null) => {
    const id = randomUUID();
    await authDb.user.create({
      data: { id, name: `Synthetic ${label}`, email: `${id}@example.invalid`, locale },
    });
    users.push(id);
    return id;
  };
  const owner = await user("owner");
  const editor = await user("editor");
  const viewer = await user("viewer");
  const workspaceId = (
    await authDb.workspace.create({
      data: {
        name,
        members: {
          create: [
            { userId: owner, role: "owner" },
            { userId: editor, role: "editor" },
            { userId: viewer, role: "viewer" },
          ],
        },
      },
    })
  ).id;
  const project = async (projectName: string, members: Array<[string, "owner" | "editor" | "viewer"]>) =>
    (
      await authDb.project.create({
        data: {
          workspaceId,
          name: projectName,
          members: { create: members.map(([userId, role]) => ({ userId, role })) },
        },
      })
    ).id;
  const businessId = await project("Synthetic business project", [
    [editor, "editor"],
    [viewer, "viewer"],
  ]);
  const scopeOf = (projectId: string, userId: string, role: Scope["role"] = "owner"): Scope => ({
    workspaceId,
    projectId,
    userId,
    role,
  });
  const worker = (projectId: string): Scope => ({ workspaceId, projectId, userId: "worker", role: "owner" });
  return {
    workspaceId,
    businessId,
    owner,
    editor,
    viewer,
    user,
    project,
    scopeOf,
    worker,
    business: scopeOf(businessId, owner),
    async addMember(userId: string, role: "editor" | "viewer" | "owner" = "editor") {
      await authDb.workspaceMember.create({ data: { workspaceId, userId, role } });
    },
    async personal(userId: string) {
      const space = await ensurePersonalSpace(workspaceId, userId, moduleRegistry());
      return scopeOf(space.projectId, userId);
    },
    /** The notices of one user in one project (row-level security needs app.user_id). */
    notices(projectId: string, userId: string) {
      return scoped(workspaceId, projectId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true)`;
        return tx.notification.findMany({ where: { projectId, userId }, orderBy: { createdAt: "asc" } });
      });
    },
    /** Jobs of a queue class in a project. */
    jobs(projectId: string, topic: string) {
      return scoped(workspaceId, projectId, async (tx) =>
        (
          await tx.entity.findMany({
            where: { projectId, kind: "jobs", data: { path: ["topic"], equals: topic } },
            orderBy: { createdAt: "asc" },
          })
        ).map((row) => ({ id: row.id, ...data(row) })),
      );
    },
    /** Runs the queued domain-event jobs of one subscriber in a project, once each. */
    async runSubscriber(projectId: string, subscriber: string) {
      const queued = (await this.jobs(projectId, "domain_event")).filter(
        (job: Record<string, unknown>) => job.subscriber === subscriber && job.status === "queued",
      );
      for (const job of queued) {
        await eventJob.handler({ scope: worker(projectId), jobId: job.id, job, executionMode: "test" });
        await scoped(workspaceId, projectId, async (tx) => {
          const row = await entity(tx, { workspaceId, projectId }, "jobs", job.id);
          await tx.entity.update({ where: { id: row.id }, data: { data: { ...data(row), status: "succeeded" } } });
        });
      }
      return queued.length;
    },
    eventView,
    async cleanup() {
      await authDb.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
      await authDb.user.deleteMany({ where: { id: { in: users } } });
    },
  };
}

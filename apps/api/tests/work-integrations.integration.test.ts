import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import { createLink, linksOf, linkTargets } from "../src/platform/links/links.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { createMilestone } from "../src/modules/work/milestones.ts";
import { userActor } from "../src/modules/work/common.ts";
import { sendDueNotices, workAttention } from "../src/modules/work/attention.ts";
import { registeredLinkType } from "../src/platform/modules/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Project management with the other modules (WP1.7, WP1.8): links to support
 * tickets, campaigns, assignments and knowledge documents resolve through
 * their modules; attention items and daily due notices.
 */
describe.skipIf(!enabled)("project management integrations", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let owner: Scope, editor: Scope;
  let ticketId = "", missionId = "", documentId = "";
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);
  const row = (s: Scope) => ({ id: randomUUID(), workspaceId: s.workspaceId, projectId: s.projectId });

  beforeAll(async () => {
    process.env.ORBIT_WORK = "true";
    process.env.ORBIT_SUPPORT = "true";
    process.env.ORBIT_NOTIFICATIONS = "true";
    const user = async (name: string) => {
      const created = await authDb.user.create({
        data: { id: randomUUID(), name, email: `${randomUUID()}@example.invalid` },
      });
      users.push(created.id);
      return created.id;
    };
    const [o, e] = [await user("Owner"), await user("Editor")];
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic integrations", members: { create: [{ userId: o, role: "owner" }, { userId: e, role: "viewer" }] } },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({ data: { workspaceId: workspace.id, name: "Integrations" } });
    await authDb.projectMember.create({ data: { workspaceId: workspace.id, projectId: project.id, userId: e, role: "editor" } });
    owner = { workspaceId: workspace.id, projectId: project.id, userId: o, role: "owner" };
    editor = { ...owner, userId: e, role: "editor" };
    await run(owner, async (tx) => {
      for (const moduleId of ["work", "support"])
        await tx.projectModule.create({
          data: { workspaceId: owner.workspaceId, projectId: owner.projectId, moduleId, enabled: true, moduleVersion: "1.0.0", changedBy: o },
        });
      const inbox = await tx.supportInbox.create({
        data: { ...row(owner), name: "Synthetic inbox", channels: ["widget"], createdBy: o },
      });
      const contact = await tx.supportContact.create({ data: { ...row(owner), email: "customer@example.invalid" } });
      ticketId = (
        await tx.supportTicket.create({
          data: { ...row(owner), number: 7, inboxId: inbox.id, contactId: contact.id, subject: "Grid-Bot erstellt keine Orders", channel: "widget" },
        })
      ).id;
      missionId = (await create(tx, owner, "missions", { title: "Marketplace teaser", status: "draft" })).id;
      const source = await create(tx, owner, "sources", { name: "Synthetic source", status: "active" });
      const doc = await tx.knowledgeDocument.create({
        data: { workspaceId: owner.workspaceId, projectId: owner.projectId, sourceId: source.id, externalId: "spec" },
      });
      const version = await tx.documentVersion.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          documentId: doc.id,
          version: 1,
          title: "Marketplace specification",
          language: "en",
          contentHash: "0".repeat(64),
          text: "spec",
          mimeType: "text/plain",
          extractorVersion: "1",
          sourceGeneration: 1,
        },
      });
      await tx.knowledgeDocument.update({ where: { id: doc.id }, data: { activeVersionId: version.id } });
      documentId = doc.id;
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_WORK;
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_NOTIFICATIONS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("registers the link types of support, marketing and knowledge", () => {
    for (const type of ["support.ticket", "marketing.mission", "marketing.assignment", "knowledge.document", "work.task", "work.initiative", "work.milestone"])
      expect(registeredLinkType(type)).toBeDefined();
  });

  it("links a task to a ticket, a campaign and a document and resolves them", async () => {
    const task = await run(owner, (tx) => createTask(tx, owner, { title: "Fix order creation" }, userActor(owner)));
    for (const [type, id, relation] of [
      ["support.ticket", ticketId, "relates_to"],
      ["marketing.mission", missionId, "relates_to"],
      ["knowledge.document", documentId, "documents"],
    ] as const)
      await run(editor, (tx) =>
        createLink(tx, editor, { source: { type: "work.task", id: task.id }, target: { type, id }, relation }, userActor(editor)),
      );
    const links = await run(editor, (tx) => linksOf(tx, editor, { type: "work.task", id: task.id }));
    expect(links.map((l) => [l.object.type, l.object.state, l.object.title])).toEqual([
      ["support.ticket", "ok", "#7 Grid-Bot erstellt keine Orders"],
      ["marketing.mission", "ok", "Marketplace teaser"],
      ["knowledge.document", "ok", "Marketplace specification"],
    ]);
    expect(links[0]!.object).toMatchObject({ sensitive: true, href: `/p/${owner.projectId}/support/tickets?ticket=${ticketId}` });
    // Without access to support, the ticket is out of reach; its subject never shows.
    const noSupport = { ...editor, moduleRoles: { support: "none" as const } };
    const hidden = await run(noSupport, (tx) => linksOf(tx, noSupport, { type: "work.task", id: task.id }));
    expect(hidden[0]!.object).toEqual({ type: "support.ticket", id: ticketId, label: expect.any(Object), state: "missing" });
    // The ticket side sees the task.
    const fromTicket = await run(owner, (tx) => linksOf(tx, owner, { type: "support.ticket", id: ticketId }));
    expect(fromTicket[0]).toMatchObject({ direction: "incoming", object: { type: "work.task", id: task.id } });
    expect(await run(owner, (tx) => linkTargets(tx, owner, "support.ticket", "#7"))).toEqual([
      { id: ticketId, title: "#7 Grid-Bot erstellt keine Orders" },
    ]);
    expect(await run(owner, (tx) => linkTargets(tx, owner, "knowledge.document", "specification"))).toEqual([
      { id: documentId, title: "Marketplace specification" },
    ]);
  });

  it("shows overdue, blocked and due-milestone attention to the member", async () => {
    const now = new Date();
    const initiative = await run(owner, (tx) => createInitiative(tx, owner, { title: "Attention" }, userActor(owner)));
    const milestone = await run(owner, (tx) =>
      createMilestone(tx, owner, initiative.id, { title: "Soon", dueDate: now.toISOString().slice(0, 10) }, userActor(owner)),
    );
    await run(owner, (tx) =>
      createTask(tx, owner, { title: "Late", dueDate: "2020-01-01", assigneeUserId: editor.userId, initiativeId: initiative.id, milestoneId: milestone.id }, userActor(owner)),
    );
    await run(owner, (tx) => createTask(tx, owner, { title: "Stuck", status: "blocked" }, userActor(owner)));
    const items = await run(editor, (tx) => workAttention(tx, editor, now));
    expect(items.map((i) => [i.kind, i.count, i.navKey])).toEqual([
      ["work_overdue_mine", 1, "work-my"],
      ["work_blocked", 1, "work-board"],
      ["work_milestone_due", 1, "work-milestones"],
    ]);
    expect(JSON.stringify(items)).not.toContain("Late");
    const ownerItems = await run(owner, (tx) => workAttention(tx, owner, now));
    expect(ownerItems.map((i) => i.kind)).not.toContain("work_overdue_mine");
  });

  it("sends each due notice once a day", async () => {
    const now = new Date();
    const first = await run(owner, (tx) => sendDueNotices(tx, owner, now));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await run(owner, (tx) => sendDueNotices(tx, owner, now))).toBe(0);
    const notices = await run(editor, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${editor.userId}, true)`;
      return tx.notification.findMany({ where: { projectId: owner.projectId, userId: editor.userId, kind: "work_task_due" } });
    });
    expect(notices.length).toBe(first);
    expect(notices[0]!.link).toMatch(/^\/p\/[0-9a-f-]+\/work\/tasks\?task=/);
  });
});

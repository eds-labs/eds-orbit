import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { writeModuleSettings } from "../src/platform/modules/settings.ts";
import { createLink } from "../src/platform/links/links.ts";
import {
  createInitiative,
  deleteInitiative,
  updateInitiative,
} from "../src/modules/work/initiatives.ts";
import { createMilestone, deleteMilestone } from "../src/modules/work/milestones.ts";
import {
  createTask,
  createTasks,
  deleteTask,
  moveTask,
  setTaskArchived,
  updateTask,
} from "../src/modules/work/tasks.ts";
import {
  addAttachment,
  addChecklistItem,
  addComment,
  addDependency,
  deleteComment,
  setWatching,
  updateChecklistItem,
} from "../src/modules/work/parts.ts";
import {
  listTasks,
  myTasks,
  overview,
  taskDetail,
} from "../src/modules/work/queries.ts";
import {
  defaultWorkSettings,
  workSettingsSchema,
} from "../src/modules/work/settings.ts";
import { userActor } from "../src/modules/work/common.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// A marker in every title and description: the content-free tests look for
// it in audits, history and domain events.
const SECRET = "Geheimprojekt-7f3a";

describe.skipIf(!enabled)("project management services (WP1.5)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let owner: Scope, editor: Scope, viewer: Scope;
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);
  const as = (s: Scope) => userActor(s);
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const task = (s: Scope, body: Record<string, unknown>) =>
    run(s, (tx) => createTask(tx, s, body, as(s)));

  beforeAll(async () => {
    process.env.ORBIT_WORK = "true";
    const user = async (name: string) => {
      const row = await authDb.user.create({
        data: { id: randomUUID(), name, email: `${randomUUID()}@example.invalid` },
      });
      users.push(row.id);
      return row.id;
    };
    const [o, e, v] = [await user("Owner"), await user("Editor"), await user("Viewer")];
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic work", members: { create: [
        { userId: o, role: "owner" },
        { userId: e, role: "viewer" },
        { userId: v, role: "viewer" },
      ] } },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({ data: { workspaceId: workspace.id, name: "Work" } });
    for (const [userId, role] of [[e, "editor"], [v, "viewer"]] as const)
      await authDb.projectMember.create({
        data: { workspaceId: workspace.id, projectId: project.id, userId, role },
      });
    owner = { workspaceId: workspace.id, projectId: project.id, userId: o, role: "owner" };
    editor = { ...owner, userId: e, role: "editor" };
    viewer = { ...owner, userId: v, role: "viewer" };
    await run(owner, (tx) =>
      tx.projectModule.create({
        data: { workspaceId: owner.workspaceId, projectId: owner.projectId, moduleId: "work", enabled: true, moduleVersion: "1.0.0", changedBy: o },
      }),
    );
  });
  afterAll(async () => {
    delete process.env.ORBIT_WORK;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("creates initiatives with free keys and milestones", async () => {
    const a = await run(owner, (tx) =>
      createInitiative(tx, owner, { title: "uLiquid Marketplace Launch" }, as(owner)),
    );
    const b = await run(owner, (tx) =>
      createInitiative(tx, owner, { title: "uLiquid marketplace Launch" }, as(owner)),
    );
    expect([a.key, b.key]).toEqual(["UML", "UML2"]);
    expect(
      await failure(run(owner, (tx) => createInitiative(tx, owner, { key: "UML", title: "x" }, as(owner)))),
    ).toBe("WORK_KEY_TAKEN");
    expect(
      await failure(
        run(owner, (tx) =>
          createInitiative(tx, owner, { title: "x", startDate: "2026-11-02", targetDate: "2026-11-01" }, as(owner)),
        ),
      ),
    ).toBe("WORK_DATES_INVALID");
    const m = await run(owner, (tx) =>
      createMilestone(tx, owner, a.id, { title: "Beta", dueDate: "2026-12-01" }, as(owner)),
    );
    expect(m.initiativeId).toBe(a.id);
  });

  it("numbers tasks per project, also when created at the same time", async () => {
    const [x, y] = await Promise.all([
      task(owner, { title: `First ${SECRET}` }),
      task(editor, { title: `Second ${SECRET}` }),
    ]);
    expect(new Set([x.number, y.number]).size).toBe(2);
    const z = await task(owner, { title: "Third", description: `About ${SECRET}` });
    expect(z.number).toBe(Math.max(x.number, y.number) + 1);
    expect(z.status).toBe("todo");
    expect(z.statusCategory).toBe("todo");
    expect(z.rank > x.rank && z.rank > y.rank).toBe(true);
  });

  it("validates status, assignee, milestone and subtask depth", async () => {
    const initiatives = await run(owner, (tx) => tx.workInitiative.findMany({ where: { projectId: owner.projectId } }));
    const milestone = await run(owner, (tx) => tx.workMilestone.findFirstOrThrow({ where: { projectId: owner.projectId } }));
    const other = initiatives.find((i) => i.id !== milestone.initiativeId)!;
    expect(await failure(task(owner, { title: "x", status: "nope" }))).toBe("WORK_STATUS_UNKNOWN");
    expect(await failure(task(owner, { title: "x", assigneeUserId: viewer.userId }))).toBe("WORK_ASSIGNEE_INVALID");
    expect(await failure(task(owner, { title: "x", assigneeUserId: randomUUID() }))).toBe("WORK_ASSIGNEE_INVALID");
    expect(
      await failure(task(owner, { title: "x", initiativeId: other.id, milestoneId: milestone.id })),
    ).toBe("WORK_MILESTONE_MISMATCH");
    expect(await failure(task(owner, { title: "x", category: "unknown_cat" }))).toBe("WORK_CATEGORY_UNKNOWN");
    const parent = await task(owner, { title: "Parent", initiativeId: milestone.initiativeId, milestoneId: milestone.id });
    const child = await task(owner, { title: "Child", parentTaskId: parent.id, assigneeUserId: editor.userId });
    // A subtask inherits the parent's initiative.
    expect(child.initiativeId).toBe(milestone.initiativeId);
    expect(await failure(task(owner, { title: "Grandchild", parentTaskId: child.id }))).toBe("WORK_PARENT_DEPTH");
    // A task with subtasks cannot become a subtask.
    const lone = await task(owner, { title: "Lone" });
    expect(
      await failure(run(owner, (tx) => updateTask(tx, owner, parent.id, { expectedVersion: parent.version, parentTaskId: lone.id }, as(owner)))),
    ).toBe("WORK_PARENT_DEPTH");
  });

  it("writes one history row per changed field and refuses stale versions", async () => {
    const t = await task(owner, { title: `Edit ${SECRET}` });
    const updated = await run(owner, (tx) =>
      updateTask(tx, owner, t.id, {
        expectedVersion: t.version,
        title: `Edited ${SECRET}`,
        priority: "high",
        labels: ["Backend", "backend", "api"],
        dueDate: "2026-11-15",
      }, as(owner)),
    );
    expect(updated.version).toBe(t.version + 1);
    expect(updated.labels).toEqual(["backend", "api"]);
    const events = await run(owner, (tx) =>
      tx.workEvent.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } }),
    );
    expect(events.map((e) => e.type).sort()).toEqual(["created", "due_date", "labels", "priority", "title"].sort());
    expect(events.find((e) => e.type === "title")!.after).toEqual({ changed: true });
    expect(events.find((e) => e.type === "due_date")!.after).toEqual({ dueDate: "2026-11-15" });
    expect(
      await failure(run(owner, (tx) => updateTask(tx, owner, t.id, { expectedVersion: t.version, priority: "low" }, as(owner)))),
    ).toBe("WORK_VERSION_CONFLICT");
    // An unchanged value changes nothing.
    const same = await run(owner, (tx) =>
      updateTask(tx, owner, t.id, { expectedVersion: updated.version, priority: "high" }, as(owner)),
    );
    expect(same.version).toBe(updated.version);
  });

  it("follows the workflow: categories, completion time and allowed transitions", async () => {
    const t = await task(owner, { title: "Flow" });
    const done = await run(owner, (tx) => updateTask(tx, owner, t.id, { expectedVersion: t.version, status: "done" }, as(owner)));
    expect(done.statusCategory).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const reopened = await run(owner, (tx) => updateTask(tx, owner, t.id, { expectedVersion: done.version, status: "in_progress" }, as(owner)));
    expect(reopened.completedAt).toBeNull();
    const settings = defaultWorkSettings();
    settings.workflow.transitions = { in_progress: ["in_review", "blocked"] };
    await run(owner, (tx) => writeModuleSettings(tx, owner, "work", workSettingsSchema, settings, 1));
    expect(
      await failure(run(owner, (tx) => updateTask(tx, owner, t.id, { expectedVersion: reopened.version, status: "done" }, as(owner)))),
    ).toBe("WORK_TRANSITION_NOT_ALLOWED");
    const review = await run(owner, (tx) => updateTask(tx, owner, t.id, { expectedVersion: reopened.version, status: "in_review" }, as(owner)));
    expect(review.status).toBe("in_review");
    const events = await run(owner, (tx) =>
      tx.domainEvent.findMany({ where: { subjectId: t.id, type: "work.task.status_changed" }, orderBy: { createdAt: "asc" } }),
    );
    expect(events.map((e) => e.data)).toEqual([
      expect.objectContaining({ from: "todo", to: "done", toCategory: "done" }),
      expect.objectContaining({ from: "done", to: "in_progress" }),
      expect.objectContaining({ from: "in_progress", to: "in_review" }),
    ]);
  });

  it("refuses dependency cycles", async () => {
    const [a, b, c] = [await task(owner, { title: "A" }), await task(owner, { title: "B" }), await task(owner, { title: "C" })];
    await run(owner, (tx) => addDependency(tx, owner, a.id, { dependsOnTaskId: b.id }, as(owner)));
    await run(owner, (tx) => addDependency(tx, owner, b.id, { dependsOnTaskId: c.id }, as(owner)));
    expect(await failure(run(owner, (tx) => addDependency(tx, owner, c.id, { dependsOnTaskId: a.id }, as(owner))))).toBe(
      "WORK_DEPENDENCY_CYCLE",
    );
    expect(await failure(run(owner, (tx) => addDependency(tx, owner, a.id, { dependsOnTaskId: a.id }, as(owner))))).toBe(
      "WORK_DEPENDENCY_CYCLE",
    );
    const detail = await run(owner, (tx) => taskDetail(tx, owner, b.id));
    expect(detail.dependencies.waitsFor.map((d) => d.task?.id)).toEqual([c.id]);
    expect(detail.dependencies.blocks.map((d) => d.task?.id)).toEqual([a.id]);
    const listed = await run(owner, (tx) => listTasks(tx, owner, { q: "A" }));
    const item = listed.items.find((i) => i.id === a.id)!;
    expect(item.counts.blockedBy).toBe(1);
  });

  it("moves tasks between neighbours and changes status on the board", async () => {
    const [a, b, c] = [await task(owner, { title: "M1" }), await task(owner, { title: "M2" }), await task(owner, { title: "M3" })];
    const moved = await run(owner, (tx) =>
      moveTask(tx, owner, c.id, { expectedVersion: c.version, afterTaskId: a.id, beforeTaskId: b.id, status: "in_progress" }, as(owner)),
    );
    expect(moved.rank > a.rank && moved.rank < b.rank).toBe(true);
    expect(moved.status).toBe("in_progress");
    expect(
      await failure(run(owner, (tx) => moveTask(tx, owner, a.id, { expectedVersion: a.version, afterTaskId: b.id, beforeTaskId: c.id }, as(owner)))),
    ).toBe("WORK_RANK_ORDER");
  });

  it("archives with subtasks, deletes only with consent and removes links", async () => {
    const parent = await task(owner, { title: "Archive me" });
    const child = await task(owner, { title: "Archived child", parentTaskId: parent.id });
    const archived = await run(owner, (tx) => setTaskArchived(tx, owner, parent.id, { expectedVersion: parent.version }, true, as(owner)));
    expect(archived.archivedAt).not.toBeNull();
    const childRow = await run(owner, (tx) => tx.workTask.findFirstOrThrow({ where: { id: child.id } }));
    expect(childRow.archivedAt).not.toBeNull();
    const other = await task(owner, { title: "Linked" });
    await run(owner, (tx) =>
      createLink(tx, owner, { source: { type: "work.task", id: other.id }, target: { type: "work.task", id: child.id }, relation: "relates_to" }, as(owner)),
    );
    expect(await failure(run(owner, (tx) => deleteTask(tx, owner, parent.id, false, as(owner))))).toBe("WORK_HAS_SUBTASKS");
    await run(owner, (tx) => deleteTask(tx, owner, parent.id, true, as(owner)));
    expect(await run(owner, (tx) => tx.workTask.count({ where: { id: { in: [parent.id, child.id] } } }))).toBe(0);
    const detail = await run(owner, (tx) => taskDetail(tx, owner, other.id));
    expect(detail.links).toEqual([]);
  });

  it("detaches tasks when an initiative or milestone is deleted", async () => {
    const i = await run(owner, (tx) => createInitiative(tx, owner, { title: "Short lived" }, as(owner)));
    const m = await run(owner, (tx) => createMilestone(tx, owner, i.id, { title: "M" }, as(owner)));
    const t = await task(owner, { title: "Inside", initiativeId: i.id, milestoneId: m.id });
    await run(owner, (tx) => deleteMilestone(tx, owner, m.id, as(owner)));
    expect((await run(owner, (tx) => tx.workTask.findFirstOrThrow({ where: { id: t.id } }))).milestoneId).toBeNull();
    expect(await failure(run(owner, (tx) => deleteInitiative(tx, owner, i.id, false, as(owner))))).toBe("WORK_INITIATIVE_NOT_EMPTY");
    await run(owner, (tx) => deleteInitiative(tx, owner, i.id, true, as(owner)));
    expect((await run(owner, (tx) => tx.workTask.findFirstOrThrow({ where: { id: t.id } }))).initiativeId).toBeNull();
  });

  it("searches titles and descriptions by word prefix and numbers", async () => {
    const t = await task(owner, { title: "Orderbook latency", description: "Grid-Bot erstellt keine Orders" });
    const byDescription = await run(owner, (tx) => listTasks(tx, owner, { q: "grid erste" }));
    expect(byDescription.items.map((i) => i.id)).toContain(t.id);
    const byNumber = await run(owner, (tx) => listTasks(tx, owner, { q: `#${t.number}` }));
    expect(byNumber.items[0]!.id).toBe(t.id);
    const none = await run(owner, (tx) => listTasks(tx, owner, { q: "zzzqqq" }));
    expect(none.items).toEqual([]);
    expect(await failure(run(owner, (tx) => listTasks(tx, owner, { unknown: 1 })))).not.toBe("resolved");
  });

  it("filters, groups my tasks and builds the overview", async () => {
    const overdue = await task(owner, { title: "Late", dueDate: "2020-01-01", assigneeUserId: editor.userId });
    const page = await run(owner, (tx) => listTasks(tx, owner, { due: "overdue" }));
    expect(page.items.map((i) => i.id)).toContain(overdue.id);
    const mine = await run(editor, (tx) => myTasks(tx, editor));
    expect(mine.overdue.map((i) => i.id)).toContain(overdue.id);
    const view = await run(editor, (tx) => overview(tx, editor));
    expect(view.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(view.myNext.map((i) => i.id)).toContain(overdue.id);
    const paged = await run(owner, (tx) => listTasks(tx, owner, { limit: 2, sort: "number" }));
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).toBe("2");
    expect(paged.items[0]!.number).toBeGreaterThan(paged.items[1]!.number);
  });

  it("keeps comments, checklists, attachments and watchers on the task", async () => {
    const t = await task(owner, { title: "Parts", checklist: ["one", "two"] });
    const item = await run(owner, (tx) => addChecklistItem(tx, owner, t.id, { text: "three" }, as(owner)));
    await run(owner, (tx) => updateChecklistItem(tx, owner, item.id, { done: true }, as(owner)));
    const comment = await run(editor, (tx) =>
      addComment(tx, editor, t.id, { body: `Hi ${SECRET}`, mentions: [owner.userId, randomUUID()] }, as(editor)),
    );
    expect(comment.mentions).toEqual([owner.userId]);
    const otherEditor = { ...editor, userId: viewer.userId };
    expect(await failure(run(otherEditor, (tx) => deleteComment(tx, otherEditor, comment.id, as(otherEditor))))).toBe("FORBIDDEN");
    const fileId = randomUUID();
    await run(owner, async (tx) => {
      await tx.fileBlob.create({
        data: { key: `projects/${owner.projectId}/work/${fileId}`, workspaceId: owner.workspaceId, projectId: owner.projectId, data: Buffer.from([1]) },
      });
      await tx.file.create({
        data: {
          id: fileId,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "work",
          key: `projects/${owner.projectId}/work/${fileId}`,
          name: "spec.txt",
          mime: "text/plain",
          size: 1,
          sha256: "0".repeat(64),
          encryption: "aes-256-gcm/v1",
          createdBy: owner.userId,
        },
      });
    });
    await run(owner, (tx) => addAttachment(tx, owner, t.id, { fileId }, as(owner)));
    expect(await failure(run(owner, (tx) => addAttachment(tx, owner, t.id, { fileId: randomUUID() }, as(owner))))).toBe(
      "ATTACHMENT_INVALID",
    );
    await run(viewer, (tx) => setWatching(tx, viewer, t.id, true));
    const detail = await run(viewer, (tx) => taskDetail(tx, viewer, t.id));
    expect(detail.checklist.map((c) => [c.text, c.done])).toEqual([
      ["one", false],
      ["two", false],
      ["three", true],
    ]);
    expect(detail.attachments.map((a) => a.name)).toEqual(["spec.txt"]);
    expect(detail.watching).toBe(true);
    expect(detail.timeline.filter((e) => e.kind === "comment")).toHaveLength(1);
    await run(owner, (tx) => deleteComment(tx, owner, comment.id, as(owner)));
    const after = await run(owner, (tx) => taskDetail(tx, owner, t.id));
    const deleted = after.timeline.find((e) => e.kind === "comment")!;
    expect(deleted).toMatchObject({ body: "", deletedAt: expect.any(String) });
  });

  it("never copies titles, descriptions or comments into audits, history or events", async () => {
    await run(owner, async (tx) => {
      const initiative = await tx.workInitiative.findFirstOrThrow({ where: { projectId: owner.projectId } });
      await updateInitiative(tx, owner, initiative.id, { expectedVersion: initiative.version, description: SECRET }, as(owner));
    });
    const [audits, history, events] = await run(owner, (tx) =>
      Promise.all([
        tx.auditEvent.findMany({ where: { projectId: owner.projectId } }),
        tx.workEvent.findMany({ where: { projectId: owner.projectId } }),
        tx.domainEvent.findMany({ where: { projectId: owner.projectId } }),
      ]),
    );
    expect(audits.length).toBeGreaterThan(10);
    expect(events.length).toBeGreaterThan(10);
    expect(JSON.stringify([audits, history, events])).not.toContain(SECRET);
  });

  it("creates a batch of tasks in one transaction, or none", async () => {
    const before = await run(owner, (tx) => tx.workTask.count({ where: { projectId: owner.projectId } }));
    expect(
      await failure(
        run(owner, (tx) => createTasks(tx, owner, [{ title: "ok" }, { title: "bad", status: "nope" }], as(owner), "assistant")),
      ),
    ).toBe("WORK_STATUS_UNKNOWN");
    expect(await run(owner, (tx) => tx.workTask.count({ where: { projectId: owner.projectId } }))).toBe(before);
    const created = await run(owner, (tx) =>
      createTasks(tx, owner, [{ title: "b1" }, { title: "b2" }], as(owner), "assistant"),
    );
    expect(created.map((t) => t.source)).toEqual(["assistant", "assistant"]);
  });
});

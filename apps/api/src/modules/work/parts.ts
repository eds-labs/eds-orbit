import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { effectiveRole } from "../../platform/tenancy/module-roles.ts";
import {
  MODULE,
  releaseFiles,
  uuid,
  workDomainEvent,
  workEvent,
  workMembers,
  type WorkActor,
} from "./common.ts";
import { notifyTask, watcherIds } from "./notifications.ts";
import { WORK_DELETE } from "./permissions.ts";
import { changed, loadTask } from "./tasks.ts";

// What hangs on a task: checklist items, dependencies, comments,
// attachments and watchers. Each change is part of the task's history.

const MAX_CHECKLIST = 100;
const subject = (id: string) => ({ type: "work.task" as const, id });

// --- Checklist -------------------------------------------------------------

export const checklistInput = z
  .object({ text: z.string().trim().min(1).max(500) })
  .strict();
export const checklistUpdateInput = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    done: z.boolean().optional(),
    sortOrder: z.int().min(0).max(100000).optional(),
  })
  .strict();

async function loadItem(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workChecklistItem.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export async function addChecklistItem(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = checklistInput.parse(raw);
  const task = await loadTask(tx, scope, taskId);
  const count = await tx.workChecklistItem.count({
    where: { projectId: scope.projectId, taskId: task.id },
  });
  if (count >= MAX_CHECKLIST) throw new DomainError("WORK_CHECKLIST_FULL", 409);
  const last = await tx.workChecklistItem.aggregate({
    where: { projectId: scope.projectId, taskId: task.id },
    _max: { sortOrder: true },
  });
  const row = await tx.workChecklistItem.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: task.id,
      text: input.text,
      sortOrder: (last._max.sortOrder ?? -10) + 10,
    },
  });
  await workEvent(tx, scope, { taskId: task.id }, "checklist", actor, {}, { added: row.id });
  changed(tx, scope, task);
  return row;
}

export async function updateChecklistItem(
  tx: DbTx,
  scope: Scope,
  itemId: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = checklistUpdateInput.parse(raw);
  const item = await loadItem(tx, scope, itemId);
  const data: Record<string, unknown> = {};
  if (input.text !== undefined && input.text !== item.text) data.text = input.text;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.done !== undefined && input.done !== item.done) {
    data.done = input.done;
    data.doneBy = input.done ? actor.id : null;
    data.doneAt = input.done ? new Date() : null;
  }
  if (!Object.keys(data).length) return item;
  const row = await tx.workChecklistItem.update({ where: { id: item.id }, data });
  await workEvent(tx, scope, { taskId: item.taskId }, "checklist", actor, {}, {
    item: item.id,
    fields: Object.keys(data).filter((k) => k !== "doneBy" && k !== "doneAt"),
  });
  changed(tx, scope, { id: item.taskId });
  return row;
}

export async function removeChecklistItem(
  tx: DbTx,
  scope: Scope,
  itemId: string,
  actor: WorkActor,
) {
  const item = await loadItem(tx, scope, itemId);
  await tx.workChecklistItem.delete({ where: { id: item.id } });
  await workEvent(tx, scope, { taskId: item.taskId }, "checklist", actor, { removed: item.id });
  changed(tx, scope, { id: item.taskId });
}

// --- Dependencies ----------------------------------------------------------

export const dependencyInput = z.object({ dependsOnTaskId: uuid }).strict();

/** True when `from` already (transitively) waits for `to`. */
async function waitsFor(tx: DbTx, scope: Scope, from: string, to: string) {
  const rows = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE chain(id) AS (
      SELECT "dependsOnTaskId" FROM "WorkTaskDependency"
      WHERE "projectId" = ${scope.projectId}::uuid AND "taskId" = ${from}::uuid
      UNION
      SELECT d."dependsOnTaskId" FROM "WorkTaskDependency" d
      JOIN chain c ON d."taskId" = c.id
      WHERE d."projectId" = ${scope.projectId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${to}::uuid) AS found`;
  return rows[0]?.found === true;
}

/**
 * Makes a task wait for another. Refused when the other task already waits
 * for this one, directly or through others (the project lock keeps the
 * check and the insert together).
 */
export async function addDependency(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = dependencyInput.parse(raw);
  const task = await loadTask(tx, scope, taskId);
  const blocker = await loadTask(tx, scope, input.dependsOnTaskId);
  if (task.id === blocker.id) throw new DomainError("WORK_DEPENDENCY_CYCLE", 409);
  const existing = await tx.workTaskDependency.findFirst({
    where: { projectId: scope.projectId, taskId: task.id, dependsOnTaskId: blocker.id },
  });
  if (existing) return existing;
  if (await waitsFor(tx, scope, blocker.id, task.id))
    throw new DomainError("WORK_DEPENDENCY_CYCLE", 409);
  const row = await tx.workTaskDependency.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: task.id,
      dependsOnTaskId: blocker.id,
      createdBy: actor.id ?? scope.userId,
    },
  });
  await workEvent(tx, scope, { taskId: task.id }, "dependency_added", actor, {}, { dependsOnTaskId: blocker.id });
  await workDomainEvent(tx, scope, "work.task.dependency_changed", subject(task.id), actor, {
    number: task.number,
    added: blocker.id,
  });
  changed(tx, scope, task);
  return row;
}

export async function removeDependency(
  tx: DbTx,
  scope: Scope,
  dependencyId: string,
  actor: WorkActor,
) {
  const row = await tx.workTaskDependency.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(dependencyId) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  await tx.workTaskDependency.delete({ where: { id: row.id } });
  await workEvent(tx, scope, { taskId: row.taskId }, "dependency_removed", actor, { dependsOnTaskId: row.dependsOnTaskId });
  await workDomainEvent(tx, scope, "work.task.dependency_changed", subject(row.taskId), actor, {
    removed: row.dependsOnTaskId,
  });
  changed(tx, scope, { id: row.taskId });
}

// --- Comments --------------------------------------------------------------

export const commentInput = z
  .object({
    body: z.string().trim().min(1).max(20000),
    /** Members to notify, chosen in the editor; unknown ids are dropped. */
    mentions: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict();
export const commentUpdateInput = z
  .object({ body: z.string().trim().min(1).max(20000) })
  .strict();

export function commentView(row: {
  id: string;
  taskId: string;
  authorKind: string;
  authorUserId: string | null;
  agentRunId: string | null;
  bodyText: string;
  mentions: string[];
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    taskId: row.taskId,
    authorKind: row.authorKind,
    authorUserId: row.authorUserId,
    agentRunId: row.agentRunId,
    body: row.deletedAt ? "" : row.bodyText,
    mentions: row.mentions,
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function addComment(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  raw: unknown,
  actor: WorkActor,
  agentRunId: string | null = null,
) {
  const input = commentInput.parse(raw);
  const task = await loadTask(tx, scope, taskId);
  const members = new Set((await workMembers(scope)).map((m) => m.userId));
  const mentions = [...new Set(input.mentions)].filter((u) => members.has(u));
  const row = await tx.workComment.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: task.id,
      authorKind: actor.kind === "user" ? "user" : actor.kind === "system" ? "system" : "agent",
      authorUserId: actor.kind === "user" ? actor.id : null,
      agentRunId,
      bodyText: input.body,
      mentions,
    },
  });
  await workEvent(tx, scope, { taskId: task.id }, "comment_added", actor, {}, { commentId: row.id });
  await audit(tx, scope, "work.task.commented", task.id, { number: task.number, commentId: row.id });
  await workDomainEvent(tx, scope, "work.task.commented", subject(task.id), actor, {
    number: task.number,
    commentId: row.id,
  });
  await notifyTask(tx, scope, "work_task_mentioned", task, mentions);
  const watchers = (await watcherIds(tx, scope, task.id)).filter((u) => !mentions.includes(u));
  await notifyTask(tx, scope, "work_task_watched", task, watchers);
  changed(tx, scope, task);
  return row;
}

async function loadComment(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workComment.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row || row.deletedAt) throw new DomainError("NOT_FOUND", 404);
  return row;
}

/** Only the author edits a comment. */
export async function editComment(
  tx: DbTx,
  scope: Scope,
  commentId: string,
  raw: unknown,
) {
  const input = commentUpdateInput.parse(raw);
  const row = await loadComment(tx, scope, commentId);
  if (row.authorUserId !== scope.userId) throw new DomainError("FORBIDDEN", 403);
  const updated = await tx.workComment.update({
    where: { id: row.id },
    data: { bodyText: input.body, editedAt: new Date() },
  });
  changed(tx, scope, { id: row.taskId });
  return updated;
}

/** The author or an owner deletes a comment; its place in the thread stays. */
export async function deleteComment(
  tx: DbTx,
  scope: Scope,
  commentId: string,
  actor: WorkActor,
) {
  const row = await loadComment(tx, scope, commentId);
  if (
    row.authorUserId !== scope.userId &&
    !can({ role: effectiveRole(scope, MODULE) as Scope["role"] }, WORK_DELETE)
  )
    throw new DomainError("FORBIDDEN", 403);
  await tx.workComment.update({
    where: { id: row.id },
    data: { bodyText: "", deletedAt: new Date() },
  });
  await workEvent(tx, scope, { taskId: row.taskId }, "comment_removed", actor, { commentId: row.id });
  changed(tx, scope, { id: row.taskId });
}

// --- Attachments -----------------------------------------------------------

export const attachmentInput = z.object({ fileId: uuid }).strict();

/** Attaches a live platform file of the module, uploaded beforehand. */
export async function addAttachment(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = attachmentInput.parse(raw);
  const task = await loadTask(tx, scope, taskId);
  const file = await tx.file.findFirst({
    where: {
      id: input.fileId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      moduleId: MODULE,
      deletedAt: null,
    },
  });
  if (!file) throw new DomainError("ATTACHMENT_INVALID", 400);
  const existing = await tx.workAttachment.findFirst({
    where: { projectId: scope.projectId, taskId: task.id, fileId: file.id },
  });
  if (existing) return existing;
  const row = await tx.workAttachment.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: task.id,
      fileId: file.id,
      name: (file.name ?? "attachment").slice(0, 200),
      mime: file.mime,
      size: file.size,
      addedBy: actor.id ?? scope.userId,
    },
  });
  await workEvent(tx, scope, { taskId: task.id }, "attachment_added", actor, {}, { attachmentId: row.id });
  changed(tx, scope, task);
  return row;
}

export async function removeAttachment(
  tx: DbTx,
  scope: Scope,
  attachmentId: string,
  actor: WorkActor,
) {
  const row = await tx.workAttachment.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(attachmentId) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  await tx.workAttachment.delete({ where: { id: row.id } });
  await releaseFiles(tx, scope, [row.fileId]);
  await workEvent(tx, scope, { taskId: row.taskId }, "attachment_removed", actor, { attachmentId: row.id });
  changed(tx, scope, { id: row.taskId });
}

// --- Watchers --------------------------------------------------------------

export async function setWatching(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  watching: boolean,
) {
  const task = await loadTask(tx, scope, taskId);
  const where = {
    projectId_taskId_userId: {
      projectId: scope.projectId,
      taskId: task.id,
      userId: scope.userId,
    },
  };
  if (watching)
    await tx.workTaskWatcher.upsert({
      where,
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        taskId: task.id,
        userId: scope.userId,
      },
      update: {},
    });
  else await tx.workTaskWatcher.deleteMany({ where: where.projectId_taskId_userId });
  return { watching };
}

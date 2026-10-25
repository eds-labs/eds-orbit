import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { afterCommit } from "../../../../../packages/db/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { removeLinksFor } from "../../platform/links/links.ts";
import { publishChange } from "../../platform/realtime/fanout.ts";
import {
  assertVersion,
  assignableIds,
  releaseFiles,
  dateInput,
  expectedVersion,
  fromDate,
  toDate,
  uuid,
  workDomainEvent,
  workEvent,
  type WorkActor,
} from "./common.ts";
import { notifyTask, watcherIds } from "./notifications.ts";
import { rankBetween } from "./rank.ts";
import {
  firstStatus,
  readWorkSettings,
  statusOf,
  type WorkSettings,
} from "./settings.ts";

// Tasks and subtasks (one level). Every change writes one history row per
// field, one content-free audit and one domain event; text changes are
// recorded as changed, never with the text.

export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export const TASK_SOURCES = [
  "manual",
  "assistant",
  "mcp",
  "pm_agent",
  "issue",
  "import",
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

const key = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const labelKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50000).nullable(),
  status: key,
  priority: z.enum(PRIORITIES),
  category: key.nullable(),
  labels: z
    .array(labelKey)
    .max(20)
    .transform((l) => [...new Set(l)]),
  assigneeUserId: z.string().min(1).max(100).nullable(),
  teamKey: key.nullable(),
  startDate: dateInput.nullable(),
  dueDate: dateInput.nullable(),
  estimate: z.int().min(0).max(1000).nullable(),
  initiativeId: uuid.nullable(),
  milestoneId: uuid.nullable(),
  parentTaskId: uuid.nullable(),
};
export const createTaskInput = z
  .object({
    title: fields.title,
    description: fields.description.optional(),
    status: fields.status.optional(),
    priority: fields.priority.optional(),
    category: fields.category.optional(),
    labels: fields.labels.optional(),
    assigneeUserId: fields.assigneeUserId.optional(),
    teamKey: fields.teamKey.optional(),
    startDate: fields.startDate.optional(),
    dueDate: fields.dueDate.optional(),
    estimate: fields.estimate.optional(),
    initiativeId: fields.initiativeId.optional(),
    milestoneId: fields.milestoneId.optional(),
    parentTaskId: fields.parentTaskId.optional(),
    checklist: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  })
  .strict();
export const updateTaskInput = z
  .object({
    expectedVersion,
    title: fields.title.optional(),
    description: fields.description.optional(),
    status: fields.status.optional(),
    priority: fields.priority.optional(),
    category: fields.category.optional(),
    labels: fields.labels.optional(),
    assigneeUserId: fields.assigneeUserId.optional(),
    teamKey: fields.teamKey.optional(),
    startDate: fields.startDate.optional(),
    dueDate: fields.dueDate.optional(),
    estimate: fields.estimate.optional(),
    initiativeId: fields.initiativeId.optional(),
    milestoneId: fields.milestoneId.optional(),
    parentTaskId: fields.parentTaskId.optional(),
  })
  .strict();
export const moveTaskInput = z
  .object({
    expectedVersion,
    status: key.optional(),
    /** The task the moved one comes right after (above it), if any. */
    afterTaskId: uuid.nullable().optional(),
    /** The task the moved one comes right before (below it), if any. */
    beforeTaskId: uuid.nullable().optional(),
  })
  .strict();
export type CreateTaskInput = z.input<typeof createTaskInput>;

export type TaskRow = Awaited<ReturnType<typeof loadTask>>;

export async function loadTask(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workTask.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export function taskView(row: TaskRow) {
  return {
    id: row.id,
    number: row.number,
    initiativeId: row.initiativeId,
    milestoneId: row.milestoneId,
    parentTaskId: row.parentTaskId,
    title: row.title,
    description: row.description,
    status: row.status,
    statusCategory: row.statusCategory,
    priority: row.priority,
    category: row.category,
    labels: row.labels,
    assigneeUserId: row.assigneeUserId,
    assigneeAgentKey: row.assigneeAgentKey,
    teamKey: row.teamKey,
    startDate: fromDate(row.startDate),
    dueDate: fromDate(row.dueDate),
    completedAt: row.completedAt?.toISOString() ?? null,
    estimate: row.estimate,
    rank: row.rank,
    source: row.source,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** The structure a task would have, checked before it is written. */
type Shape = {
  initiativeId: string | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  startDate: Date | null;
  dueDate: Date | null;
};

async function checkShape(
  tx: DbTx,
  scope: Scope,
  shape: Shape,
  taskId: string | null,
) {
  if (shape.startDate && shape.dueDate && shape.dueDate < shape.startDate)
    throw new DomainError("WORK_DATES_INVALID", 422);
  if (shape.initiativeId) {
    const initiative = await tx.workInitiative.findFirst({
      where: { projectId: scope.projectId, id: shape.initiativeId },
      select: { id: true },
    });
    if (!initiative) throw new DomainError("WORK_INITIATIVE_NOT_FOUND", 422);
  }
  if (shape.milestoneId) {
    const milestone = await tx.workMilestone.findFirst({
      where: { projectId: scope.projectId, id: shape.milestoneId },
      select: { initiativeId: true },
    });
    if (!milestone) throw new DomainError("WORK_MILESTONE_NOT_FOUND", 422);
    if (milestone.initiativeId !== shape.initiativeId)
      throw new DomainError("WORK_MILESTONE_MISMATCH", 409);
  }
  if (shape.parentTaskId) {
    if (shape.parentTaskId === taskId)
      throw new DomainError("WORK_PARENT_DEPTH", 409);
    const parent = await tx.workTask.findFirst({
      where: { projectId: scope.projectId, id: shape.parentTaskId },
      select: { parentTaskId: true },
    });
    if (!parent) throw new DomainError("WORK_PARENT_NOT_FOUND", 422);
    if (parent.parentTaskId) throw new DomainError("WORK_PARENT_DEPTH", 409);
    if (
      taskId &&
      (await tx.workTask.count({
        where: { projectId: scope.projectId, parentTaskId: taskId },
      }))
    )
      throw new DomainError("WORK_PARENT_DEPTH", 409);
  }
}

function checkSettings(
  settings: WorkSettings,
  input: { category?: string | null; teamKey?: string | null },
  current?: { category: string | null; teamKey: string | null },
) {
  if (
    input.category &&
    input.category !== current?.category &&
    !settings.categories.some((c) => c.key === input.category)
  )
    throw new DomainError("WORK_CATEGORY_UNKNOWN", 422);
  if (
    input.teamKey &&
    input.teamKey !== current?.teamKey &&
    !settings.teams.some((t) => t.key === input.teamKey)
  )
    throw new DomainError("WORK_TEAM_UNKNOWN", 422);
}

/** The next task number of the project; numbers are never reused. */
async function nextNumber(tx: DbTx, scope: Scope) {
  const [row] = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "WorkTaskCounter" ("workspaceId", "projectId", "lastNumber")
    VALUES (${scope.workspaceId}::uuid, ${scope.projectId}::uuid, 1)
    ON CONFLICT ("projectId") DO UPDATE SET "lastNumber" = "WorkTaskCounter"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return row!.lastNumber;
}

/** A rank after the project's last task. */
async function lastRank(tx: DbTx, scope: Scope) {
  const max = await tx.workTask.aggregate({
    where: { projectId: scope.projectId },
    _max: { rank: true },
  });
  return rankBetween(max._max.rank ?? null, null);
}

/**
 * Wakes the project's open boards and the task's views after the
 * transaction commits; the streams carry no content.
 */
export function changed(tx: DbTx, scope: Scope, task: { id: string }) {
  afterCommit(tx, () => {
    void publishChange(scope.projectId, `work-board:${scope.projectId}`);
    void publishChange(scope.projectId, `work-task:${task.id}`);
  });
}

const subject = (id: string) => ({ type: "work.task" as const, id });

export async function createTask(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: WorkActor,
  source: TaskSource = "manual",
  preloaded?: { settings?: WorkSettings; assignable?: Set<string> },
) {
  const input = createTaskInput.parse(raw);
  const settings = preloaded?.settings ?? (await readWorkSettings(tx, scope)).settings;
  const status = input.status
    ? statusOf(settings, input.status)
    : firstStatus(settings, "todo") ?? firstStatus(settings, "backlog");
  if (!status) throw new DomainError("WORK_STATUS_UNKNOWN", 422);
  checkSettings(settings, input);
  if (input.assigneeUserId) {
    const assignable = preloaded?.assignable ?? (await assignableIds(scope));
    if (!assignable.has(input.assigneeUserId))
      throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
  }
  let initiativeId = input.initiativeId ?? null;
  if (input.parentTaskId && input.initiativeId === undefined) {
    const parent = await tx.workTask.findFirst({
      where: { projectId: scope.projectId, id: input.parentTaskId },
      select: { initiativeId: true },
    });
    initiativeId = parent?.initiativeId ?? null;
  }
  const shape: Shape = {
    initiativeId,
    milestoneId: input.milestoneId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    startDate: toDate(input.startDate) ?? null,
    dueDate: toDate(input.dueDate) ?? null,
  };
  await checkShape(tx, scope, shape, null);
  const id = randomUUID();
  const number = await nextNumber(tx, scope);
  const now = new Date();
  await tx.workTask.create({
    data: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      number,
      ...shape,
      title: input.title,
      description: input.description ?? null,
      status: status.key,
      statusCategory: status.category,
      priority: input.priority ?? "none",
      category: input.category ?? null,
      labels: input.labels ?? [],
      assigneeUserId: input.assigneeUserId ?? null,
      teamKey: input.teamKey ?? null,
      estimate: input.estimate ?? null,
      completedAt: status.category === "done" ? now : null,
      rank: await lastRank(tx, scope),
      source,
      createdBy: actor.id ?? scope.userId,
    },
  });
  for (const [i, text] of (input.checklist ?? []).entries())
    await tx.workChecklistItem.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        taskId: id,
        text,
        sortOrder: i * 10,
      },
    });
  const task = await loadTask(tx, scope, id);
  await workEvent(tx, scope, { taskId: id }, "created", actor, {}, { number, status: status.key, source }, now);
  await audit(tx, scope, "work.task.created", id, { number, source });
  await workDomainEvent(tx, scope, "work.task.created", subject(id), actor, {
    number,
    status: status.key,
    statusCategory: status.category,
    initiativeId,
    source,
  });
  if (task.assigneeUserId)
    await notifyTask(tx, scope, "work_task_assigned", task, [task.assigneeUserId]);
  changed(tx, scope, task);
  return task;
}

const TEXT = new Set(["title", "description"]);
const EVENT_TYPE: Record<string, string> = {
  assigneeUserId: "assignee",
  teamKey: "team",
  startDate: "start_date",
  dueDate: "due_date",
  initiativeId: "initiative",
  milestoneId: "milestone",
  parentTaskId: "parent",
};

/**
 * Changes a task's fields. A status change follows the workflow, keeps the
 * category in step and sets or clears the completion time.
 */
export async function updateTask(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = updateTaskInput.parse(raw);
  const row = await loadTask(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  const settings = (await readWorkSettings(tx, scope)).settings;
  checkSettings(settings, input, row);
  const next: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    priority: input.priority,
    category: input.category,
    labels: input.labels,
    assigneeUserId: input.assigneeUserId,
    teamKey: input.teamKey,
    startDate: toDate(input.startDate),
    dueDate: toDate(input.dueDate),
    estimate: input.estimate,
    initiativeId: input.initiativeId,
    milestoneId: input.milestoneId,
    parentTaskId: input.parentTaskId,
  };
  // Leaving an initiative also leaves its milestone.
  if (
    input.initiativeId !== undefined &&
    input.initiativeId !== row.initiativeId &&
    input.milestoneId === undefined
  )
    next.milestoneId = null;
  if (
    input.assigneeUserId &&
    input.assigneeUserId !== row.assigneeUserId &&
    !(await assignableIds(scope)).has(input.assigneeUserId)
  )
    throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
  const pick = <K extends keyof Shape>(k: K): Shape[K] =>
    (next[k] === undefined ? row[k] : next[k]) as Shape[K];
  const structural = ["initiativeId", "milestoneId", "parentTaskId", "startDate", "dueDate"].some(
    (k) => next[k] !== undefined,
  );
  if (structural)
    await checkShape(
      tx,
      scope,
      {
        initiativeId: pick("initiativeId"),
        milestoneId: pick("milestoneId"),
        parentTaskId: pick("parentTaskId"),
        startDate: pick("startDate"),
        dueDate: pick("dueDate"),
      },
      row.id,
    );
  const now = new Date();
  const data: Record<string, unknown> = {};
  const fieldsChanged: string[] = [];
  const show = (v: unknown) => (v instanceof Date ? fromDate(v) : v);
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const prev = (row as Record<string, unknown>)[field];
    if (JSON.stringify(show(prev)) === JSON.stringify(show(value))) continue;
    data[field] = value;
    fieldsChanged.push(field);
    await workEvent(
      tx,
      scope,
      { taskId: row.id },
      EVENT_TYPE[field] ?? field,
      actor,
      TEXT.has(field) ? { changed: true } : { [field]: show(prev) },
      TEXT.has(field) ? { changed: true } : { [field]: show(value) },
      now,
    );
  }
  let statusChange: { from: string; to: string; fromCategory: string; toCategory: string } | null = null;
  if (input.status !== undefined && input.status !== row.status) {
    const status = statusOf(settings, input.status);
    if (!status) throw new DomainError("WORK_STATUS_UNKNOWN", 422);
    const allowed = settings.workflow.transitions?.[row.status];
    if (allowed && !allowed.includes(status.key))
      throw new DomainError("WORK_TRANSITION_NOT_ALLOWED", 409);
    data.status = status.key;
    data.statusCategory = status.category;
    if (status.category === "done" && row.statusCategory !== "done") data.completedAt = now;
    if (status.category !== "done") data.completedAt = null;
    fieldsChanged.push("status");
    statusChange = { from: row.status, to: status.key, fromCategory: row.statusCategory, toCategory: status.category };
    await workEvent(tx, scope, { taskId: row.id }, "status", actor, { status: row.status }, { status: status.key }, now);
  }
  if (!fieldsChanged.length) return row;
  await tx.workTask.update({
    where: { id: row.id },
    data: { ...data, version: { increment: 1 } },
  });
  const task = await loadTask(tx, scope, row.id);
  await audit(tx, scope, "work.task.updated", row.id, { number: row.number, fields: fieldsChanged });
  await workDomainEvent(tx, scope, "work.task.updated", subject(row.id), actor, {
    number: row.number,
    fields: fieldsChanged,
  });
  if (statusChange)
    await workDomainEvent(tx, scope, "work.task.status_changed", subject(row.id), actor, {
      number: row.number,
      ...statusChange,
    });
  if (fieldsChanged.includes("assigneeUserId")) {
    await workDomainEvent(tx, scope, "work.task.assigned", subject(row.id), actor, {
      number: row.number,
      assigneeUserId: task.assigneeUserId,
    });
    if (task.assigneeUserId)
      await notifyTask(tx, scope, "work_task_assigned", task, [task.assigneeUserId]);
  }
  if (statusChange)
    await notifyTask(tx, scope, "work_task_watched", task, await watcherIds(tx, scope, row.id));
  changed(tx, scope, task);
  return task;
}

/**
 * Moves a task on the board: an optional status change and a new place
 * between two neighbours, in one change.
 */
export async function moveTask(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = moveTaskInput.parse(raw);
  const row = await loadTask(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  const neighbour = async (taskId: string | null | undefined) => {
    if (!taskId) return null;
    if (taskId === row.id) throw new DomainError("WORK_RANK_ORDER", 409);
    const n = await tx.workTask.findFirst({
      where: { projectId: scope.projectId, id: taskId },
      select: { rank: true },
    });
    if (!n) throw new DomainError("NOT_FOUND", 404);
    return n.rank;
  };
  const above = await neighbour(input.afterTaskId);
  const below = await neighbour(input.beforeTaskId);
  let rank = row.rank;
  if (input.afterTaskId !== undefined || input.beforeTaskId !== undefined) {
    try {
      rank = rankBetween(above, below);
    } catch {
      throw new DomainError("WORK_RANK_ORDER", 409);
    }
  }
  let task = row;
  if (input.status !== undefined && input.status !== row.status)
    task = await updateTask(tx, scope, row.id, { expectedVersion: row.version, status: input.status }, actor);
  if (rank !== row.rank) {
    await tx.workTask.update({
      where: { id: row.id },
      data: { rank, version: { increment: 1 } },
    });
    await workEvent(tx, scope, { taskId: row.id }, "moved", actor);
    task = await loadTask(tx, scope, row.id);
    changed(tx, scope, task);
  }
  return task;
}

/** Archives or restores a task together with its subtasks. */
export async function setTaskArchived(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  archived: boolean,
  actor: WorkActor,
) {
  const input = z.object({ expectedVersion }).strict().parse(raw);
  const row = await loadTask(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  if (Boolean(row.archivedAt) === archived) return row;
  const ids = [
    row.id,
    ...(
      await tx.workTask.findMany({
        where: { projectId: scope.projectId, parentTaskId: row.id },
        select: { id: true },
      })
    ).map((t) => t.id),
  ];
  await tx.workTask.updateMany({
    where: { projectId: scope.projectId, id: { in: ids } },
    data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
  });
  const type = archived ? "archived" : "restored";
  const now = new Date();
  for (const taskId of ids) {
    await workEvent(tx, scope, { taskId }, type, actor, {}, {}, now);
    await workDomainEvent(tx, scope, `work.task.${type}`, subject(taskId), actor);
  }
  await audit(tx, scope, `work.task.${type}`, row.id, { number: row.number, tasks: ids.length });
  changed(tx, scope, row);
  return loadTask(tx, scope, row.id);
}

/**
 * Deletes a task. A task with subtasks needs `includeSubtasks`; links to
 * the deleted tasks are removed in the same transaction.
 */
export async function deleteTask(
  tx: DbTx,
  scope: Scope,
  id: string,
  includeSubtasks: boolean,
  actor: WorkActor,
) {
  const row = await loadTask(tx, scope, id);
  const children = await tx.workTask.findMany({
    where: { projectId: scope.projectId, parentTaskId: row.id },
    select: { id: true, number: true },
  });
  if (children.length && !includeSubtasks)
    throw new DomainError("WORK_HAS_SUBTASKS", 409);
  // Coding work orders stay as the record of what was dispatched (ADR 0017):
  // such a task is archived, not deleted.
  if (
    await tx.workCodingRun.count({
      where: { projectId: scope.projectId, taskId: { in: [row.id, ...children.map((c) => c.id)] } },
    })
  )
    throw new DomainError("WORK_TASK_HAS_CODING_RUNS", 409);
  for (const t of [...children, row]) {
    await removeLinksFor(tx, scope, subject(t.id), actor);
    await workDomainEvent(tx, scope, "work.task.deleted", subject(t.id), actor, { number: t.number });
  }
  const attached = await tx.workAttachment.findMany({
    where: { projectId: scope.projectId, taskId: { in: [row.id, ...children.map((c) => c.id)] } },
    select: { fileId: true },
  });
  await tx.workTask.delete({ where: { id: row.id } });
  // The attachments went with the tasks; their files follow unless held elsewhere.
  await releaseFiles(tx, scope, attached.map((a) => a.fileId));
  await audit(tx, scope, "work.task.deleted", row.id, {
    number: row.number,
    subtasks: children.length,
  });
  changed(tx, scope, row);
}

/** Creates up to 50 tasks in one transaction, for executors and imports. */
export async function createTasks(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: WorkActor,
  source: TaskSource,
) {
  const items = z.array(z.unknown()).min(1).max(50).parse(raw);
  const settings = (await readWorkSettings(tx, scope)).settings;
  const assignable = await assignableIds(scope);
  const created: TaskRow[] = [];
  for (const item of items)
    created.push(await createTask(tx, scope, item, actor, source, { settings, assignable }));
  return created;
}

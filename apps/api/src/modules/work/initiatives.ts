import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { removeLinksFor } from "../../platform/links/links.ts";
import {
  assertVersion,
  assignableIds,
  dateInput,
  expectedVersion,
  fromDate,
  toDate,
  uuid,
  workDomainEvent,
  workEvent,
  type WorkActor,
} from "./common.ts";
import { STATUS_CATEGORIES, type StatusCategory } from "./settings.ts";

// Initiatives ("Vorhaben"): a planned undertaking inside the Orbit project,
// with milestones and tasks. Archiving hides one; deleting needs it empty
// or its tasks detached.

export const INITIATIVE_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "completed",
  "canceled",
] as const;
export const INITIATIVE_HEALTH = [
  "unknown",
  "on_track",
  "at_risk",
  "off_track",
] as const;
const KEY = /^[A-Z][A-Z0-9]{1,9}$/;

const fields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50000).nullable(),
  status: z.enum(INITIATIVE_STATUSES),
  health: z.enum(INITIATIVE_HEALTH),
  ownerUserId: z.string().min(1).max(100).nullable(),
  startDate: dateInput.nullable(),
  targetDate: dateInput.nullable(),
};
export const createInitiativeInput = z
  .object({
    key: z.string().regex(KEY).optional(),
    title: fields.title,
    description: fields.description.optional(),
    status: fields.status.optional(),
    ownerUserId: fields.ownerUserId.optional(),
    startDate: fields.startDate.optional(),
    targetDate: fields.targetDate.optional(),
  })
  .strict();
export const updateInitiativeInput = z
  .object({
    expectedVersion,
    title: fields.title.optional(),
    description: fields.description.optional(),
    status: fields.status.optional(),
    health: fields.health.optional(),
    ownerUserId: fields.ownerUserId.optional(),
    startDate: fields.startDate.optional(),
    targetDate: fields.targetDate.optional(),
  })
  .strict();

type InitiativeRow = Awaited<ReturnType<typeof loadInitiative>>;

export function initiativeView(row: InitiativeRow) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status,
    health: row.health,
    ownerUserId: row.ownerUserId,
    startDate: fromDate(row.startDate),
    targetDate: fromDate(row.targetDate),
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export async function loadInitiative(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

function checkDates(start: Date | null | undefined, target: Date | null | undefined) {
  if (start && target && target < start)
    throw new DomainError("WORK_DATES_INVALID", 422);
}

async function checkOwner(scope: Scope, userId: string | null | undefined) {
  if (userId && !(await assignableIds(scope)).has(userId))
    throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
}

/** A free key from the title's initials, such as "ULM" or "ULM2". */
async function freeKey(tx: DbTx, scope: Scope, title: string) {
  const words = title
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let base = words.map((w) => w[0]).join("").slice(0, 6);
  if (base.length < 2) base = (words[0] ?? "INIT").slice(0, 4);
  if (base.length < 2) base = "IN";
  if (!/^[A-Z]/.test(base)) base = "I" + base.slice(0, 5);
  const taken = new Set(
    (
      await tx.workInitiative.findMany({
        where: { projectId: scope.projectId, key: { startsWith: base } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++)
    if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  throw new DomainError("WORK_KEY_TAKEN", 409);
}

export async function createInitiative(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: WorkActor,
) {
  const input = createInitiativeInput.parse(raw);
  const start = toDate(input.startDate);
  const target = toDate(input.targetDate);
  checkDates(start, target);
  await checkOwner(scope, input.ownerUserId);
  const key = input.key ?? (await freeKey(tx, scope, input.title));
  if (
    input.key &&
    (await tx.workInitiative.findFirst({
      where: { projectId: scope.projectId, key },
    }))
  )
    throw new DomainError("WORK_KEY_TAKEN", 409);
  const row = await tx.workInitiative.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      key,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "planned",
      ownerUserId: input.ownerUserId ?? null,
      startDate: start ?? null,
      targetDate: target ?? null,
      createdBy: actor.id ?? scope.userId,
    },
  });
  await workEvent(tx, scope, { initiativeId: row.id }, "created", actor, {}, { key });
  await audit(tx, scope, "work.initiative.created", row.id, { key });
  await workDomainEvent(tx, scope, "work.initiative.created", { type: "work.initiative", id: row.id }, actor);
  return row;
}

const TEXT = new Set(["title", "description"]);

export async function updateInitiative(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = updateInitiativeInput.parse(raw);
  const row = await loadInitiative(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  if (input.ownerUserId !== undefined) await checkOwner(scope, input.ownerUserId);
  const next = {
    title: input.title,
    description: input.description,
    status: input.status,
    health: input.health,
    ownerUserId: input.ownerUserId,
    startDate: toDate(input.startDate),
    targetDate: toDate(input.targetDate),
  };
  checkDates(
    next.startDate === undefined ? row.startDate : next.startDate,
    next.targetDate === undefined ? row.targetDate : next.targetDate,
  );
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const now = new Date();
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const prev = (row as Record<string, unknown>)[field];
    const same =
      value instanceof Date || prev instanceof Date
        ? fromDate(prev as Date | null) === fromDate(value as Date | null)
        : prev === value;
    if (same) continue;
    data[field] = value;
    changed.push(field);
    await workEvent(
      tx,
      scope,
      { initiativeId: row.id },
      field,
      actor,
      TEXT.has(field) ? { changed: true } : { [field]: prev instanceof Date ? fromDate(prev) : prev },
      TEXT.has(field) ? { changed: true } : { [field]: value instanceof Date ? fromDate(value) : value },
      now,
    );
  }
  if (!changed.length) return row;
  const updated = await tx.workInitiative.update({
    where: { id: row.id },
    data: { ...data, version: { increment: 1 } },
  });
  await audit(tx, scope, "work.initiative.updated", row.id, { fields: changed });
  await workDomainEvent(tx, scope, "work.initiative.updated", { type: "work.initiative", id: row.id }, actor, {
    fields: changed,
    ...(changed.includes("status") ? { status: updated.status } : {}),
  });
  return updated;
}

export async function setInitiativeArchived(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  archived: boolean,
  actor: WorkActor,
) {
  const input = z.object({ expectedVersion }).strict().parse(raw);
  const row = await loadInitiative(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  if (Boolean(row.archivedAt) === archived) return row;
  const updated = await tx.workInitiative.update({
    where: { id: row.id },
    data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
  });
  const type = archived ? "archived" : "restored";
  await workEvent(tx, scope, { initiativeId: row.id }, type, actor);
  await audit(tx, scope, `work.initiative.${type}`, row.id);
  await workDomainEvent(tx, scope, `work.initiative.${type}`, { type: "work.initiative", id: row.id }, actor);
  return updated;
}

/**
 * Deletes an initiative with its milestones. Refused while tasks belong to
 * it, unless `detachTasks`: then its tasks stay, without initiative and
 * milestone.
 */
export async function deleteInitiative(
  tx: DbTx,
  scope: Scope,
  id: string,
  detachTasks: boolean,
  actor: WorkActor,
) {
  const row = await loadInitiative(tx, scope, id);
  const tasks = await tx.workTask.findMany({
    where: { projectId: scope.projectId, initiativeId: row.id },
    select: { id: true },
  });
  if (tasks.length && !detachTasks)
    throw new DomainError("WORK_INITIATIVE_NOT_EMPTY", 409);
  const now = new Date();
  for (const task of tasks)
    await workEvent(tx, scope, { taskId: task.id }, "initiative", actor, { initiativeId: row.id }, { initiativeId: null }, now);
  if (tasks.length)
    await tx.workTask.updateMany({
      where: { projectId: scope.projectId, initiativeId: row.id },
      data: { initiativeId: null, milestoneId: null, version: { increment: 1 } },
    });
  const milestones = await tx.workMilestone.findMany({
    where: { projectId: scope.projectId, initiativeId: row.id },
    select: { id: true },
  });
  for (const m of milestones)
    await removeLinksFor(tx, scope, { type: "work.milestone", id: m.id }, actor);
  await removeLinksFor(tx, scope, { type: "work.initiative", id: row.id }, actor);
  await tx.workInitiative.delete({ where: { id: row.id } });
  await audit(tx, scope, "work.initiative.deleted", row.id, {
    key: row.key,
    detachedTasks: tasks.length,
  });
  await workDomainEvent(tx, scope, "work.initiative.deleted", { type: "work.initiative", id: row.id }, actor, {
    detachedTasks: tasks.length,
  });
}

/** Task counts per status category, open tasks overdue, for initiatives. */
export async function initiativeProgress(
  tx: DbTx,
  scope: Scope,
  initiativeIds: readonly string[],
) {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const empty = () =>
    Object.fromEntries(STATUS_CATEGORIES.map((c) => [c, 0])) as Record<StatusCategory, number>;
  const result = new Map(
    initiativeIds.map((id) => [id, { byCategory: empty(), total: 0, overdue: 0 }]),
  );
  if (!initiativeIds.length) return result;
  const groups = await tx.workTask.groupBy({
    by: ["initiativeId", "statusCategory"],
    where: {
      projectId: scope.projectId,
      initiativeId: { in: [...initiativeIds] },
      archivedAt: null,
      parentTaskId: null,
    },
    _count: { _all: true },
  });
  for (const g of groups) {
    const entry = result.get(g.initiativeId!);
    if (!entry) continue;
    entry.byCategory[g.statusCategory as StatusCategory] = g._count._all;
    entry.total += g._count._all;
  }
  const overdue = await tx.workTask.groupBy({
    by: ["initiativeId"],
    where: {
      projectId: scope.projectId,
      initiativeId: { in: [...initiativeIds] },
      archivedAt: null,
      dueDate: { lt: today },
      statusCategory: { notIn: ["done", "canceled"] },
    },
    _count: { _all: true },
  });
  for (const o of overdue) {
    const entry = result.get(o.initiativeId!);
    if (entry) entry.overdue = o._count._all;
  }
  return result;
}

export async function listInitiatives(
  tx: DbTx,
  scope: Scope,
  query: { status?: string; archived?: boolean },
) {
  const status = query.status ? z.enum(INITIATIVE_STATUSES).parse(query.status) : undefined;
  const rows = await tx.workInitiative.findMany({
    where: {
      projectId: scope.projectId,
      ...(status ? { status } : {}),
      archivedAt: query.archived ? { not: null } : null,
    },
    orderBy: [{ targetDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 200,
  });
  const progress = await initiativeProgress(tx, scope, rows.map((r) => r.id));
  return rows.map((r) => ({ ...initiativeView(r), progress: progress.get(r.id)! }));
}

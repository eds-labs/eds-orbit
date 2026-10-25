import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { removeLinksFor } from "../../platform/links/links.ts";
import {
  assertVersion,
  dateInput,
  expectedVersion,
  fromDate,
  toDate,
  uuid,
  workDomainEvent,
  workEvent,
  type WorkActor,
} from "./common.ts";
import { loadInitiative } from "./initiatives.ts";

// Milestones: dated checkpoints of one initiative. Deleting one keeps its
// tasks in the initiative, without the milestone.

export const MILESTONE_STATUSES = ["open", "reached", "missed", "canceled"] as const;

export const createMilestoneInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000).nullable().optional(),
    dueDate: dateInput.nullable().optional(),
    sortOrder: z.int().min(0).max(100000).optional(),
  })
  .strict();
export const updateMilestoneInput = z
  .object({
    expectedVersion,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20000).nullable().optional(),
    dueDate: dateInput.nullable().optional(),
    status: z.enum(MILESTONE_STATUSES).optional(),
    sortOrder: z.int().min(0).max(100000).optional(),
  })
  .strict();

type MilestoneRow = Awaited<ReturnType<typeof loadMilestone>>;

export function milestoneView(row: MilestoneRow) {
  return {
    id: row.id,
    initiativeId: row.initiativeId,
    title: row.title,
    description: row.description,
    dueDate: fromDate(row.dueDate),
    status: row.status,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export async function loadMilestone(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workMilestone.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export async function createMilestone(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = createMilestoneInput.parse(raw);
  const initiative = await loadInitiative(tx, scope, initiativeId);
  const row = await tx.workMilestone.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      initiativeId: initiative.id,
      title: input.title,
      description: input.description ?? null,
      dueDate: toDate(input.dueDate) ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.id ?? scope.userId,
    },
  });
  await workEvent(tx, scope, { milestoneId: row.id }, "created", actor);
  await audit(tx, scope, "work.milestone.created", row.id, { initiativeId: initiative.id });
  await workDomainEvent(tx, scope, "work.milestone.created", { type: "work.milestone", id: row.id }, actor, {
    initiativeId: initiative.id,
  });
  return row;
}

const TEXT = new Set(["title", "description"]);

export async function updateMilestone(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  actor: WorkActor,
) {
  const input = updateMilestoneInput.parse(raw);
  const row = await loadMilestone(tx, scope, id);
  assertVersion(row, input.expectedVersion);
  const next: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    dueDate: toDate(input.dueDate),
    status: input.status,
    sortOrder: input.sortOrder,
  };
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const now = new Date();
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const prev = (row as Record<string, unknown>)[field];
    const show = (v: unknown) => (v instanceof Date ? fromDate(v) : v);
    if (show(prev) === show(value)) continue;
    data[field] = value;
    changed.push(field);
    await workEvent(
      tx,
      scope,
      { milestoneId: row.id },
      field,
      actor,
      TEXT.has(field) ? { changed: true } : { [field]: show(prev) },
      TEXT.has(field) ? { changed: true } : { [field]: show(value) },
      now,
    );
  }
  if (!changed.length) return row;
  const updated = await tx.workMilestone.update({
    where: { id: row.id },
    data: { ...data, version: { increment: 1 } },
  });
  await audit(tx, scope, "work.milestone.updated", row.id, { fields: changed });
  await workDomainEvent(tx, scope, "work.milestone.updated", { type: "work.milestone", id: row.id }, actor, {
    initiativeId: row.initiativeId,
    fields: changed,
  });
  return updated;
}

/** Deletes a milestone; its tasks stay in the initiative without it. */
export async function deleteMilestone(
  tx: DbTx,
  scope: Scope,
  id: string,
  actor: WorkActor,
) {
  const row = await loadMilestone(tx, scope, id);
  const tasks = await tx.workTask.findMany({
    where: { projectId: scope.projectId, milestoneId: row.id },
    select: { id: true },
  });
  const now = new Date();
  for (const task of tasks)
    await workEvent(tx, scope, { taskId: task.id }, "milestone", actor, { milestoneId: row.id }, { milestoneId: null }, now);
  if (tasks.length)
    await tx.workTask.updateMany({
      where: { projectId: scope.projectId, milestoneId: row.id },
      data: { milestoneId: null, version: { increment: 1 } },
    });
  await removeLinksFor(tx, scope, { type: "work.milestone", id: row.id }, actor);
  await tx.workMilestone.delete({ where: { id: row.id } });
  await audit(tx, scope, "work.milestone.deleted", row.id, {
    initiativeId: row.initiativeId,
    detachedTasks: tasks.length,
  });
  await workDomainEvent(tx, scope, "work.milestone.deleted", { type: "work.milestone", id: row.id }, actor, {
    initiativeId: row.initiativeId,
  });
}

/** An initiative's milestones with open and total task counts. */
export async function listMilestones(tx: DbTx, scope: Scope, initiativeId?: string) {
  const rows = await tx.workMilestone.findMany({
    where: {
      projectId: scope.projectId,
      ...(initiativeId ? { initiativeId: uuid.parse(initiativeId) } : {}),
      archivedAt: null,
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { sortOrder: "asc" }, { createdAt: "asc" }],
    take: 500,
  });
  const counts = rows.length
    ? await tx.workTask.groupBy({
        by: ["milestoneId", "statusCategory"],
        where: {
          projectId: scope.projectId,
          milestoneId: { in: rows.map((r) => r.id) },
          archivedAt: null,
        },
        _count: { _all: true },
      })
    : [];
  return rows.map((r) => {
    const mine = counts.filter((c) => c.milestoneId === r.id);
    const total = mine.reduce((n, c) => n + c._count._all, 0);
    const closed = mine
      .filter((c) => c.statusCategory === "done" || c.statusCategory === "canceled")
      .reduce((n, c) => n + c._count._all, 0);
    return { ...milestoneView(r), tasks: { total, open: total - closed } };
  });
}

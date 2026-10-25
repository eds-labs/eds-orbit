import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { linksOf } from "../../platform/links/links.ts";
import { fromDate, uuid } from "./common.ts";
import { commentView } from "./parts.ts";
import { initiativeProgress, initiativeView, listInitiatives } from "./initiatives.ts";
import { milestoneView } from "./milestones.ts";
import { loadTask, PRIORITIES, taskView } from "./tasks.ts";
import { STATUS_CATEGORIES } from "./settings.ts";

// Reads: the task list with filters, search and sort; a task's detail with
// its history; my tasks; the overview. Lists are capped (MAX_MATCHES) and
// paged by offset, which is enough for one project's tasks.

const MAX_MATCHES = 2000;
const OPEN = ["backlog", "todo", "in_progress", "blocked", "in_review"];

export const listTasksQuery = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
    category: z.enum(STATUS_CATEGORIES).optional(),
    open: z.enum(["true", "false"]).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee: z.string().min(1).max(100).optional(),
    initiative: z.union([uuid, z.literal("none")]).optional(),
    milestone: uuid.optional(),
    label: z.string().trim().toLowerCase().max(40).optional(),
    team: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
    due: z.enum(["overdue", "week", "none"]).optional(),
    parent: z.union([uuid, z.literal("none")]).optional(),
    archived: z.enum(["true", "false"]).optional(),
    sort: z.enum(["rank", "due", "priority", "updated", "created", "number"]).optional(),
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const today = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const DAY = 86400000;

/** Ids of tasks whose title or description match every word (as a prefix). */
async function searchIds(tx: DbTx, scope: Scope, q: string) {
  const words = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!words.length) return [];
  const query = words.map((w) => `${w.toLowerCase()}:*`).join(" & ");
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "WorkTask"
    WHERE "projectId" = ${scope.projectId}::uuid
      AND "searchVector" @@ to_tsquery('simple', ${query})
    ORDER BY ts_rank("searchVector", to_tsquery('simple', ${query})) DESC
    LIMIT ${MAX_MATCHES}`;
  return rows.map((r) => r.id);
}

const listSelect = {
  id: true,
  number: true,
  initiativeId: true,
  milestoneId: true,
  parentTaskId: true,
  title: true,
  status: true,
  statusCategory: true,
  priority: true,
  category: true,
  labels: true,
  assigneeUserId: true,
  assigneeAgentKey: true,
  teamKey: true,
  startDate: true,
  dueDate: true,
  completedAt: true,
  estimate: true,
  rank: true,
  source: true,
  version: true,
  updatedAt: true,
  createdAt: true,
  archivedAt: true,
} as const;
type ListRow = {
  [K in keyof typeof listSelect]: K extends "startDate" | "dueDate" | "completedAt" | "archivedAt"
    ? Date | null
    : K extends "updatedAt" | "createdAt"
      ? Date
      : K extends "labels"
        ? string[]
        : K extends "number" | "version"
          ? number
          : K extends "estimate"
            ? number | null
            : K extends "initiativeId" | "milestoneId" | "parentTaskId" | "category" | "assigneeUserId" | "assigneeAgentKey" | "teamKey"
              ? string | null
              : string;
};

/** Subtask, checklist and open-blocker counts of listed tasks. */
async function listCounts(tx: DbTx, scope: Scope, ids: string[]) {
  if (!ids.length) return new Map<string, { subtasks: number; subtasksDone: number; checklist: number; checklistDone: number; blockedBy: number }>();
  const [subtasks, checklist, blockers] = await Promise.all([
    tx.workTask.groupBy({
      by: ["parentTaskId", "statusCategory"],
      where: { projectId: scope.projectId, parentTaskId: { in: ids }, archivedAt: null },
      _count: { _all: true },
    }),
    tx.workChecklistItem.groupBy({
      by: ["taskId", "done"],
      where: { projectId: scope.projectId, taskId: { in: ids } },
      _count: { _all: true },
    }),
    tx.$queryRaw<{ taskId: string; n: bigint }[]>`
      SELECT d."taskId", count(*) AS n FROM "WorkTaskDependency" d
      JOIN "WorkTask" b ON b."projectId" = d."projectId" AND b.id = d."dependsOnTaskId"
      WHERE d."projectId" = ${scope.projectId}::uuid AND d."taskId" = ANY(${ids}::uuid[])
        AND b."statusCategory" NOT IN ('done','canceled')
      GROUP BY d."taskId"`,
  ]);
  const counts = new Map(
    ids.map((id) => [id, { subtasks: 0, subtasksDone: 0, checklist: 0, checklistDone: 0, blockedBy: 0 }]),
  );
  for (const s of subtasks) {
    const c = counts.get(s.parentTaskId!)!;
    c.subtasks += s._count._all;
    if (s.statusCategory === "done" || s.statusCategory === "canceled") c.subtasksDone += s._count._all;
  }
  for (const item of checklist) {
    const c = counts.get(item.taskId)!;
    c.checklist += item._count._all;
    if (item.done) c.checklistDone += item._count._all;
  }
  for (const b of blockers) counts.get(b.taskId)!.blockedBy = Number(b.n);
  return counts;
}

export function listItem(row: ListRow) {
  return {
    id: row.id,
    number: row.number,
    initiativeId: row.initiativeId,
    milestoneId: row.milestoneId,
    parentTaskId: row.parentTaskId,
    title: row.title,
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
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

const PRIORITY_ORDER = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

export async function listTasks(tx: DbTx, scope: Scope, raw: unknown) {
  const q = listTasksQuery.parse(raw);
  const where: Record<string, unknown> = { projectId: scope.projectId };
  const and: Record<string, unknown>[] = [];
  where.archivedAt = q.archived === "true" ? { not: null } : null;
  if (q.status) where.status = q.status;
  if (q.category) where.statusCategory = q.category;
  else if (q.open === "true") where.statusCategory = { in: OPEN };
  if (q.priority) where.priority = q.priority;
  if (q.assignee === "me") where.assigneeUserId = scope.userId;
  else if (q.assignee === "none") and.push({ assigneeUserId: null, assigneeAgentKey: null });
  else if (q.assignee) where.assigneeUserId = q.assignee;
  if (q.initiative) where.initiativeId = q.initiative === "none" ? null : q.initiative;
  if (q.milestone) where.milestoneId = q.milestone;
  if (q.label) where.labels = { has: q.label };
  if (q.team) where.teamKey = q.team;
  if (q.parent) where.parentTaskId = q.parent === "none" ? null : q.parent;
  if (q.due === "overdue")
    and.push({ dueDate: { lt: today() }, statusCategory: { in: OPEN } });
  if (q.due === "week")
    and.push({ dueDate: { gte: today(), lt: new Date(today().getTime() + 7 * DAY) } });
  if (q.due === "none") where.dueDate = null;
  let ranked: string[] | null = null;
  if (q.q) {
    const number = /^#?(\d{1,9})$/.exec(q.q)?.[1];
    ranked = await searchIds(tx, scope, q.q);
    if (number) {
      const hit = await tx.workTask.findFirst({
        where: { projectId: scope.projectId, number: Number(number) },
        select: { id: true },
      });
      if (hit) ranked = [hit.id, ...ranked.filter((id) => id !== hit.id)];
    }
    and.push({ id: { in: ranked } });
  }
  if (and.length) where.AND = and;
  const rows = (await tx.workTask.findMany({
    where,
    select: listSelect,
    take: MAX_MATCHES,
    orderBy: { rank: "asc" },
  })) as ListRow[];
  const sort = q.sort ?? (ranked ? "relevance" : "rank");
  const time = (d: Date | null) => (d ? d.getTime() : Number.MAX_SAFE_INTEGER);
  if (sort === "relevance") {
    const order = new Map(ranked!.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else if (sort === "due") rows.sort((a, b) => time(a.dueDate) - time(b.dueDate) || a.number - b.number);
  else if (sort === "priority")
    rows.sort((a, b) => PRIORITY_ORDER[a.priority]! - PRIORITY_ORDER[b.priority]! || a.rank.localeCompare(b.rank));
  else if (sort === "updated") rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  else if (sort === "created") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  else if (sort === "number") rows.sort((a, b) => b.number - a.number);
  const offset = Number(q.cursor ?? 0);
  const limit = q.limit ?? 50;
  const page = rows.slice(offset, offset + limit);
  const counts = await listCounts(tx, scope, page.map((r) => r.id));
  return {
    items: page.map((r) => ({ ...listItem(r), counts: counts.get(r.id)! })),
    total: rows.length,
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
}

/** A task with everything that hangs on it and its history. */
export async function taskDetail(tx: DbTx, scope: Scope, id: string) {
  const task = await loadTask(tx, scope, id);
  const [subtasks, checklist, waitsFor, blocks, attachments, watchers, events, comments] = await Promise.all([
    tx.workTask.findMany({
      where: { projectId: scope.projectId, parentTaskId: task.id },
      select: listSelect,
      orderBy: { rank: "asc" },
    }) as Promise<ListRow[]>,
    tx.workChecklistItem.findMany({
      where: { projectId: scope.projectId, taskId: task.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    tx.workTaskDependency.findMany({ where: { projectId: scope.projectId, taskId: task.id } }),
    tx.workTaskDependency.findMany({ where: { projectId: scope.projectId, dependsOnTaskId: task.id } }),
    tx.workAttachment.findMany({
      where: { projectId: scope.projectId, taskId: task.id },
      orderBy: { createdAt: "asc" },
    }),
    tx.workTaskWatcher.findMany({ where: { projectId: scope.projectId, taskId: task.id } }),
    tx.workEvent.findMany({
      where: { projectId: scope.projectId, taskId: task.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    tx.workComment.findMany({
      where: { projectId: scope.projectId, taskId: task.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  const relatedIds = [
    ...waitsFor.map((d) => d.dependsOnTaskId),
    ...blocks.map((d) => d.taskId),
    ...(task.parentTaskId ? [task.parentTaskId] : []),
  ];
  const related = new Map(
    (
      await tx.workTask.findMany({
        where: { projectId: scope.projectId, id: { in: relatedIds } },
        select: { id: true, number: true, title: true, status: true, statusCategory: true },
      })
    ).map((t) => [t.id, t]),
  );
  const [initiative, milestone] = await Promise.all([
    task.initiativeId
      ? tx.workInitiative.findFirst({ where: { projectId: scope.projectId, id: task.initiativeId } })
      : null,
    task.milestoneId
      ? tx.workMilestone.findFirst({ where: { projectId: scope.projectId, id: task.milestoneId } })
      : null,
  ]);
  const timeline = [
    ...events.map((e) => ({
      kind: "event" as const,
      id: e.id,
      type: e.type,
      actorKind: e.actorKind,
      actorId: e.actorId,
      before: e.before,
      after: e.after,
      at: e.createdAt.toISOString(),
    })),
    ...comments.map((c) => ({ kind: "comment" as const, ...commentView(c), at: c.createdAt.toISOString() })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return {
    task: taskView(task),
    parent: task.parentTaskId ? (related.get(task.parentTaskId) ?? null) : null,
    initiative: initiative ? { id: initiative.id, key: initiative.key, title: initiative.title } : null,
    milestone: milestone ? milestoneView(milestone) : null,
    subtasks: subtasks.map(listItem),
    checklist: checklist.map((c) => ({
      id: c.id,
      text: c.text,
      done: c.done,
      doneBy: c.doneBy,
      doneAt: c.doneAt?.toISOString() ?? null,
      sortOrder: c.sortOrder,
    })),
    dependencies: {
      waitsFor: waitsFor.map((d) => ({ id: d.id, task: related.get(d.dependsOnTaskId) ?? null })),
      blocks: blocks.map((d) => ({ id: d.id, task: related.get(d.taskId) ?? null })),
    },
    links: await linksOf(tx, scope, { type: "work.task", id: task.id }),
    attachments: attachments.map((a) => ({
      id: a.id,
      fileId: a.fileId,
      name: a.name,
      mime: a.mime,
      size: a.size,
      addedBy: a.addedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    watchers: watchers.map((w) => w.userId),
    watching: watchers.some((w) => w.userId === scope.userId),
    timeline,
  };
}

/** My open tasks, grouped by due date. */
export async function myTasks(tx: DbTx, scope: Scope) {
  const rows = (await tx.workTask.findMany({
    where: {
      projectId: scope.projectId,
      assigneeUserId: scope.userId,
      archivedAt: null,
      statusCategory: { in: OPEN },
    },
    select: listSelect,
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { rank: "asc" }],
    take: 500,
  })) as ListRow[];
  const start = today().getTime();
  const group = (r: ListRow) => {
    if (!r.dueDate) return "none";
    const d = r.dueDate.getTime();
    if (d < start) return "overdue";
    if (d < start + DAY) return "today";
    if (d < start + 7 * DAY) return "week";
    return "later";
  };
  const groups: Record<string, ReturnType<typeof listItem>[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    none: [],
  };
  for (const r of rows) groups[group(r)]!.push(listItem(r));
  return groups;
}

/** The module's overview: counts, active initiatives and my next tasks. */
export async function overview(tx: DbTx, scope: Scope) {
  const base = { projectId: scope.projectId, archivedAt: null };
  const [byCategory, overdue, dueWeek, mine] = await Promise.all([
    tx.workTask.groupBy({ by: ["statusCategory"], where: base, _count: { _all: true } }),
    tx.workTask.count({ where: { ...base, statusCategory: { in: OPEN }, dueDate: { lt: today() } } }),
    tx.workTask.count({
      where: {
        ...base,
        statusCategory: { in: OPEN },
        dueDate: { gte: today(), lt: new Date(today().getTime() + 7 * DAY) },
      },
    }),
    tx.workTask.findMany({
      where: { ...base, assigneeUserId: scope.userId, statusCategory: { in: OPEN } },
      select: listSelect,
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { rank: "asc" }],
      take: 5,
    }) as Promise<ListRow[]>,
  ]);
  const counts = Object.fromEntries(STATUS_CATEGORIES.map((c) => [c, 0])) as Record<string, number>;
  for (const g of byCategory) counts[g.statusCategory] = g._count._all;
  const open = OPEN.reduce((n, c) => n + (counts[c] ?? 0), 0);
  const initiatives = (await listInitiatives(tx, scope, {})).filter(
    (i) => i.status === "active" || i.status === "planned",
  );
  return {
    counts: { open, overdue, dueThisWeek: dueWeek, blocked: counts.blocked ?? 0, byCategory: counts },
    initiatives: initiatives.slice(0, 12),
    myNext: mine.map(listItem),
  };
}

/** One initiative with milestones and progress. */
export async function initiativeDetail(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  const progress = (await initiativeProgress(tx, scope, [row.id])).get(row.id)!;
  return {
    initiative: { ...initiativeView(row), progress },
    links: await linksOf(tx, scope, { type: "work.initiative", id: row.id }),
  };
}

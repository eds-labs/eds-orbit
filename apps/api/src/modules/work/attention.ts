import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
} from "../../platform/attention/types.ts";
import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { audit } from "../../shared.ts";
import { workActive } from "./gate.ts";
import { notifyTask } from "./notifications.ts";
import { WORK_READ } from "./permissions.ts";
import { readWorkSettings } from "./settings.ts";

// What needs a member's attention in the module, computed at read time and
// never stored (UI restructure §4.1), and the daily due-date notices.
// Params stay empty: counts only, no titles.

const DAY = 86_400_000;
const OPEN = ["backlog", "todo", "in_progress", "blocked", "in_review"];
const startOfDay = (now: Date) =>
  new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);

export const workAttention: AttentionContribution = async (tx, scope, now) => {
  if (!can(scope, WORK_READ)) return [];
  if (!(await workActive(tx, scope))) return [];
  const today = startOfDay(now);
  const items: AttentionItem[] = [];
  const base = { moduleId: "work", params: {} } as const;
  const open = { projectId: scope.projectId, archivedAt: null, statusCategory: { in: OPEN } };

  const overdue = await tx.workTask.aggregate({
    where: { ...open, assigneeUserId: scope.userId, dueDate: { lt: today } },
    _count: { _all: true },
    _min: { dueDate: true },
  });
  if (overdue._count._all > 0)
    items.push({
      ...base,
      id: "work:overdue_mine",
      kind: "work_overdue_mine",
      severity: "warning",
      count: overdue._count._all,
      since: overdue._min.dueDate?.toISOString(),
      navKey: "work-my",
      link: "/work/my",
    });

  const blocked = await tx.workTask.count({
    where: { projectId: scope.projectId, archivedAt: null, statusCategory: "blocked" },
  });
  if (blocked > 0)
    items.push({
      ...base,
      id: "work:blocked",
      kind: "work_blocked",
      severity: "info",
      count: blocked,
      navKey: "work-board",
      link: "/work/tasks?category=blocked",
    });

  // Milestones due within a week that still have open tasks.
  const soon = await tx.workMilestone.findMany({
    where: {
      projectId: scope.projectId,
      archivedAt: null,
      status: "open",
      dueDate: { lt: new Date(today.getTime() + 7 * DAY) },
    },
    select: { id: true, dueDate: true },
    orderBy: { dueDate: "asc" },
    take: 50,
  });
  if (soon.length) {
    const withOpen = await tx.workTask.groupBy({
      by: ["milestoneId"],
      where: { ...open, milestoneId: { in: soon.map((m) => m.id) } },
      _count: { _all: true },
    });
    const due = soon.filter((m) => withOpen.some((g) => g.milestoneId === m.id));
    if (due.length)
      items.push({
        ...base,
        id: "work:milestones_due",
        kind: "work_milestone_due",
        severity: due.some((m) => m.dueDate && m.dueDate < today) ? "critical" : "warning",
        count: due.length,
        dueAt: due[0]!.dueDate?.toISOString(),
        navKey: "work-milestones",
        link: "/work/milestones",
      });
  }
  return items;
};

/**
 * Notifies assignees once a day about tasks due within the project's
 * `dueSoonDays` or overdue. An audit row per task and day ("due_notified")
 * keeps a restarted worker from sending the same notice twice.
 */
export async function sendDueNotices(tx: DbTx, scope: Scope, now: Date) {
  const today = startOfDay(now);
  const { settings } = await readWorkSettings(tx, scope);
  const until = new Date(today.getTime() + (settings.notifications.dueSoonDays + 1) * DAY);
  const tasks = await tx.workTask.findMany({
    where: {
      projectId: scope.projectId,
      archivedAt: null,
      statusCategory: { in: OPEN },
      assigneeUserId: { not: null },
      dueDate: { lt: until },
    },
    select: { id: true, number: true, title: true, assigneeUserId: true, dueDate: true },
    take: 500,
  });
  const date = today.toISOString().slice(0, 10);
  const sent = new Set(
    (
      await tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "work.task.due_notified",
          createdAt: { gte: today },
        },
        select: { resourceId: true },
      })
    ).map((a) => a.resourceId),
  );
  let count = 0;
  for (const task of tasks) {
    if (sent.has(task.id)) continue;
    await notifyTask(tx, { ...scope, userId: "system:work" }, "work_task_due", task, [task.assigneeUserId]);
    await audit(tx, { ...scope, userId: "system:work" }, "work.task.due_notified", task.id, {
      date,
      overdue: Boolean(task.dueDate && task.dueDate < today),
    });
    count++;
  }
  return count;
}

const nextRun = new Map<string, number>();
/** Tests only: forget the throttle. */
export function resetDueScanThrottle() {
  nextRun.clear();
}

/** The daily due-date notices; wakes the project the next morning. */
export const workDueScan: PeriodicTask = {
  name: "work-due-scan",
  async nextDueAt(tx, scope) {
    if (!(await workActive(tx, scope))) return null;
    const any = await tx.workTask.findFirst({
      where: {
        projectId: scope.projectId,
        archivedAt: null,
        statusCategory: { in: OPEN },
        assigneeUserId: { not: null },
        dueDate: { not: null },
      },
      select: { id: true },
    });
    if (!any) return null;
    return new Date(Math.max(Date.now(), nextRun.get(scope.projectId) ?? 0));
  },
  async run(scope) {
    const now = new Date();
    if (now.getTime() < (nextRun.get(scope.projectId) ?? 0)) return { status: "idle" };
    // 06:00 UTC the next day.
    const wakeAt = new Date(startOfDay(now).getTime() + DAY + 6 * 3_600_000);
    nextRun.set(scope.projectId, wakeAt.getTime());
    const sent = await scoped(scope.workspaceId, scope.projectId, async (tx) =>
      (await workActive(tx, scope)) ? sendDueNotices(tx, scope, now) : 0,
    );
    return { status: sent ? `sent ${sent}` : "idle", wakeAt };
  },
};

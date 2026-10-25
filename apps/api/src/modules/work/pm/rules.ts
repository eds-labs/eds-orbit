import { createHash } from "node:crypto";

// The monitor's deterministic rules (ADR 0017 P-6, plan §2.5): no AI, no
// cost. Rules read status categories, dates and links only, never titles
// or text. Each finding has a stable fingerprint, so a repeated scan
// updates the same finding instead of adding another.

const DAY = 86_400_000;
const CLOSED = new Set(["done", "canceled"]);

export type Severity = "info" | "warning" | "critical";
export type RuleFinding = {
  rule: string;
  severity: Severity;
  fingerprint: string;
  taskIds: string[];
  milestoneId: string | null;
  /** Numbers and codes only. */
  data: Record<string, number | string | null>;
};

export type SnapshotTask = {
  id: string;
  number: number;
  statusCategory: string;
  priority: string;
  dueDate: string | null;
  assigneeUserId: string | null;
  milestoneId: string | null;
  createdAt: Date;
  /** When the task entered its current category. */
  categorySince: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
};

export type Snapshot = {
  initiativeId: string;
  /** The project's today, YYYY-MM-DD. */
  today: string;
  now: Date;
  dueSoonDays: number;
  tasks: SnapshotTask[];
  dependencies: { taskId: string; dependsOnTaskId: string }[];
  milestones: { id: string; dueDate: string | null; status: string }[];
  /** The applied plan of the initiative, for scope growth. */
  plan: { appliedAt: Date; tasks: number } | null;
};

export const RULES = [
  "overdue",
  "due_soon_unstarted",
  "blocked_long",
  "dependency_late",
  "dependency_canceled",
  "stale_in_progress",
  "milestone_at_risk",
  "unassigned_priority",
  "scope_creep",
] as const;

/** Whole days from `a` to `b` (dates YYYY-MM-DD). */
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const olderThan = (at: Date, now: Date, n: number) => now.getTime() - at.getTime() > n * DAY;

export function evaluateRules(s: Snapshot): RuleFinding[] {
  const found: RuleFinding[] = [];
  const open = s.tasks.filter((t) => !CLOSED.has(t.statusCategory));
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const milestones = new Map(s.milestones.map((m) => [m.id, m]));
  const overdue = (t: SnapshotTask) => !!t.dueDate && t.dueDate < s.today && !CLOSED.has(t.statusCategory);

  for (const task of open) {
    const milestone = task.milestoneId ? milestones.get(task.milestoneId) : undefined;
    if (overdue(task)) {
      const milestoneSoon =
        !!milestone?.dueDate && milestone.status === "open" && days(s.today, milestone.dueDate) <= 3;
      found.push({
        rule: "overdue",
        severity: task.priority === "urgent" || milestoneSoon ? "critical" : "warning",
        fingerprint: `overdue:${task.id}`,
        taskIds: [task.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, daysOverdue: days(task.dueDate!, s.today) },
      });
    } else if (
      task.dueDate &&
      ["backlog", "todo"].includes(task.statusCategory) &&
      days(s.today, task.dueDate) <= s.dueSoonDays
    )
      found.push({
        rule: "due_soon_unstarted",
        severity: "info",
        fingerprint: `due_soon_unstarted:${task.id}`,
        taskIds: [task.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, daysLeft: days(s.today, task.dueDate) },
      });
    if (task.statusCategory === "blocked" && olderThan(task.categorySince, s.now, 3))
      found.push({
        rule: "blocked_long",
        severity: "warning",
        fingerprint: `blocked_long:${task.id}`,
        taskIds: [task.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, days: Math.floor((s.now.getTime() - task.categorySince.getTime()) / DAY) },
      });
    if (task.statusCategory === "in_progress" && olderThan(task.lastActivityAt, s.now, 7))
      found.push({
        rule: "stale_in_progress",
        severity: "info",
        fingerprint: `stale_in_progress:${task.id}`,
        taskIds: [task.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, days: Math.floor((s.now.getTime() - task.lastActivityAt.getTime()) / DAY) },
      });
    if (
      ["urgent", "high"].includes(task.priority) &&
      !task.assigneeUserId &&
      olderThan(task.createdAt, s.now, 1)
    )
      found.push({
        rule: "unassigned_priority",
        severity: "warning",
        fingerprint: `unassigned_priority:${task.id}`,
        taskIds: [task.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, priority: task.priority },
      });
  }

  for (const dep of s.dependencies) {
    const task = byId.get(dep.taskId);
    const blocker = byId.get(dep.dependsOnTaskId);
    if (!task || !blocker || CLOSED.has(task.statusCategory)) continue;
    if (blocker.statusCategory === "canceled")
      found.push({
        rule: "dependency_canceled",
        severity: "warning",
        fingerprint: `dependency_canceled:${task.id}:${blocker.id}`,
        taskIds: [task.id, blocker.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, blocker: blocker.number },
      });
    else if (
      !CLOSED.has(blocker.statusCategory) &&
      (overdue(blocker) || (!!blocker.dueDate && !!task.dueDate && blocker.dueDate > task.dueDate))
    )
      found.push({
        rule: "dependency_late",
        severity: "warning",
        fingerprint: `dependency_late:${task.id}:${blocker.id}`,
        taskIds: [task.id, blocker.id],
        milestoneId: task.milestoneId,
        data: { number: task.number, blocker: blocker.number },
      });
  }

  // Velocity: tasks finished per day over the last 14 days, when there are enough.
  const finished = s.tasks.filter(
    (t) => t.completedAt && !olderThan(t.completedAt, s.now, 14) && t.statusCategory === "done",
  ).length;
  const velocity = finished >= 5 ? finished / 14 : null;
  for (const milestone of s.milestones) {
    if (milestone.status !== "open" || !milestone.dueDate) continue;
    const tasks = open.filter((t) => t.milestoneId === milestone.id);
    if (!tasks.length) continue;
    const left = days(s.today, milestone.dueDate);
    const late = tasks.filter((t) => t.dueDate && t.dueDate > milestone.dueDate!);
    const tooMuch = velocity !== null && tasks.length > Math.max(0, left) * velocity;
    if (left >= 0 && !late.length && !tooMuch) continue;
    found.push({
      rule: "milestone_at_risk",
      severity: left <= 3 ? "critical" : "warning",
      fingerprint: `milestone_at_risk:${milestone.id}`,
      taskIds: (late.length ? late : tasks).slice(0, 50).map((t) => t.id),
      milestoneId: milestone.id,
      data: {
        daysLeft: left,
        openTasks: tasks.length,
        lateTasks: late.length,
        reason: left < 0 ? "overdue" : late.length ? "late_tasks" : "velocity",
      },
    });
  }

  if (s.plan && s.plan.tasks > 0) {
    const added = s.tasks.filter((t) => t.createdAt > s.plan!.appliedAt).length;
    if (added > s.plan.tasks * 0.3)
      found.push({
        rule: "scope_creep",
        severity: "info",
        fingerprint: `scope_creep:${s.initiativeId}`,
        taskIds: [],
        milestoneId: null,
        data: { planned: s.plan.tasks, added },
      });
  }
  return found;
}

/** A hash of what the AI would see: task states, dates and open findings. */
export function stateHash(s: Snapshot, findings: readonly RuleFinding[]) {
  const tasks = [...s.tasks]
    .sort((a, b) => a.number - b.number)
    .map((t) => [t.number, t.statusCategory, t.dueDate, t.priority, t.assigneeUserId, t.milestoneId]);
  const open = findings.map((f) => `${f.fingerprint}:${f.severity}`).sort();
  return createHash("sha256")
    .update(JSON.stringify({ tasks, milestones: s.milestones, open }))
    .digest("hex");
}

import { describe, expect, it } from "vitest";
import { evaluateRules, stateHash, type Snapshot, type SnapshotTask } from "../src/modules/work/pm/rules.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let next = 1;
const task = (over: Partial<SnapshotTask> = {}): SnapshotTask => {
  const n = next++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: n,
    statusCategory: "todo",
    priority: "medium",
    dueDate: null,
    assigneeUserId: "u1",
    milestoneId: null,
    createdAt: daysAgo(30),
    categorySince: daysAgo(30),
    lastActivityAt: daysAgo(1),
    completedAt: null,
    ...over,
  };
};
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  initiativeId: "init",
  today: "2026-11-20",
  now: NOW,
  dueSoonDays: 2,
  tasks: [],
  dependencies: [],
  milestones: [],
  plan: null,
  ...over,
});
const rules = (s: Snapshot) => evaluateRules(s).map((f) => [f.rule, f.severity]);

describe("AI project manager rules (ADR 0017 P-6)", () => {
  it("flags overdue tasks, critical when urgent or the milestone is close", () => {
    const milestone = { id: "m1", dueDate: "2026-11-22", status: "open" };
    const s = snapshot({
      milestones: [milestone],
      tasks: [
        task({ dueDate: "2026-11-19" }),
        task({ dueDate: "2026-11-19", priority: "urgent" }),
        task({ dueDate: "2026-11-18", milestoneId: "m1" }),
        task({ dueDate: "2026-11-01", statusCategory: "done" }),
      ],
    });
    expect(rules(s).filter(([r]) => r === "overdue")).toEqual([
      ["overdue", "warning"],
      ["overdue", "critical"],
      ["overdue", "critical"],
    ]);
    expect(evaluateRules(s)[0]).toMatchObject({ fingerprint: `overdue:${s.tasks[0]!.id}`, data: { daysOverdue: 1 } });
  });

  it("flags unstarted tasks due soon, long blocks, stale work and unassigned priorities", () => {
    expect(
      rules(
        snapshot({
          tasks: [
            task({ dueDate: "2026-11-22", statusCategory: "todo" }),
            task({ dueDate: "2026-11-22", statusCategory: "in_progress" }),
            task({ statusCategory: "blocked", categorySince: daysAgo(4) }),
            task({ statusCategory: "blocked", categorySince: daysAgo(2) }),
            task({ statusCategory: "in_progress", lastActivityAt: daysAgo(8) }),
            task({ priority: "high", assigneeUserId: null, createdAt: daysAgo(2) }),
            task({ priority: "high", assigneeUserId: null, createdAt: daysAgo(0.5) }),
          ],
        }),
      ),
    ).toEqual([
      ["due_soon_unstarted", "info"],
      ["blocked_long", "warning"],
      ["stale_in_progress", "info"],
      ["unassigned_priority", "warning"],
    ]);
  });

  it("flags late and canceled blockers", () => {
    const blocker = task({ dueDate: "2026-11-25" });
    const waiting = task({ dueDate: "2026-11-24" });
    const canceled = task({ statusCategory: "canceled" });
    const after = task();
    const s = snapshot({
      tasks: [blocker, waiting, canceled, after],
      dependencies: [
        { taskId: waiting.id, dependsOnTaskId: blocker.id },
        { taskId: after.id, dependsOnTaskId: canceled.id },
      ],
    });
    expect(evaluateRules(s).map((f) => [f.rule, f.fingerprint])).toEqual([
      ["dependency_late", `dependency_late:${waiting.id}:${blocker.id}`],
      ["dependency_canceled", `dependency_canceled:${after.id}:${canceled.id}`],
    ]);
  });

  it("flags milestones at risk by late tasks, by velocity and when overdue", () => {
    const done = Array.from({ length: 7 }, () => task({ statusCategory: "done", completedAt: daysAgo(5) }));
    const late = snapshot({
      milestones: [{ id: "m1", dueDate: "2026-12-10", status: "open" }],
      tasks: [task({ milestoneId: "m1", dueDate: "2026-12-12" }), task({ milestoneId: "m1" })],
    });
    expect(evaluateRules(late).find((f) => f.rule === "milestone_at_risk")).toMatchObject({
      severity: "warning",
      data: { reason: "late_tasks", lateTasks: 1, openTasks: 2 },
    });
    // 7 done in 14 days = 0.5 a day; 2 days left for 3 open tasks.
    const slow = snapshot({
      milestones: [{ id: "m2", dueDate: "2026-11-22", status: "open" }],
      tasks: [...done, task({ milestoneId: "m2" }), task({ milestoneId: "m2" }), task({ milestoneId: "m2" })],
    });
    expect(evaluateRules(slow).find((f) => f.rule === "milestone_at_risk")).toMatchObject({
      severity: "critical",
      data: { reason: "velocity" },
    });
    const overdue = snapshot({
      milestones: [{ id: "m3", dueDate: "2026-11-10", status: "open" }],
      tasks: [task({ milestoneId: "m3" })],
    });
    expect(evaluateRules(overdue).find((f) => f.rule === "milestone_at_risk")?.data.reason).toBe("overdue");
    // Without enough finished tasks there is no velocity guess.
    const unknown = snapshot({
      milestones: [{ id: "m4", dueDate: "2026-11-22", status: "open" }],
      tasks: [task({ milestoneId: "m4" }), task({ milestoneId: "m4" }), task({ milestoneId: "m4" })],
    });
    expect(evaluateRules(unknown)).toEqual([]);
  });

  it("flags scope growth over 30 % after an applied plan", () => {
    const appliedAt = daysAgo(10);
    const planned = Array.from({ length: 10 }, () => task({ createdAt: appliedAt }));
    const added = Array.from({ length: 4 }, () => task({ createdAt: daysAgo(2) }));
    expect(rules(snapshot({ tasks: [...planned, ...added], plan: { appliedAt, tasks: 10 } }))).toEqual([["scope_creep", "info"]]);
    expect(rules(snapshot({ tasks: [...planned, ...added.slice(0, 3)], plan: { appliedAt, tasks: 10 } }))).toEqual([]);
  });

  it("hashes the state the AI would see, independent of order", () => {
    const a = task({ dueDate: "2026-11-30" });
    const b = task();
    const one = snapshot({ tasks: [a, b] });
    const two = snapshot({ tasks: [b, a] });
    expect(stateHash(one, [])).toBe(stateHash(two, []));
    expect(stateHash(snapshot({ tasks: [a, { ...b, statusCategory: "done" }] }), [])).not.toBe(stateHash(one, []));
  });
});

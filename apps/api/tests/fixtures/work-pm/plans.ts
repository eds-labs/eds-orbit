import type { WorkPlan } from "../../../src/modules/work/pm/plan-schema.ts";

/**
 * A synthetic plan of `count` tasks in three milestones: each task after
 * the first of a milestone depends on the one before it, and every fifth
 * task has a subtask.
 */
export function syntheticPlan(count = 30, overrides: Partial<WorkPlan> = {}): WorkPlan {
  const due = ["2026-11-15", "2026-12-15", "2027-01-15"];
  const milestones = [1, 2, 3].map((n) => ({
    ref: `m${n}`,
    title: `Milestone ${n}`,
    dueDate: due[n - 1]!,
    criteria: `Criteria ${n}`,
  }));
  const tasks: WorkPlan["tasks"] = [];
  for (let n = 1; n <= count; n++) {
    const milestone = `m${Math.min(3, Math.ceil((n / count) * 3))}`;
    const previous = tasks.at(-1);
    const parent = n % 5 === 0 && previous && !previous.parentRef ? previous.ref : null;
    tasks.push({
      ref: `t${n}`,
      title: `Task ${n}`,
      description: `Do part ${n}.`,
      workstreamRef: n % 2 ? "ws1" : "ws2",
      milestoneRef: parent ? previous!.milestoneRef : milestone,
      parentRef: parent,
      priority: n % 7 === 0 ? "high" : "medium",
      estimate: 4,
      dueDate: null,
      suggestedRole: null,
      suggestedAssigneeUserId: null,
      acceptanceCriteria: [`Part ${n} works`],
      dependsOn: previous && !parent && previous.milestoneRef === milestone ? [previous.ref] : [],
    });
  }
  return {
    goal: "Launch the marketplace",
    scope: { in: ["Listings"], out: ["Payments"] },
    initiative: { title: "Marketplace launch", key: null, startDate: "2026-11-01", targetDate: "2027-01-31" },
    workstreams: [
      { ref: "ws1", title: "Product", summary: "" },
      { ref: "ws2", title: "Launch", summary: "" },
    ],
    milestones,
    tasks,
    risks: [{ title: "Late partner", impact: "medium", mitigation: "Start early" }],
    openDecisions: [{ question: "Which region first?", options: ["EU", "US"], recommendation: null }],
    assumptions: ["Two developers"],
    ...overrides,
  };
}

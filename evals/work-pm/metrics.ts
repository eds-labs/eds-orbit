import { workPlanSchema, type WorkPlan } from "../../apps/api/src/modules/work/pm/plan-schema.ts";
import { validatePlan } from "../../apps/api/src/modules/work/pm/plan-validate.ts";

// Structural quality of AI plans (WP2.11): measured on ids, refs and
// counts only, never on plan text. The thresholds gate switching
// ORBIT_WORK_PM on (DoD 10).

export const THRESHOLDS = {
  schemaValidRate: 1,
  acyclicRate: 1,
  /** No assignee outside the members list, ever. */
  inventedAssignees: 0,
  /** Share of tasks with acceptance criteria. */
  criteriaShare: 0.9,
  /** Share of tasks in a milestone. */
  milestoneCoverage: 0.8,
  meanTasks: { min: 15, max: 60 },
} as const;

export type PlanScore = {
  id: string;
  schemaValid: boolean;
  errors: string[];
  tasks: number;
  milestones: number;
  inventedAssignees: number;
  criteriaShare: number;
  milestoneCoverage: number;
  costMicros?: number;
};

export function scorePlan(id: string, answer: unknown, members: ReadonlySet<string>): PlanScore {
  const parsed = workPlanSchema.safeParse(answer);
  if (!parsed.success)
    return {
      id,
      schemaValid: false,
      errors: ["SCHEMA"],
      tasks: 0,
      milestones: 0,
      inventedAssignees: 0,
      criteriaShare: 0,
      milestoneCoverage: 0,
    };
  const plan: WorkPlan = parsed.data;
  const { validation } = validatePlan(plan, { assignable: members });
  const tasks = plan.tasks.length;
  return {
    id,
    schemaValid: true,
    errors: validation.errors,
    tasks,
    milestones: plan.milestones.length,
    inventedAssignees: validation.warnings.filter((w) => w.startsWith("assignee_dropped:")).length,
    criteriaShare: tasks ? plan.tasks.filter((t) => t.acceptanceCriteria.length > 0).length / tasks : 0,
    milestoneCoverage: tasks ? plan.tasks.filter((t) => t.milestoneRef).length / tasks : 0,
  };
}

export function aggregate(scores: readonly PlanScore[]) {
  const n = scores.length || 1;
  const valid = scores.filter((s) => s.schemaValid);
  const mean = (f: (s: PlanScore) => number) => (valid.length ? valid.reduce((a, s) => a + f(s), 0) / valid.length : 0);
  const summary = {
    plans: scores.length,
    schemaValidRate: valid.length / n,
    acyclicRate: valid.filter((s) => !s.errors.includes("PLAN_DEPENDENCY_CYCLE")).length / n,
    validRate: valid.filter((s) => s.errors.length === 0).length / n,
    inventedAssignees: scores.reduce((a, s) => a + s.inventedAssignees, 0),
    criteriaShare: mean((s) => s.criteriaShare),
    milestoneCoverage: mean((s) => s.milestoneCoverage),
    meanTasks: mean((s) => s.tasks),
    costMicros: scores.reduce((a, s) => a + (s.costMicros ?? 0), 0),
  };
  const failed = [
    summary.schemaValidRate < THRESHOLDS.schemaValidRate && "schemaValidRate",
    summary.acyclicRate < THRESHOLDS.acyclicRate && "acyclicRate",
    summary.inventedAssignees > THRESHOLDS.inventedAssignees && "inventedAssignees",
    summary.criteriaShare < THRESHOLDS.criteriaShare && "criteriaShare",
    summary.milestoneCoverage < THRESHOLDS.milestoneCoverage && "milestoneCoverage",
    (summary.meanTasks < THRESHOLDS.meanTasks.min || summary.meanTasks > THRESHOLDS.meanTasks.max) && "meanTasks",
  ].filter((x): x is string => !!x);
  return { ...summary, passed: failed.length === 0, failed };
}

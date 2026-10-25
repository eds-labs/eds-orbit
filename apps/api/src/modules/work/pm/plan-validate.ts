import type { WorkPlan } from "./plan-schema.ts";

// Deterministic checks of a plan after the model (plan §2.4). Errors make
// the proposal invalid (no approval request); warnings are shown in the
// review. Codes carry refs only, never plan text. A suggested assignee who
// may not own work in the module is dropped, never kept or invented.

export type PlanValidation = { errors: string[]; warnings: string[] };

export type PlanContext = {
  /** Members who may own work: owners and editors in the module. */
  assignable: ReadonlySet<string>;
  /** Initiative keys already used in the project (a new plan's key must be free). */
  takenKeys?: ReadonlySet<string>;
};

function duplicates(refs: string[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => (seen.has(ref) ? true : (seen.add(ref), false)));
}

/** True when the dependency graph has a cycle (including a self-dependency). */
function hasCycle(edges: Map<string, readonly string[]>) {
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): boolean => {
    const s = state.get(node);
    if (s === "visiting") return true;
    if (s === "done") return false;
    state.set(node, "visiting");
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    state.set(node, "done");
    return false;
  };
  return [...edges.keys()].some(visit);
}

/** Returns the plan as it may be applied and its validation result. */
export function validatePlan(
  input: WorkPlan,
  context: PlanContext,
): { plan: WorkPlan; validation: PlanValidation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const plan: WorkPlan = structuredClone(input);

  const taskRefs = plan.tasks.map((t) => t.ref);
  const milestoneRefs = plan.milestones.map((m) => m.ref);
  const workstreamRefs = plan.workstreams.map((w) => w.ref);
  for (const ref of [
    ...duplicates(taskRefs),
    ...duplicates(milestoneRefs),
    ...duplicates(workstreamRefs),
  ])
    errors.push(`PLAN_REF_DUPLICATE:${ref}`);

  const tasks = new Map(plan.tasks.map((t) => [t.ref, t]));
  const milestones = new Map(plan.milestones.map((m) => [m.ref, m]));
  const workstreams = new Set(workstreamRefs);
  for (const task of plan.tasks) {
    if (task.workstreamRef && !workstreams.has(task.workstreamRef))
      errors.push(`PLAN_REF_UNKNOWN:${task.ref}.workstreamRef`);
    if (task.milestoneRef && !milestones.has(task.milestoneRef))
      errors.push(`PLAN_REF_UNKNOWN:${task.ref}.milestoneRef`);
    if (task.parentRef) {
      const parent = tasks.get(task.parentRef);
      if (!parent) errors.push(`PLAN_REF_UNKNOWN:${task.ref}.parentRef`);
      // Subtasks are one level deep (ADR 0016), and never their own parent.
      else if (parent.ref === task.ref || parent.parentRef)
        errors.push(`PLAN_SUBTASK_DEPTH:${task.ref}`);
    }
    for (const ref of task.dependsOn)
      if (!tasks.has(ref)) errors.push(`PLAN_REF_UNKNOWN:${task.ref}.dependsOn`);
    if (
      task.suggestedAssigneeUserId &&
      !context.assignable.has(task.suggestedAssigneeUserId)
    ) {
      task.suggestedAssigneeUserId = null;
      warnings.push(`assignee_dropped:${task.ref}`);
    }
    if (!task.acceptanceCriteria.length) warnings.push(`no_acceptance_criteria:${task.ref}`);
  }
  if (
    hasCycle(
      new Map(plan.tasks.map((t) => [t.ref, t.dependsOn.filter((d) => tasks.has(d))])),
    )
  )
    errors.push("PLAN_DEPENDENCY_CYCLE");

  const { startDate, targetDate } = plan.initiative;
  if (startDate && targetDate && targetDate < startDate)
    errors.push("PLAN_DATES_INVALID");
  if (plan.initiative.key && context.takenKeys?.has(plan.initiative.key)) {
    // Another initiative uses the key: the apply step picks a free one.
    plan.initiative.key = null;
    warnings.push("initiative_key_taken");
  }
  const outside = (date: string | null) =>
    !!date && ((!!startDate && date < startDate) || (!!targetDate && date > targetDate));
  for (const milestone of plan.milestones)
    if (outside(milestone.dueDate)) warnings.push(`milestone_outside_window:${milestone.ref}`);
  for (const task of plan.tasks) {
    if (outside(task.dueDate)) warnings.push(`task_outside_window:${task.ref}`);
    const milestone = task.milestoneRef ? milestones.get(task.milestoneRef) : undefined;
    if (task.dueDate && milestone?.dueDate && task.dueDate > milestone.dueDate)
      warnings.push(`task_due_after_milestone:${task.ref}`);
    // A blocker planned for a later milestone than the task it blocks.
    for (const ref of task.dependsOn) {
      const blocker = tasks.get(ref);
      const blockerMilestone = blocker?.milestoneRef ? milestones.get(blocker.milestoneRef) : undefined;
      if (
        milestone?.dueDate &&
        blockerMilestone?.dueDate &&
        blockerMilestone.dueDate > milestone.dueDate
      )
        warnings.push(`dependency_after_milestone:${task.ref}`);
    }
  }
  return {
    plan,
    validation: { errors: [...new Set(errors)], warnings: [...new Set(warnings)] },
  };
}

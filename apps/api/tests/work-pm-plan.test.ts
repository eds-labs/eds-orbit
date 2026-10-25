import { describe, expect, it } from "vitest";
import { structuredOutputSchema } from "../src/platform/agents/structured-run.ts";
import { workPlanSchema } from "../src/modules/work/pm/plan-schema.ts";
import { validatePlan } from "../src/modules/work/pm/plan-validate.ts";
import { syntheticPlan } from "./fixtures/work-pm/plans.ts";

const none = { assignable: new Set<string>() };

describe("AI project manager plans (ADR 0017)", () => {
  it("accepts a synthetic 30-task plan and gives the model a strict schema", () => {
    const plan = workPlanSchema.parse(syntheticPlan(30));
    expect(validatePlan(plan, none).validation).toEqual({ errors: [], warnings: [] });
    const schema = JSON.stringify(structuredOutputSchema(workPlanSchema));
    // Strict mode cannot express string lengths; they are refinements.
    expect(schema).not.toMatch(/"(maxLength|minLength)"/);
    expect(schema).toContain('"additionalProperties":false');
  });

  it("refuses over-long text and too many tasks", () => {
    expect(workPlanSchema.safeParse({ ...syntheticPlan(3), goal: "x".repeat(1001) }).success).toBe(false);
    expect(workPlanSchema.safeParse(syntheticPlan(81)).success).toBe(false);
  });

  it("finds unknown and duplicate refs, cycles and deep subtasks", () => {
    const plan = syntheticPlan(6);
    plan.tasks[1]!.dependsOn = ["t9"];
    plan.tasks[2]!.milestoneRef = "m9";
    plan.tasks[3]!.ref = "t1";
    expect(validatePlan(plan, none).validation.errors).toEqual(
      expect.arrayContaining(["PLAN_REF_DUPLICATE:t1", "PLAN_REF_UNKNOWN:t2.dependsOn", "PLAN_REF_UNKNOWN:t3.milestoneRef"]),
    );
    const cyclic = syntheticPlan(4);
    cyclic.tasks[0]!.dependsOn = ["t3"];
    cyclic.tasks[2]!.dependsOn = ["t2"];
    cyclic.tasks[1]!.dependsOn = ["t1"];
    expect(validatePlan(cyclic, none).validation.errors).toContain("PLAN_DEPENDENCY_CYCLE");
    const self = syntheticPlan(2);
    self.tasks[0]!.dependsOn = ["t1"];
    expect(validatePlan(self, none).validation.errors).toContain("PLAN_DEPENDENCY_CYCLE");
    const deep = syntheticPlan(3);
    deep.tasks[1]!.parentRef = "t1";
    deep.tasks[2]!.parentRef = "t2";
    expect(validatePlan(deep, none).validation.errors).toContain("PLAN_SUBTASK_DEPTH:t3");
  });

  it("drops invented assignees and taken keys, and warns about dates", () => {
    const plan = syntheticPlan(3, {
      initiative: { title: "X", key: "TAKEN", startDate: "2026-11-01", targetDate: "2026-12-01" },
    });
    plan.tasks[0]!.suggestedAssigneeUserId = "invented-user";
    plan.tasks[1]!.suggestedAssigneeUserId = "member-1";
    plan.tasks[2]!.dueDate = "2027-05-01";
    const { plan: checked, validation } = validatePlan(plan, {
      assignable: new Set(["member-1"]),
      takenKeys: new Set(["TAKEN"]),
    });
    expect(checked.tasks.map((t) => t.suggestedAssigneeUserId)).toEqual([null, "member-1", null]);
    expect(checked.initiative.key).toBeNull();
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual(
      expect.arrayContaining(["assignee_dropped:t1", "initiative_key_taken", "task_outside_window:t3"]),
    );
    // The input is not changed.
    expect(plan.tasks[0]!.suggestedAssigneeUserId).toBe("invented-user");
    const backwards = syntheticPlan(2, {
      initiative: { title: "X", key: null, startDate: "2026-12-01", targetDate: "2026-11-01" },
    });
    expect(validatePlan(backwards, none).validation.errors).toContain("PLAN_DATES_INVALID");
  });
});

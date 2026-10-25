import { describe, expect, it } from "vitest";
import { syntheticPlan } from "../../apps/api/tests/fixtures/work-pm/plans.ts";
import { aggregate, scorePlan, THRESHOLDS } from "./metrics.ts";
import { CEILING_MICROS, plan } from "./live-plan.ts";

const members = new Set(["u-editor-0002"]);
// Within the rate card's validity, so the plan does not depend on today.
const NOW = new Date("2026-10-25T12:00:00Z");

describe("AI project manager eval (WP2.11)", () => {
  it("passes good plans and names every failed threshold", () => {
    const good = [scorePlan("a", syntheticPlan(30), members), scorePlan("b", syntheticPlan(20), members)];
    expect(aggregate(good)).toMatchObject({ passed: true, failed: [], schemaValidRate: 1, meanTasks: 25 });
    const invented = syntheticPlan(20);
    invented.tasks[0]!.suggestedAssigneeUserId = "evil-9999";
    const noCriteria = syntheticPlan(20);
    for (const t of noCriteria.tasks) t.acceptanceCriteria = [];
    const scores = [
      scorePlan("c", invented, members),
      scorePlan("d", noCriteria, members),
      scorePlan("e", { not: "a plan" }, members),
    ];
    expect(scores[0]!.inventedAssignees).toBe(1);
    expect(aggregate(scores).failed).toEqual(["schemaValidRate", "acyclicRate", "inventedAssignees", "criteriaShare"]);
  });

  it("plans six goals under the USD 2 ceiling, which ORBIT_EVAL_MAX_USD only lowers", () => {
    const p = plan({}, NOW);
    expect(p.calls).toBe(6);
    expect(p.maxCostMicros).toBe(CEILING_MICROS);
    expect(p.worstCaseMicros).toBeGreaterThan(0);
    expect(p.confirmation).toMatch(/^work-pm-eval-[a-f0-9]{16}$/);
    expect(plan({ ORBIT_EVAL_MAX_USD: "0.5" }, NOW).maxCostMicros).toBe(500_000);
    expect(plan({ ORBIT_EVAL_MAX_USD: "9" }, NOW).maxCostMicros).toBe(CEILING_MICROS);
    expect(() => plan({ ORBIT_EVAL_MAX_USD: "-1" }, NOW)).toThrow("EVAL_MAX_USD_INVALID");
    expect(THRESHOLDS.meanTasks).toEqual({ min: 15, max: 60 });
  });
});

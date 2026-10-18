import { describe, expect, it } from "vitest";
import { CEILING_MICROS, plan } from "./live-plan.ts";

// Offline checks of the paid support eval's plan (WP5.6).
describe("support AI eval plan", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("fits the worst case under the 3 USD ceiling", () => {
    const p = plan({}, now);
    expect(p.calls).toBe(20);
    expect(p.maxCostMicros).toBe(CEILING_MICROS);
    expect(p.worstCaseMicros).toBeLessThan(p.maxCostMicros);
    expect(p.confirmation).toMatch(/^support-eval-[0-9a-f]{16}$/);
  });
  it("lets ORBIT_EVAL_MAX_USD only lower the ceiling", () => {
    expect(plan({ ORBIT_EVAL_MAX_USD: "50" }, now).maxCostMicros).toBe(
      CEILING_MICROS,
    );
    expect(plan({ ORBIT_EVAL_MAX_USD: "0.5" }, now).maxCostMicros).toBe(
      500_000,
    );
    for (const bad of ["", "abc", "-1", "0"])
      expect(() => plan({ ORBIT_EVAL_MAX_USD: bad }, now)).toThrow(
        "EVAL_MAX_USD_INVALID",
      );
    // A different ceiling is a different plan.
    expect(plan({ ORBIT_EVAL_MAX_USD: "0.5" }, now).confirmation).not.toBe(
      plan({}, now).confirmation,
    );
  });
  it("uses only synthetic cases with an expected outcome", () => {
    const { set } = plan({}, now);
    for (const c of set.triage) expect(set.categories).toContain(c.category);
    for (const c of set.drafts)
      expect(c.facts.length + c.passages.length).toBeGreaterThan(0);
  });
});

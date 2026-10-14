import { describe, expect, it } from "vitest";
import { outputIssues } from "../../../agents/specialists/runner.ts";
import {
  STRATEGY_TEXT_LIMITS,
  strategyOutput,
  strategySpecialist,
} from "./strategy.ts";

const brief = (overrides: Record<string, unknown> = {}) => ({
  channel: "x",
  slotAt: "2026-10-13T08:00:00.000Z",
  topic: "Beta access",
  angle: "Lead with what traders can do on day one.",
  factKeys: ["url.beta_registration"],
  cta: "Create your beta account",
  imageIdea: null,
  notARepeatBecause: "No recent post covered the first day.",
  ...overrides,
});

describe("strategy output", () => {
  it("accepts an angle that plans a 600–900 character post", () => {
    // Production uLiquid, 2026-10-13: with the post format in the
    // assignment, the strategy answer failed its schema (AGENT_OUTPUT_INVALID).
    const angle = "a".repeat(1000);
    expect(
      strategyOutput.safeParse({ briefs: [brief({ angle })] }).success,
    ).toBe(true);
  });

  it("tells the model every text limit it is checked against", () => {
    for (const [field, max] of Object.entries(STRATEGY_TEXT_LIMITS))
      expect(strategySpecialist.instructions).toContain(
        `${field} at most ${max}`,
      );
  });

  it("refuses an empty or over-long text", () => {
    expect(
      strategyOutput.safeParse({
        briefs: [brief({ angle: "a".repeat(STRATEGY_TEXT_LIMITS.angle + 1) })],
      }).success,
    ).toBe(false);
    expect(
      strategyOutput.safeParse({ briefs: [brief({ topic: "" })] }).success,
    ).toBe(false);
  });
});

describe("output issues", () => {
  it("names the failing field and its length, never its text", () => {
    const answer = JSON.stringify({
      briefs: [brief({ angle: "secret plan ".repeat(200) })],
    });
    const issues = outputIssues(answer, strategyOutput);
    expect(issues).toBe("briefs.0.angle:custom(2400)");
    expect(issues).not.toContain("secret");
  });

  it("tells an empty or non-JSON answer apart", () => {
    expect(outputIssues("", strategyOutput)).toBe("empty");
    expect(outputIssues("Here is the plan", strategyOutput)).toBe("not_json");
    // Production uLiquid, 2026-10-14: the research answer failed as not JSON.
    expect(outputIssues('{"findings":[{"lead":"cut', strategyOutput)).toBe(
      "truncated_json",
    );
  });
});

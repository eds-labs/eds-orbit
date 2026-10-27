import { describe, expect, it } from "vitest";
import { visionAnswer, visionVerdict } from "./vision-review.ts";

const scores = (values: number[]) => {
  const [
    subject,
    balance,
    legibility,
    brandFit,
    messageFit,
    channelFit,
    value,
  ] = values as [number, number, number, number, number, number, number];
  return {
    subject,
    balance,
    legibility,
    brandFit,
    messageFit,
    channelFit,
    value,
  };
};

describe("vision verdict", () => {
  it("passes when every score is at least 3 and the mean at least 3.5", () => {
    // Mean 3.57 with no score below 3.
    expect(
      visionVerdict({ scores: scores([4, 4, 4, 3, 3, 3, 4]), issues: [] })
        .verdict,
    ).toBe("pass");
    // Mean exactly 3.5 is not reachable with seven integers; 3.43 fails.
    expect(
      visionVerdict({ scores: scores([4, 4, 3, 3, 3, 3, 4]), issues: [] })
        .verdict,
    ).toBe("needs_correction");
    // One score below 3 fails whatever the mean.
    expect(
      visionVerdict({ scores: scores([5, 5, 5, 5, 5, 5, 2]), issues: [] })
        .verdict,
    ).toBe("needs_correction");
  });

  it("keeps at most ten issues with notes of at most 200 characters on one line", () => {
    const long = `${"Busy texture behind the subline ".repeat(10)}\nsecond line`;
    const verdict = visionVerdict({
      scores: scores([4, 4, 4, 4, 4, 4, 4]),
      issues: Array.from({ length: 12 }, () => ({
        kind: "layout" as const,
        note: long,
      })),
    });
    expect(verdict.issues).toHaveLength(10);
    for (const issue of verdict.issues) {
      expect(Array.from(issue.note).length).toBeLessThanOrEqual(200);
      expect(issue.note).not.toContain("\n");
    }
  });

  it("accepts only integer scores from 1 to 5 and known issue kinds", () => {
    const ok = { scores: scores([3, 3, 3, 3, 3, 3, 3]), issues: [] };
    expect(visionAnswer.safeParse(ok).success).toBe(true);
    for (const bad of [0, 6, 3.5])
      expect(
        visionAnswer.safeParse({ ...ok, scores: { ...ok.scores, value: bad } })
          .success,
      ).toBe(false);
    expect(
      visionAnswer.safeParse({
        ...ok,
        issues: [{ kind: "font", note: "Too small" }],
      }).success,
    ).toBe(false);
    expect(
      visionAnswer.safeParse({ ...ok, verdict: "pass", extra: true }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { CreativeRecord } from "./store.ts";
import {
  VISION_INSTRUCTIONS,
  visionAnswer,
  visionVerdict,
  withVision,
} from "./vision-review.ts";

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

describe("a vision verdict on a creative (R49, R5a)", () => {
  const judged = (
    status: CreativeRecord["status"],
    verdict: CreativeRecord["qa"]["verdict"] = "pass",
  ): Pick<CreativeRecord, "qa" | "status"> => ({
    qa: { checks: [], verdict },
    status,
  });
  const failing = { verdict: "needs_correction", renditionSha256: "a" };

  it("leaves a failing verdict to the owner and keeps the composition's own", () => {
    expect(withVision(judged("composed", "corrected"), failing)).toEqual({
      qa: {
        checks: [],
        verdict: "needs_owner",
        vision: { ...failing, compositionVerdict: "corrected" },
      },
      status: "needs_owner",
    });
    // Status is the lifecycle: attached stays attached, rights come first.
    for (const status of ["attached", "needs_rights", "needs_owner"] as const)
      expect(withVision(judged(status), failing)).toMatchObject({
        status,
        qa: { verdict: "needs_owner" },
      });
  });

  it("changes nothing for a passing verdict or none", () => {
    const fields = judged("composed", "corrected");
    expect(withVision(fields, undefined)).toBe(fields);
    expect(withVision(fields, { verdict: "pass" })).toEqual({
      qa: {
        checks: [],
        verdict: "corrected",
        vision: { verdict: "pass", compositionVerdict: "corrected" },
      },
      status: "composed",
    });
  });
});

describe("vision instructions", () => {
  it("say that the art never carries text, logos or screens, so no issue asks for them", () => {
    expect(VISION_INSTRUCTIONS).toContain(
      "Orbit's artwork never contains text, numbers, logos, user interfaces or screens with content",
    );
    expect(VISION_INSTRUCTIONS).toMatch(
      /never suggest adding (?:any of )?them to the art/u,
    );
  });
});

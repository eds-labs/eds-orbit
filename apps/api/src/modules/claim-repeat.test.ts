import { describe, expect, it } from "vitest";
import { postTime, withinClaimRepeatWindow } from "./policy.ts";

const day = 86_400_000;

describe("claim repeat window", () => {
  it("blocks repeating the same facts within seven days only", () => {
    const at = Date.parse("2026-10-05T08:00:00Z");
    expect(withinClaimRepeatWindow(at, at - 6 * day)).toBe(true);
    expect(withinClaimRepeatWindow(at, at + 6.9 * day)).toBe(true);
    expect(withinClaimRepeatWindow(at, at - 7 * day)).toBe(false);
    expect(withinClaimRepeatWindow(at, at - 30 * day)).toBe(false);
  });

  it("uses the planned slot before the creation time", () => {
    const created = new Date("2026-09-30T10:00:00Z");
    expect(postTime({ scheduledAt: "2026-10-04T15:00:00Z" }, created)).toBe(
      Date.parse("2026-10-04T15:00:00Z"),
    );
    expect(postTime({}, created)).toBe(created.valueOf());
  });
});

import { describe, expect, it } from "vitest";
import { textHint } from "./limits";
import { scheduleErrorView } from "./schedule-field";

describe("textHint", () => {
  it("knows each platform's limit", () => {
    expect(textHint("x", "a".repeat(281), { hasMedia: false })).toEqual({ used: 281, limit: 280, over: true });
    expect(textHint("x", "a".repeat(281), { xLongPosts: true, hasMedia: false })).toEqual({ used: 281, limit: 25_000, over: false });
    expect(textHint("telegram", "a".repeat(1_025), { hasMedia: true })).toEqual({ used: 1_025, limit: 1_024, over: true });
    expect(textHint("telegram", "a".repeat(1_025), { hasMedia: false }).over).toBe(false);
    expect(textHint("instagram", "a".repeat(2_200), { hasMedia: true }).over).toBe(false);
    expect(textHint("facebook", "a", { hasMedia: false }).limit).toBe(63_206);
  });

  it("counts a link on X as 23 characters, like X", () => {
    expect(textHint("x", `Read https://example.com/${"x".repeat(300)}`, { hasMedia: false }).used).toBe(5 + 23);
  });
});

describe("scheduleErrorView", () => {
  it("offers both sides of an hour that exists twice", () => {
    const view = scheduleErrorView(
      "SOCIAL_SCHEDULE_TIME_AMBIGUOUS",
      { earlier: "2027-10-31T00:30:00.000Z", later: "2027-10-31T01:30:00.000Z" },
      "2027-10-31T02:30",
      "en",
    );
    expect(view.choices).toEqual([
      { label: "Earlier (UTC+02:00)", fold: "earlier" },
      { label: "Later (UTC+01:00)", fold: "later" },
    ]);
  });

  it("offers the first valid time after a gap", () => {
    const view = scheduleErrorView("SOCIAL_SCHEDULE_TIME_GAP", { suggestedLocal: "2027-03-28T03:00" }, "2027-03-28T02:30", "de");
    expect(view.choices).toEqual([{ label: "28.03.2027, 03:00 verwenden", local: "2027-03-28T03:00" }]);
    expect(view.message).toMatch(/Zeitumstellung nicht/);
  });

  it("explains other codes without choices", () => {
    expect(scheduleErrorView("SOCIAL_SCHEDULE_TOO_SOON", null, "2026-01-01T10:00", "en")).toEqual({
      message: "Choose a time at least two minutes from now.",
    });
  });
});

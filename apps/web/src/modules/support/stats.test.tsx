import { describe, expect, it } from "vitest";
import { durationLabel, percent, statsQuery } from "./stats";

describe("support statistics view (WP5.7)", () => {
  it("builds the range of the last days and the optional inbox", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(statsQuery(30, null, now)).toBe(
      "from=2026-09-18T12%3A00%3A00.000Z&to=2026-10-18T12%3A00%3A00.000Z",
    );
    expect(statsQuery(7, "i1", now)).toContain("&inboxId=i1");
  });
  it("formats durations and rates, with a dash for no data", () => {
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(45)).toBe("45 min");
    expect(durationLabel(150)).toBe("2.5 h");
    expect(durationLabel(3 * 24 * 60)).toBe("3 d");
    expect(percent(null)).toBe("—");
    expect(percent(0.667)).toBe("67 %");
  });
});

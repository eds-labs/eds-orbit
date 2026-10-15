import { describe, expect, it } from "vitest";
import { postingSlot, zonedTime } from "./posting-slots.ts";

describe("posting slots", () => {
  it("converts Berlin wall-clock time across the DST change", () => {
    expect(zonedTime(2026, 9, 30, 10, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-09-30T08:00:00.000Z",
    );
    expect(zonedTime(2026, 10, 26, 10, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("gives each run its own day at the channel time", () => {
    const start = "2026-09-30T11:00:00Z"; // 13:00 Berlin
    // 17:00 is still ahead on the start day.
    expect(postingSlot(start, "17:00", "Europe/Berlin", 0)?.toISOString()).toBe(
      "2026-09-30T15:00:00.000Z",
    );
    expect(postingSlot(start, "17:00", "Europe/Berlin", 4)?.toISOString()).toBe(
      "2026-10-04T15:00:00.000Z",
    );
    // 10:00 has passed on the start day, so the series begins the next day.
    expect(postingSlot(start, "10:00", "Europe/Berlin", 0)?.toISOString()).toBe(
      "2026-10-01T08:00:00.000Z",
    );
  });

  it("rejects invalid times and run numbers", () => {
    expect(
      postingSlot("2026-09-30T11:00:00Z", "25:00", "Europe/Berlin", 0),
    ).toBe(null);
    expect(
      postingSlot("2026-09-30T11:00:00Z", "10:00", "Europe/Berlin", -1),
    ).toBe(null);
  });
});

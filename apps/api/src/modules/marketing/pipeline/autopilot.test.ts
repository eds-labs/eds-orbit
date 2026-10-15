import { describe, expect, it } from "vitest";
import { planningDays } from "./autopilot.ts";

const iso = (days: { y: number; m: number; d: number }[]) =>
  days.map(
    ({ y, m, d }) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );

describe("autopilot planning days", () => {
  it("plans the rest of the current week before the weekly plan moment", () => {
    // Wednesday 30 Sep 2026, 14:00 Berlin; plan moment Sunday 12:00.
    const days = planningDays(
      new Date("2026-09-30T12:00:00Z"),
      "Europe/Berlin",
      0,
      "12:00",
    );
    expect(iso(days)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
  });

  it("adds the whole next week once the plan moment has passed", () => {
    // Sunday 4 Oct 2026, 13:00 Berlin.
    const days = planningDays(
      new Date("2026-10-04T11:00:00Z"),
      "Europe/Berlin",
      0,
      "12:00",
    );
    expect(iso(days)[0]).toBe("2026-10-04");
    expect(iso(days).at(-1)).toBe("2026-10-11");
    expect(days).toHaveLength(8);
  });
});

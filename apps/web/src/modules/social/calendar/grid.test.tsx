import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../api";
import { daySlots, monthCells, placeByDay, placeBySlot, rangeOf, weekDays } from "./grid";

// Calendar arithmetic (S6) in the project's time zone, across the days the
// clocks change.

const item = (id: string, at: string): CalendarItem =>
  ({
    id,
    projectId: "p1",
    title: id,
    excerpt: "",
    status: "scheduled",
    origin: "manual",
    readOnly: false,
    schedule: { mode: "at", at, local: null, timeZone: "Europe/Berlin", fold: null },
    approvalState: "approved",
    version: 1,
    accounts: [],
    publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
  }) as CalendarItem;

describe("monthCells", () => {
  it("fills whole weeks from Monday and marks today", () => {
    const cells = monthCells("2026-11", "Europe/Berlin", new Date("2026-11-03T10:00:00Z"));
    expect(cells).toHaveLength(42);
    expect([cells[0]!.date, cells[41]!.date]).toEqual(["2026-10-26", "2026-12-06"]);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
    expect(cells.filter((c) => c.isToday).map((c) => c.date)).toEqual(["2026-11-03"]);
    const feb = monthCells("2027-02", "Europe/Berlin", new Date("2026-11-03T10:00:00Z"));
    expect([feb.length, feb[0]!.date, feb[27]!.date]).toEqual([28, "2027-02-01", "2027-02-28"]);
  });

  it("knows today in the project's zone, not UTC", () => {
    // 23:30 UTC on 2 November is already 3 November in Berlin.
    const cells = monthCells("2026-11", "Europe/Berlin", new Date("2026-11-02T23:30:00Z"));
    expect(cells.find((c) => c.isToday)?.date).toBe("2026-11-03");
  });
});

describe("daySlots", () => {
  it("has 48 half hours on an ordinary day", () => {
    const slots = daySlots("2026-11-04", "Europe/Berlin");
    expect(slots).toHaveLength(48);
    expect(slots[0]).toMatchObject({ local: "2026-11-04T00:00", at: "2026-11-03T23:00:00.000Z", label: "00:00", repeated: false });
    expect(slots[47]!.label).toBe("23:30");
  });

  it("skips the hour that does not exist and repeats the one that exists twice", () => {
    const spring = daySlots("2027-03-28", "Europe/Berlin");
    expect(spring).toHaveLength(46);
    const springLabels = spring.map((s) => s.label);
    expect(springLabels.slice(3, 5)).toEqual(["01:30", "03:00"]);
    const autumn = daySlots("2026-10-25", "Europe/Berlin");
    expect(autumn).toHaveLength(50);
    const twice = autumn.filter((s) => s.label === "02:30");
    expect(twice.map((s) => [s.at, s.repeated])).toEqual([
      ["2026-10-25T00:30:00.000Z", false],
      ["2026-10-25T01:30:00.000Z", true],
    ]);
    expect(daySlots("2027-03-14", "America/New_York")).toHaveLength(46);
  });
});

describe("placement and ranges", () => {
  it("puts posts on their local day and into their half-hour slot", () => {
    // 23:30 UTC on 4 November is already 00:30 on 5 November in Berlin.
    const items = [item("next", "2026-11-04T23:30:00Z"), item("late", "2026-11-04T22:30:00Z"), item("early", "2026-11-04T08:10:00Z")];
    const byDay = placeByDay(items, "Europe/Berlin");
    expect(byDay.get("2026-11-04")?.map((i) => i.id)).toEqual(["early", "late"]);
    expect(byDay.get("2026-11-05")?.map((i) => i.id)).toEqual(["next"]);
    const twice = placeBySlot([item("a", "2026-10-25T00:30:00Z"), item("b", "2026-10-25T01:40:00Z")], "Europe/Berlin");
    expect(twice.get("2026-10-25T00:30:00.000Z")?.map((i) => i.id)).toEqual(["a"]);
    expect(twice.get("2026-10-25T01:30:00.000Z")?.map((i) => i.id)).toEqual(["b"]);
  });

  it("covers the visible week or month grid", () => {
    expect(weekDays("2026-11-04")).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(rangeOf("week", "2026-11-04", "Europe/Berlin")).toEqual({ from: "2026-11-01T23:00:00.000Z", to: "2026-11-08T23:00:00.000Z" });
    expect(rangeOf("month", "2026-11-17", "Europe/Berlin")).toEqual({ from: "2026-10-25T23:00:00.000Z", to: "2026-12-06T23:00:00.000Z" });
  });
});

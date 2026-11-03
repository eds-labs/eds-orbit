import { describe, expect, it } from "vitest";
import { isTimeZone, localOf, resolveLocalTime } from "../src/platform/time/zoned-time.ts";
import { resolveSchedule } from "../src/modules/social/posts/schedule-time.ts";

// Local schedule times across daylight-saving changes (ADR 0020, plan §7
// "Time"): a time that does not exist is refused with the next valid one, a
// time that exists twice needs a choice.

const iso = (value: string) => new Date(value);

describe("resolveLocalTime", () => {
  it("finds the gap of the spring change and suggests its end", () => {
    expect(resolveLocalTime("2027-03-28T02:30", "Europe/Berlin")).toEqual({
      kind: "gap",
      suggestedLocal: "2027-03-28T03:00",
      suggestedAt: iso("2027-03-28T01:00:00.000Z"),
    });
    expect(resolveLocalTime("2027-03-14T02:30", "America/New_York")).toMatchObject({
      kind: "gap",
      suggestedLocal: "2027-03-14T03:00",
      suggestedAt: iso("2027-03-14T07:00:00.000Z"),
    });
  });

  it("returns both instants of an hour that exists twice", () => {
    expect(resolveLocalTime("2026-10-25T02:30", "Europe/Berlin")).toEqual({
      kind: "ambiguous",
      earlier: iso("2026-10-25T00:30:00.000Z"),
      later: iso("2026-10-25T01:30:00.000Z"),
    });
    expect(resolveLocalTime("2026-11-01T01:30", "America/New_York")).toEqual({
      kind: "ambiguous",
      earlier: iso("2026-11-01T05:30:00.000Z"),
      later: iso("2026-11-01T06:30:00.000Z"),
    });
  });

  it("converts ordinary times exactly", () => {
    expect(resolveLocalTime("2026-12-01T10:00", "UTC")).toEqual({ kind: "exact", at: iso("2026-12-01T10:00:00.000Z") });
    expect(resolveLocalTime("2026-12-01T10:00", "Europe/Berlin")).toEqual({ kind: "exact", at: iso("2026-12-01T09:00:00.000Z") });
    expect(resolveLocalTime("2026-07-01T10:00", "Europe/Berlin")).toEqual({ kind: "exact", at: iso("2026-07-01T08:00:00.000Z") });
  });

  it("formats an instant as local time and knows real zones", () => {
    expect(localOf(iso("2026-12-01T09:00:00Z"), "Europe/Berlin")).toBe("2026-12-01T10:00");
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
  });
});

describe("resolveSchedule", () => {
  const now = iso("2026-10-01T00:00:00Z");

  it("takes the chosen side of an hour that exists twice, and asks otherwise", () => {
    expect(resolveSchedule({ local: "2026-10-25T02:30", timeZone: "Europe/Berlin", fold: "later" }, "UTC", now)).toEqual({
      at: iso("2026-10-25T01:30:00.000Z"),
      local: "2026-10-25T02:30",
      timeZone: "Europe/Berlin",
      fold: "later",
    });
    expect(() => resolveSchedule({ local: "2026-10-25T02:30", timeZone: "Europe/Berlin" }, "UTC", now)).toThrow(
      expect.objectContaining({
        code: "SOCIAL_SCHEDULE_TIME_AMBIGUOUS",
        status: 422,
        detail: { earlier: "2026-10-25T00:30:00.000Z", later: "2026-10-25T01:30:00.000Z" },
      }),
    );
  });

  it("refuses a time in the gap with the suggested time", () => {
    expect(() =>
      resolveSchedule({ local: "2027-03-28T02:30", timeZone: "Europe/Berlin" }, "UTC", now),
    ).toThrow(
      expect.objectContaining({
        code: "SOCIAL_SCHEDULE_TIME_GAP",
        detail: { suggestedLocal: "2027-03-28T03:00", suggestedAt: "2027-03-28T01:00:00.000Z" },
      }),
    );
  });

  it("uses the project's zone when none is given", () => {
    expect(resolveSchedule({ local: "2026-12-01T10:00" }, "Europe/Berlin", now)).toMatchObject({
      at: iso("2026-12-01T09:00:00.000Z"),
      timeZone: "Europe/Berlin",
      fold: null,
    });
  });

  it("keeps the local time of an instant in the project's zone", () => {
    expect(resolveSchedule({ at: "2026-12-01T09:00:00Z" }, "Europe/Berlin", now)).toEqual({
      at: iso("2026-12-01T09:00:00.000Z"),
      local: "2026-12-01T10:00",
      timeZone: "Europe/Berlin",
      fold: null,
    });
  });

  it("refuses times too soon, too far or not valid", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "none";
    };
    expect(code(() => resolveSchedule({ at: new Date(now.getTime() + 60_000).toISOString() }, "UTC", now))).toBe("SOCIAL_SCHEDULE_TOO_SOON");
    expect(code(() => resolveSchedule({ at: new Date(now.getTime() + 366 * 86_400_000).toISOString() }, "UTC", now))).toBe("SOCIAL_SCHEDULE_TOO_FAR");
    expect(code(() => resolveSchedule({ local: "2026-13-01T10:00" }, "UTC", now))).toBe("SOCIAL_SCHEDULE_INVALID");
    expect(code(() => resolveSchedule({ local: "2026-12-01T10:00", timeZone: "Mars/Base" }, "UTC", now))).toBe("SOCIAL_SCHEDULE_INVALID");
    expect(code(() => resolveSchedule({ at: "tomorrow" }, "UTC", now))).toBe("SOCIAL_SCHEDULE_INVALID");
    // Exactly the lead time is enough.
    expect(code(() => resolveSchedule({ at: new Date(now.getTime() + 120_000).toISOString() }, "UTC", now))).toBe("none");
  });
});

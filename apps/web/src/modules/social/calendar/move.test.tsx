import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../api";
import { dropLocal, moveCheck, rescheduleBody } from "./move";

// Who may move which post where (S6, S-D6): a draft moves freely; an
// approved or waiting post needs a new approval; some posts never move.

const item = (over: Partial<CalendarItem> = {}): CalendarItem =>
  ({
    id: "p1",
    projectId: "proj",
    title: null,
    excerpt: "",
    status: "draft",
    origin: "manual",
    readOnly: false,
    schedule: { mode: "at", at: "2026-11-10T09:15:00.000Z", local: "2026-11-10T10:15", timeZone: "Europe/Berlin", fold: null },
    approvalState: "none",
    version: 4,
    accounts: [],
    publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
    ...over,
  }) as CalendarItem;

describe("moveCheck", () => {
  it("lets drafts move freely and asks for a new approval otherwise", () => {
    expect(moveCheck(item(), "editor", "project")).toEqual({ kind: "free" });
    for (const status of ["needs_approval", "scheduled", "approved"] as const) {
      expect(moveCheck(item({ status }), "owner", "project")).toEqual({ kind: "reapprove" });
      expect(moveCheck(item({ status }), "editor", "project")).toEqual({ kind: "request" });
    }
  });

  it("never moves what is being sent, finished, read-only, another project's or a viewer's", () => {
    for (const status of ["publishing", "published", "partially_published", "failed", "canceled", "archived"] as const)
      expect(moveCheck(item({ status }), "owner", "project").kind).toBe("forbidden");
    expect(moveCheck(item({ readOnly: true, origin: "legacy_postiz" }), "owner", "project").kind).toBe("forbidden");
    expect(moveCheck(item(), "owner", "organization").kind).toBe("forbidden");
    expect(moveCheck(item(), "viewer", "project").kind).toBe("forbidden");
  });
});

describe("drop targets", () => {
  it("keeps the time of day when a post is dropped on another day", () => {
    expect(dropLocal(item(), { date: "2026-11-20" }, "Europe/Berlin")).toBe("2026-11-20T10:15");
    expect(dropLocal(item(), { date: "2026-11-20", time: "18:30" }, "Europe/Berlin")).toBe("2026-11-20T18:30");
  });

  it("sends the version, the local time and the zone, and re-approval only when asked", () => {
    expect(rescheduleBody(item(), "2026-11-20T10:15", "Europe/Berlin", {})).toEqual({ version: 4, local: "2026-11-20T10:15", timeZone: "Europe/Berlin" });
    expect(rescheduleBody(item(), "2026-10-25T02:30", "Europe/Berlin", { reapprove: true, fold: "later" })).toEqual({
      version: 4,
      local: "2026-10-25T02:30",
      timeZone: "Europe/Berlin",
      reapprove: true,
      fold: "later",
    });
  });
});

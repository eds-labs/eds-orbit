import { describe, expect, it } from "vitest";
import {
  approveEach,
  autopilotApprovals,
  openExceptions,
  pausedPosts,
} from "./autopilot-approvals";

const now = Date.parse("2026-10-06T10:40:00Z");
const item = (id: string, data: Record<string, unknown>) =>
  ({ id, version: 1, data }) as never;
const missions = [
  item("autopilot", { autopilot: true }),
  item("chat", { chatProposalId: "proposal" }),
];
const draft = (id: string, scheduledAt: string, missionId = "autopilot") =>
  item(id, { status: "needs_review", missionId, scheduledAt });

describe("autopilot approvals", () => {
  it("separates drafts whose slot has passed from those that can still be scheduled", () => {
    const { due, missed } = autopilotApprovals(
      [
        draft("tomorrow", "2026-10-07T15:00:00Z"),
        draft("yesterday", "2026-10-05T15:00:00Z"),
        draft("this-morning", "2026-10-06T08:00:00Z"),
        draft("today", "2026-10-06T15:00:00Z"),
        draft("chat", "2026-10-07T15:00:00Z", "chat"),
      ],
      missions,
      now,
    );
    expect(due.map((c) => c.id)).toEqual(["today", "tomorrow"]);
    expect(missed.map((c) => c.id)).toEqual(["yesterday", "this-morning"]);
  });

  it("approves every draft and reports the ones that failed instead of stopping at the first", async () => {
    // Production 2026-10-06: "Alle freigeben" stopped at the first draft with
    // INVALID_SCHEDULE and approved nothing.
    const approved: string[] = [];
    const failures = await approveEach(
      [draft("a", "x"), draft("b", "x"), draft("c", "x")],
      async (c) => {
        if (c.id === "b") throw new Error("CHANNEL_SPACING");
        approved.push(c.id);
      },
    );
    expect(approved).toEqual(["a", "c"]);
    expect(failures).toEqual([{ id: "b", error: "CHANNEL_SPACING" }]);
  });
});

describe("posts stopped by a pause", () => {
  it("lists only stopped posts whose slot is still ahead, earliest first", () => {
    const pub = (
      id: string,
      status: string,
      reason: string,
      scheduledAt: string,
    ) => item(id, { status, reason, scheduledAt });
    expect(
      pausedPosts(
        [
          pub(
            "later",
            "blocked_dependency",
            "PROJECT_PAUSED",
            "2026-10-09T15:00:00Z",
          ),
          pub(
            "passed",
            "blocked_dependency",
            "PROJECT_PAUSED",
            "2026-10-06T08:00:00Z",
          ),
          pub(
            "other",
            "blocked_dependency",
            "PACKAGE_CHANGED",
            "2026-10-08T15:00:00Z",
          ),
          pub("live", "intent_created", "", "2026-10-08T15:00:00Z"),
          pub(
            "next",
            "blocked_dependency",
            "PROJECT_PAUSED",
            "2026-10-07T15:00:00Z",
          ),
        ],
        now,
      ).map((p) => p.id),
    ).toEqual(["next", "later"]);
  });
});

describe("open exceptions", () => {
  it("lists only open exceptions, most recently seen first", () => {
    expect(
      openExceptions([
        item("old", {
          code: "LINK_NOT_ALLOWED",
          status: "open",
          lastSeenAt: "2026-10-05T10:00:00Z",
        }),
        item("done", {
          code: "FACT_CONFLICT",
          status: "resolved",
          lastSeenAt: "2026-10-06T10:00:00Z",
        }),
        item("new", {
          code: "PUBLISH_PREFLIGHT_BLOCKED",
          status: "open",
          lastSeenAt: "2026-10-07T10:00:00Z",
        }),
      ]).map((e) => e.id),
    ).toEqual(["new", "old"]);
  });
});

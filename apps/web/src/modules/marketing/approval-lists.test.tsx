import { describe, expect, it } from "vitest";
import { openExceptions, pausedPosts } from "./approval-lists";

const now = Date.parse("2026-10-06T10:40:00Z");
const item = (id: string, data: Record<string, unknown>) =>
  ({ id, version: 1, data }) as never;

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

import { describe, expect, it } from "vitest";
import {
  approvalLanes,
  approvalSlots,
  groupByBase,
  openExceptions,
  pausedPosts,
} from "./approval-lists";

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

describe("approval lanes of the page", () => {
  const row = (
    id: string,
    data: Record<string, unknown>,
    createdAt = "2026-10-06T08:00:00Z",
  ) => ({ id, version: 1, kind: "content", createdAt, data }) as never;
  const lanes = (
    content: unknown[],
    publications: unknown[] = [],
    postiz: unknown[] = [],
  ) =>
    Object.fromEntries(
      approvalLanes(content as never, publications as never, postiz as never, {
        now,
      }).map((i) => [i.content.id, i.lane]),
    );

  it("sorts released, reviewed, open, expired and replaced rows apart", () => {
    expect(
      lanes(
        [
          row("released", { status: "reviewed" }),
          row("reviewed", { status: "reviewed" }),
          row("open", { status: "needs_review" }),
          row("expired", {
            status: "needs_review",
            assignmentRunId: "r1",
            scheduledAt: "2026-10-06T09:00:00Z",
          }),
          row("ahead", {
            status: "needs_review",
            assignmentRunId: "r1",
            scheduledAt: "2026-10-07T09:00:00Z",
          }),
          row("replaced", { status: "needs_review", supersededBy: "x" }),
          row("rejected", { status: "rejected" }),
          row("published", { status: "reviewed" }),
          row("inPostiz", { status: "reviewed" }),
          row("approved", { status: "approved" }),
        ],
        [
          row("p1", { contentId: "released", status: "intent_created" }),
          row("p2", { contentId: "published", status: "published" }),
          row("p3", { contentId: "reviewed", status: "canceled" }),
        ],
        [row("h1", { contentId: "inPostiz", status: "accepted" })],
      ),
    ).toEqual({
      released: "released",
      reviewed: "reviewed",
      open: "open",
      expired: "cleanup",
      ahead: "open",
      replaced: "history",
      rejected: "history",
      published: "history",
      inPostiz: "released",
    });
  });

  it("reads an assignment draft's slot from the drafts list first", () => {
    const draft = row("d", {
      status: "needs_review",
      assignmentRunId: "r1",
      scheduledAt: "2026-10-07T09:00:00Z",
    });
    const slots = new Map([["d", "2026-10-06T09:00:00Z"]]);
    expect(
      approvalLanes([draft], [], [], { now, slots }).map((i) => i.lane),
    ).toEqual(["cleanup"]);
  });

  it("reads a draft's slot from its mission like the server, the drafts list first", () => {
    // No scheduledAt and not in the drafts list: only the mission knows the slot.
    const fromMission = row("m", {
      status: "needs_review",
      assignmentRunId: "r1",
      missionId: "mission-1",
    });
    const listed = row("l", {
      status: "needs_review",
      assignmentRunId: "r1",
      missionId: "mission-1",
    });
    const ordinary = row("o", {
      status: "needs_review",
      missionId: "mission-1",
    });
    const missions = [
      row("mission-1", { plannedSlotAt: "2026-10-06T09:00:00Z" }),
    ];
    const slots = approvalSlots([fromMission, listed, ordinary], missions, [
      { id: "l", slotAt: "2026-10-07T09:00:00Z" },
    ]);
    expect([...slots.entries()]).toEqual([
      ["m", "2026-10-06T09:00:00Z"],
      ["l", "2026-10-07T09:00:00Z"],
    ]);
    expect(
      Object.fromEntries(
        approvalLanes([fromMission, listed, ordinary], [], [], {
          now,
          slots,
        }).map((i) => [i.content.id, i.lane]),
      ),
    ).toEqual({ m: "cleanup", l: "open", o: "open" });
    // Without the mission the draft would have stayed an open action.
    expect(
      approvalLanes([fromMission], [], [], { now }).map((i) => i.lane),
    ).toEqual(["open"]);
  });

  it("groups channel copies with their original, the original first", () => {
    const items = [
      row("ig", { status: "needs_review", sharedFrom: { contentId: "fb" } }),
      row("solo", { status: "needs_review" }),
      row("fb", { status: "needs_review" }),
    ].map((content) => ({ content }));
    expect(
      groupByBase(items).map((g) => ({
        baseId: g.baseId,
        ids: g.items.map((i) => (i.content as { id: string }).id),
      })),
    ).toEqual([
      { baseId: "fb", ids: ["fb", "ig"] },
      { baseId: "solo", ids: ["solo"] },
    ]);
  });
});

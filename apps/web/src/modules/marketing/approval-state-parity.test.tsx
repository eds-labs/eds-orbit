import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATUSES as WEB_APPROVAL_STATUSES,
  approvalItems,
} from "./draft-cleanup";
import {
  OPEN_REVIEW_STATUSES as WEB_OPEN_REVIEW_STATUSES,
  approvalLane as webApprovalLane,
  baseContentId as webBaseContentId,
  pausedPosts,
  type LaneHandoff,
} from "./approval-lists";
import { DRAFT_STATUSES } from "../../../../api/src/modules/marketing/pipeline/draft-statuses";
import {
  APPROVAL_STATUSES,
  OPEN_REVIEW_STATUSES,
  approvalLane,
  baseContentId,
  isPausedPost,
} from "../../../../api/src/modules/marketing/approval-state";

// The server counts what the web lists on the approvals page (attention
// items and the page must agree). The web keeps its own copies, so this test
// is what stops them drifting apart. It lives here, not under apps/api, because
// the root typecheck cannot resolve the web's "@/" alias.

const NOW = new Date("2026-10-18T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) =>
  new Date(NOW.getTime() + hours * HOUR).toISOString();

describe("approval state parity (server and web)", () => {
  it("lists the same content statuses", () => {
    expect([...APPROVAL_STATUSES]).toEqual(WEB_APPROVAL_STATUSES);
    expect([...APPROVAL_STATUSES]).toEqual([...DRAFT_STATUSES]);
  });

  it("selects the same content rows", () => {
    const rows = [
      ...APPROVAL_STATUSES,
      "approved",
      "archived",
      "published",
      "",
    ].map((status) => ({ data: { status } }));
    const web = approvalItems(rows as never);
    const server = rows.filter((row) =>
      (APPROVAL_STATUSES as readonly string[]).includes(row.data.status),
    );
    expect(server).toEqual(web);
  });

  it("treats the same publications as paused", () => {
    const base = {
      status: "blocked_dependency",
      reason: "PROJECT_PAUSED",
      scheduledAt: at(2),
    };
    const cases: Record<string, unknown>[] = [
      base,
      { ...base, scheduledAt: at(-2) },
      { ...base, scheduledAt: NOW.toISOString() },
      { ...base, scheduledAt: "not a date" },
      { ...base, scheduledAt: undefined },
      { ...base, reason: "OTHER" },
      { ...base, reason: undefined },
      { ...base, status: "intent_created" },
      { ...base, status: "scheduled" },
    ];
    for (const data of cases) {
      const web = pausedPosts([{ data }] as never, NOW.getTime()).length === 1;
      expect(isPausedPost(data, NOW), JSON.stringify(data)).toBe(web);
    }
  });

  it("leaves only `reviewed` out of the open review statuses", () => {
    expect([...OPEN_REVIEW_STATUSES]).toEqual(WEB_OPEN_REVIEW_STATUSES);
    expect([...OPEN_REVIEW_STATUSES]).toEqual(
      APPROVAL_STATUSES.filter((s) => s !== "reviewed"),
    );
  });

  it("puts every row in the same lane", () => {
    const contents: Record<string, unknown>[] = [
      ...APPROVAL_STATUSES,
      "rejected",
      "archived",
    ].flatMap((status) => [
      { status },
      { status, supersededBy: "c2" },
      { status, retiredWithRunId: "r1" },
    ]);
    const handoffSets: LaneHandoff[][] = [
      [],
      [{ kind: "publication", status: "intent_created" }],
      [{ kind: "publication", status: "scheduled_remote" }],
      [{ kind: "publication", status: "blocked_dependency" }],
      [{ kind: "publication", status: "canceled" }],
      [{ kind: "publication", status: "failed" }],
      [{ kind: "publication", status: "published" }],
      [{ kind: "publication", status: "published_test" }],
      [{ kind: "postiz_draft", status: "accepted" }],
      [{ kind: "postiz_draft", status: "sending" }],
      [{ kind: "postiz_draft", status: "failed" }],
      [
        { kind: "publication", status: "canceled" },
        { kind: "publication", status: "intent_created" },
      ],
      [
        { kind: "publication", status: "failed" },
        { kind: "postiz_draft", status: "canceled" },
      ],
    ];
    const seen = new Set<string>();
    for (const content of contents)
      for (const handoffs of handoffSets)
        for (const expired of [false, true]) {
          const server = approvalLane(content, { handoffs, expired });
          const web = webApprovalLane(content, { handoffs, expired });
          expect(web, JSON.stringify({ content, handoffs, expired })).toBe(
            server,
          );
          seen.add(server);
        }
    // The matrix reaches every lane.
    expect([...seen].sort()).toEqual(
      ["cleanup", "history", "open", "released", "reviewed"].sort(),
    );
  });

  it("applies the rules in their order", () => {
    const pending = [
      { kind: "publication" as const, status: "intent_created" },
    ];
    // Replaced wins over a hand-off and over expiry.
    expect(
      approvalLane(
        { status: "reviewed", supersededBy: "c2" },
        { handoffs: pending },
      ),
    ).toBe("history");
    // A held or scheduled post is released, never open, whatever its status.
    expect(approvalLane({ status: "reviewed" }, { handoffs: pending })).toBe(
      "released",
    );
    expect(
      approvalLane({ status: "needs_review" }, { handoffs: pending }),
    ).toBe("released");
    // Published is history; a canceled one leaves the row where it was.
    expect(
      approvalLane(
        { status: "reviewed" },
        { handoffs: [{ kind: "publication", status: "published" }] },
      ),
    ).toBe("history");
    expect(
      approvalLane(
        { status: "reviewed" },
        { handoffs: [{ kind: "publication", status: "canceled" }] },
      ),
    ).toBe("reviewed");
    // Reviewed wins over expiry; an expired open draft is for the cleanup.
    expect(approvalLane({ status: "reviewed" }, { expired: true })).toBe(
      "reviewed",
    );
    expect(approvalLane({ status: "needs_review" }, { expired: true })).toBe(
      "cleanup",
    );
    expect(approvalLane({ status: "needs_review" })).toBe("open");
  });

  it("finds the same original of a channel copy", () => {
    const rows = [
      { id: "a", data: {} },
      { id: "b", data: { sharedFrom: { contentId: "a" } } },
      { id: "c", data: { sharedFrom: { missionId: "m" } } },
      { id: "d", data: { sharedFrom: { contentId: 7 } } },
      { id: "e", data: null },
    ];
    for (const row of rows)
      expect(webBaseContentId(row), row.id).toBe(baseContentId(row));
    expect(rows.map(baseContentId)).toEqual(["a", "a", "c", "d", "e"]);
  });
});

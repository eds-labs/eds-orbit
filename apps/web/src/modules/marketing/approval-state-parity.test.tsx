import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATUSES as WEB_APPROVAL_STATUSES,
  approvalItems,
} from "./draft-cleanup";
import { pausedPosts } from "./approval-lists";
import { DRAFT_STATUSES } from "../../../../api/src/modules/marketing/pipeline/draft-statuses";
import {
  APPROVAL_STATUSES,
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
});

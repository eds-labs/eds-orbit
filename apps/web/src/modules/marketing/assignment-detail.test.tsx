import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssignmentDetailView,
  type AssignmentDetailData,
} from "./assignment-detail";

const detail = (): AssignmentDetailData => ({
  assignment: {
    id: "a1",
    version: 2,
    name: "Daily post",
    status: "active",
    channels: [{ id: "social:1", name: "@uliquid", platform: "x" }],
    schedule: {
      rhythm: "daily",
      times: ["10:00"],
      leadMinutes: 360,
      timezone: "Europe/Berlin",
    },
    delivery: "publish",
    approvalMode: "human_each",
    image: "banner",
    historyDays: 30,
    monthlyBudgetMicros: 20_000_000,
    monthSpentMicros: 1_000_000,
  },
  nextRunAt: "2026-11-08T04:00:00.000Z",
  runs: [
    {
      id: "r1",
      date: "2026-11-07",
      status: "partial",
      createdAt: "2026-11-07T04:00:00.000Z",
      errors: [{ step: "strategy", code: "AGENT_OUTPUT_INVALID" }],
      retryable: true,
      deliverables: [
        {
          contentId: "c1",
          channel: "social:1",
          channelName: "@uliquid",
          slotAt: "2026-11-07T09:00:00.000Z",
          excerpt: "Published text",
          assetId: "asset-1",
          state: "published",
          publication: {
            id: "p1",
            status: "published",
            permalink: "https://x.com/u/status/1",
            socialPostId: "post-123",
            errorCode: null,
          },
        },
        {
          contentId: "c2",
          channel: "social:1",
          channelName: "@uliquid",
          slotAt: "2026-11-07T10:00:00.000Z",
          excerpt: "Passed draft",
          assetId: null,
          state: "expired",
          publication: null,
        },
        {
          contentId: "c3",
          channel: "social:1",
          channelName: "@uliquid",
          slotAt: "2099-11-07T10:00:00.000Z",
          excerpt: "Open draft",
          assetId: null,
          state: "awaiting_release",
          publication: null,
        },
      ],
    },
  ],
});

const render = (isOwner = true) =>
  renderToStaticMarkup(
    <AssignmentDetailView
      detail={detail()}
      projectId="proj"
      de
      isOwner={isOwner}
      onRetry={() => {}}
    />,
  );

describe("AssignmentDetailView", () => {
  it("renders the three sections, the calendar link with the post id and the permalink", () => {
    const html = render();
    for (const heading of ["Einstellungen", "Läufe", "Beiträge"])
      expect(html).toContain(heading);
    expect(html).toContain('href="/social/calendar?post=post-123"');
    expect(html).toContain('href="https://x.com/u/status/1"');
    expect(html).toContain("/api/projects/proj/assets/asset-1/content");
    expect(html).toContain("AGENT_OUTPUT_INVALID");
    expect(html).toContain("Lauf wiederholen");
  });

  it("offers Freigeben only on drafts awaiting release, never on expired ones", () => {
    const html = render();
    expect(html.match(/Freigeben/g)).toHaveLength(1);
    expect(html).toContain("Abgelaufen");
    expect(html).toContain('href="/approvals"');
  });

  it("hides the retry button from non-owners", () => {
    expect(render(false)).not.toContain("Lauf wiederholen");
  });
});

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
    // The posts view opens a post by `?post=`; the calendar ignores it.
    expect(html).toContain('href="/social/posts?post=post-123"');
    expect(html).not.toContain("/social/calendar");
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

  it("labels run status, delivery and approval mode in German, never as raw codes", () => {
    const html = render();
    expect(html).toContain("Teilweise erledigt");
    expect(html).not.toMatch(/>partial</);
    expect(html).toContain("Zum Termin veröffentlichen");
    expect(html).toContain("Owner gibt jeden Beitrag frei");
    expect(html).not.toContain("human_each");
    expect(html).not.toMatch(/>publish</);
  });

  it("shows a done run as a success (run statuses are done, partial, failed, canceled)", () => {
    const data = detail();
    data.runs[0]!.status = "done";
    const html = renderToStaticMarkup(
      <AssignmentDetailView detail={data} projectId="proj" de isOwner />,
    );
    expect(html).toContain('<span class="badge badge-success">Erledigt</span>');
  });

  it("shows error codes with a human message", () => {
    const data = detail();
    data.runs[0]!.errors = [
      { step: "slot:social:1", code: "SLOT_UNAVAILABLE" },
      { step: "strategy", code: "SOMETHING_NEW" },
    ];
    data.runs[0]!.deliverables[0] = {
      ...data.runs[0]!.deliverables[0]!,
      state: "failed",
      publication: {
        ...data.runs[0]!.deliverables[0]!.publication!,
        status: "failed",
        errorCode: "SOCIAL_SLOT_EXPIRED",
      },
    };
    const html = renderToStaticMarkup(
      <AssignmentDetailView detail={data} projectId="proj" de isOwner />,
    );
    expect(html).toContain("kein freier Termin");
    expect(html).toContain("SLOT_UNAVAILABLE");
    expect(html).toContain("mehr als 30 Minuten");
    expect(html).toContain("SOCIAL_SLOT_EXPIRED");
    // An unknown code still shows, with the generic message.
    expect(html).toContain("Fehler");
    expect(html).toContain("SOMETHING_NEW");
    const en = renderToStaticMarkup(
      <AssignmentDetailView detail={data} projectId="proj" de={false} isOwner />,
    );
    expect(en).toContain("more than 30 minutes");
  });

  it("marks a retried run with its new run instead of a plain failure", () => {
    const data = detail();
    data.runs[0] = {
      ...data.runs[0]!,
      status: "failed",
      retryable: false,
      retiredAt: "2026-11-07T05:00:00.000Z",
      retriedByRunId: "r2",
    };
    const html = renderToStaticMarkup(
      <AssignmentDetailView detail={data} projectId="proj" de isOwner />,
    );
    expect(html).toContain("Erneut versucht → neuer Lauf");
    expect(html).toContain('href="#run-r2"');
    expect(html).not.toContain("Fehlgeschlagen");
    const en = renderToStaticMarkup(
      <AssignmentDetailView detail={data} projectId="proj" de={false} isOwner />,
    );
    expect(en).toContain("Retried → new run");
  });

  it("hides the retry button from non-owners", () => {
    expect(render(false)).not.toContain("Lauf wiederholen");
  });
});

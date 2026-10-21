import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportEvidence, type PeriodicReport } from "./reports";
describe("periodic report evidence", () => {
  it("keeps missing plan measurements apart from source totals and exposes sampling limits", () => {
    const report: PeriodicReport = {
      id: "r",
      version: 1,
      planId: "p",
      acknowledgedRevision: 0,
      revisionProposal: null,
      revision: 2,
      status: "ready",
      noData: true,
      complete: false,
      period: {
        from: "2026-10-12",
        to: "2026-10-18",
        timezone: "Europe/Berlin",
      },
      projectReports: [
        {
          source: "matomo",
          accountId: "synthetic-account",
          report: "VisitsSummary.get",
          sessions: 10,
          clicks: null,
          impressions: null,
          conversions: null,
          currency: "EUR",
          timezone: "UTC",
          days: 1,
          freshness: "2026-10-19",
          complete: true,
          overlap: false,
        },
      ],
      planReports: [],
      limitations: ["PLAN_EXCEEDS_SPECIALIST_CHANNEL_LIMIT"],
      coverage: {
        requestedChannels: ["a", "b", "c", "d"],
        specialistMaxChannels: 3,
        specialistMaxPosts: 5,
        specialistRecentDays: 7,
      },
      attribution: {
        proposedLink: {
          url: "https://example.invalid/?utm_campaign=opaque",
          conflict: false,
        },
        appliedToContent: false,
      },
    };
    const html = renderToStaticMarkup(
      <ReportEvidence report={report} de={false} />,
    );
    expect(html).toContain("No plan-attributed measurements");
    expect(html).toContain("Project measurements by source (not plan totals)");
    expect(html).toContain("Full-period coverage is not established");
    expect(html).toContain("3 / 4");
    expect(html).toContain("PLAN_EXCEEDS_SPECIALIST_CHANNEL_LIMIT");
    expect(html).toContain("not applied");
    expect(html).not.toContain("Clicks: 0");
  });
});

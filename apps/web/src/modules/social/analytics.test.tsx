import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsTable, MetricsList } from "./analytics";
import type { PostMetricsPublication } from "./api";

// Post figures (ADR 0020, S8): per publication the latest counts, "not
// available" where the platform has none (Telegram), "not read yet" before
// the first read.

const fb: PostMetricsPublication = {
  publicationId: "p1",
  accountId: "a1",
  platform: "facebook",
  available: true,
  observedAt: "2026-11-03T10:00:00.000Z",
  metrics: { reactions: 12, comments: 3, shares: 4 },
};
const tg: PostMetricsPublication = { publicationId: "p2", accountId: "a2", platform: "telegram", available: false, observedAt: null, metrics: {} };
const fresh: PostMetricsPublication = { ...fb, publicationId: "p3", observedAt: null, metrics: {} };

describe("social post figures", () => {
  it("lists the latest counts per publication, with the platform", () => {
    const html = renderToStaticMarkup(<MetricsList publications={[fb, tg, fresh]} locale="en" />);
    expect(html).toContain("Facebook");
    expect(html).toContain("12 reactions");
    expect(html).toContain("3 comments");
    expect(html).toContain("4 shares");
    expect(html).toContain("Telegram: figures not available");
    expect(html).toContain("not read yet");
  });

  it("says when X figures are off and when the figures were read", () => {
    const xOff: PostMetricsPublication = { publicationId: "p4", accountId: "a4", platform: "x", available: false, reason: "paid_reads_off", observedAt: null, metrics: {} };
    expect(renderToStaticMarkup(<MetricsList publications={[xOff]} locale="en" />)).toContain("X: figures off (X bills every read; the owner can switch them on)");
    expect(renderToStaticMarkup(<MetricsList publications={[fb]} locale="en" />)).toContain("as of");
  });

  it("speaks German", () => {
    const html = renderToStaticMarkup(<MetricsList publications={[fb, tg]} locale="de" />);
    expect(html).toContain("12 Reaktionen");
    expect(html).toContain("Telegram: keine Kennzahlen verfügbar");
  });

  it("shows the posts of the last 30 days, or says there are none", () => {
    const html = renderToStaticMarkup(
      <AnalyticsTable
        items={[{ postId: "x1", title: "Launch", excerpt: "We launch", publishedAt: "2026-11-02T09:00:00.000Z", publications: [fb] }]}
        timeZone="Europe/Berlin"
        locale="en"
      />,
    );
    expect(html).toContain("Launch");
    expect(html).toContain("2026-11-02 10:00");
    expect(html).toContain("12 reactions");
    expect(renderToStaticMarkup(<AnalyticsTable items={[]} timeZone="UTC" locale="en" />)).toContain("No published posts in the last 30 days");
  });
});

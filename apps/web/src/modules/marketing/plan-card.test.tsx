import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanCard } from "./plan-card";
const spec = {
  title: "Organic strategy",
  goal: "Useful product education",
  audience: "Product teams",
  productScope: "Beta",
  campaignType: "product",
  channels: ["x-int"],
  language: "en",
  timezone: "Europe/Berlin",
  profileVersion: 1,
  policy: { id: "policy-id", version: 2 },
  pillars: [{ title: "Evidence", angle: "Reviewed claims only" }],
  cta: {
    label: "Learn more",
    url: "https://example.invalid",
    factId: "link-fact",
  },
  facts: [{ id: "link-fact", version: 1 }],
  sourceRefs: [],
  horizon: { startAt: "2026-10-21T08:00:00Z", endAt: "2026-10-28T08:00:00Z" },
  cadence: { rhythm: "weekly", weekdays: [1], times: ["10:00"] },
  contentTypes: ["social"],
  kpis: [
    {
      name: "Reach",
      unit: "impressions",
      baselineState: "no_data",
      metricRefs: [],
    },
  ],
  existingWork: [],
  approvalMode: "human_each",
  delivery: "postiz_draft",
  creative: { image: true, styleAssetIds: [] },
  monthlyBudgetMicros: 20_000_000,
  assumptions: ["A hypothesis"],
  unknowns: ["No traffic data"],
} as const;
const plan = {
  id: "saved-plan",
  revision: 2,
  specHash: "a".repeat(64),
  spec,
} as any;
const request = {
  id: "r",
  version: 1,
  packageHash: "a".repeat(64),
  status: "pending",
};
describe("MA-03 strategic review card", () => {
  it("shows the exact bounded strategy and no execution promise", () => {
    const html = renderToStaticMarkup(
      <PlanCard
        plan={plan}
        request={request}
        de={false}
        canDecide
        pending={false}
        onDecide={() => {}}
      />,
    );
    for (const text of [
      "Organic strategy",
      "Product teams",
      "Europe/Berlin",
      "Reviewed claims only",
      "link-fact",
      "No data",
      "A hypothesis",
      "Approve strategy only",
      "Proposed · not active",
      "no additional spend authority",
      "starts no assignments",
      "Approve each post before any external handoff",
      "As a draft in Postiz",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Activate plan");
  });
  it("prevents viewers and blocked plans from approving and escapes source text", () => {
    const viewer = renderToStaticMarkup(
      <PlanCard
        plan={plan}
        request={request}
        de
        canDecide={false}
        pending={false}
        onDecide={() => {}}
      />,
    );
    expect(viewer).toContain("Wartet auf den Owner");
    expect(viewer).not.toContain("Nur Strategie freigeben");
    const blocked = renderToStaticMarkup(
      <PlanCard
        plan={{
          ...plan,
          spec: { ...plan.spec, goal: '<script>alert("injected")</script>' },
        }}
        request={request}
        de={false}
        canDecide
        pending={false}
        blockers={["PLAN_SOURCE_SNAPSHOT_STALE"]}
        onDecide={() => {}}
      />,
    );
    expect(blocked).toContain("PLAN_SOURCE_SNAPSHOT_STALE");
    expect(blocked).toContain("disabled");
    expect(blocked).not.toContain("<script>");
  });
});

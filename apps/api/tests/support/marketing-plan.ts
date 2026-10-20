import type { DbTx } from "../../../../packages/db/src/index.ts";
import type {
  Scope,
  MarketingPlanSpec,
} from "../../../../packages/schemas/src/index.ts";
import { data, entity, list } from "../../src/shared.ts";
import { currentMarketingProfile } from "../../src/modules/marketing/brand/marketing-profile.ts";
import { X } from "./package-project.ts";
/** Synthetic strategy, using only stored project facts and policy versions. */
export async function planSpec(
  tx: DbTx,
  scope: Scope,
): Promise<MarketingPlanSpec> {
  const profile = (await currentMarketingProfile(tx, scope))!;
  const link = data(profile).officialLinks[0];
  const fact = await entity(tx, scope, "facts", link.factId);
  const source = await entity(tx, scope, "sources", data(fact).sourceId);
  const policy = (await list(tx, scope, "policies")).find(
    (r) => data(r).active,
  )!;
  return {
    title: "Synthetic organic strategy",
    goal: "Prepare useful product education for owner review",
    audience: "Product teams",
    productScope: "Synthetic beta",
    campaignType: "product",
    channels: [X],
    language: "en",
    profileVersion: profile.version,
    policy: { id: policy.id, version: policy.version },
    pillars: [
      { title: "Product education", angle: "Explain reviewed beta facts" },
    ],
    cta: {
      label: data(profile).primaryCtas[0],
      url: link.url,
      factId: fact.id,
    },
    facts: [{ id: fact.id, version: fact.version }],
    sourceRefs: [{ id: source.id, version: source.version }],
    horizon: {
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 8 * 86400000).toISOString(),
    },
    timezone: "Europe/Berlin",
    cadence: { rhythm: "weekly", weekdays: [1, 3], times: ["10:00"] },
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
    delivery: "publish",
    creative: { image: true, styleAssetIds: [] },
    monthlyBudgetMicros: 20_000_000,
    assumptions: ["Organic content can answer common product questions."],
    unknowns: ["No measured baseline yet."],
  };
}

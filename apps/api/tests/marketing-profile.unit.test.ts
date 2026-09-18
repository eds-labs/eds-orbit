import { expect, it } from "vitest";
import {
  content,
  marketingProfile,
  mission,
} from "../../../packages/schemas/src/index.ts";

const id = "11111111-1111-4111-8111-111111111111";

const profile = {
  productName: "uLiquid",
  contentLanguage: "en",
  internalLanguage: "de",
  audience: "Independent traders",
  positioning: "A transparent trading workspace",
  productStrategy: "Explain available product capabilities",
  presaleStrategy: "Use only verified presale facts",
  voice: ["Clear"],
  guardrails: ["No return claims"],
  primaryCtas: ["Learn more."],
  channelPriority: ["x"],
  notificationPreference: "telegram",
  officialLinks: [
    { label: "Website", url: "https://uliquid.example", factId: id },
  ],
  assetPolicy: "approved_only",
};

it("accepts a bounded versioned marketing profile contract", () => {
  expect(marketingProfile.parse(profile)).toMatchObject({
    productName: "uLiquid",
    notificationPreference: "telegram",
    assetPolicy: "approved_only",
  });
  expect(() =>
    marketingProfile.parse({ ...profile, externalBudget: 1 }),
  ).toThrow();
});

it("retains exclusive campaign context in mission and content contracts", () => {
  const campaign = mission.parse({
    title: "Product campaign",
    goal: "Explain the product workflow",
    audience: "Independent traders",
    channels: ["x"],
    startAt: "2026-09-18T00:00:00.000Z",
    endAt: "2026-09-19T00:00:00.000Z",
    maxContents: 1,
    targetAction: "Learn more.",
    contentType: "social",
    campaignType: "product",
    profileVersion: 1,
  });
  expect(campaign.campaignType).toBe("product");
  expect(
    content.parse({
      title: "Draft",
      body: "Learn more.",
      type: "social",
      channel: "x",
      missionId: id,
      campaignType: "product",
      profileVersion: 1,
      evidenceId: id,
      claims: [{ kind: "style", text: "Learn more." }],
    }),
  ).toMatchObject({
    missionId: id,
    campaignType: "product",
    profileVersion: 1,
  });
});

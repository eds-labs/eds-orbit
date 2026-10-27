import { describe, expect, it } from "vitest";
import {
  brandTermsField,
  mergeVisualIdentity,
  officialLinkCandidates,
  profileCampaignTypes,
} from "./profile-fields";

describe("brandTerms in the profile editor (WP3.4)", () => {
  it("sends lower-case words, one per line, without duplicates", () => {
    expect(brandTermsField(" Acme \npro\n\nACME\n")).toEqual({
      brandTerms: ["acme", "pro"],
    });
  });

  it("leaves the field out when empty, keeping the built-in words", () => {
    expect(brandTermsField("")).toEqual({});
    expect(brandTermsField(" \n \n")).toEqual({});
  });
});

describe("official target links from the project links", () => {
  const fact = (
    id: string,
    value: string,
    status = "verified",
    publicUse = true,
  ) => ({
    id,
    data: { key: id, value, status, publicUse },
  });
  const facts = [
    fact("f-site", "https://orbit.example"),
    fact("f-x", "https://x.com/orbit"),
    fact("f-draft", "https://discord.gg/orbit", "candidate"),
    fact("f-private", "https://t.me/orbit", "verified", false),
    fact("f-old", "https://old.example"),
  ];
  const projectLinks = [
    { label: "Website", url: "https://orbit.example" },
    { label: "X", url: "https://x.com/orbit" },
    { label: "Discord", url: "https://discord.gg/orbit" },
    { label: "Telegram", url: "https://t.me/orbit" },
  ];

  it("offers project links with a public verified fact and keeps the chosen ones checked", () => {
    const { candidates, unverified } = officialLinkCandidates(
      projectLinks,
      [{ label: "Homepage", url: "https://orbit.example", factId: "f-site" }],
      facts,
    );
    expect(
      candidates.map(({ label, url, factId, checked }) => [
        label,
        url,
        factId,
        checked,
      ]),
    ).toEqual([
      ["Homepage", "https://orbit.example", "f-site", true],
      ["X", "https://x.com/orbit", "f-x", false],
    ]);
    expect(unverified.map((l) => l.label)).toEqual(["Discord", "Telegram"]);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(candidates.length);
  });

  it("never drops a current official link that is not a project link", () => {
    const { candidates } = officialLinkCandidates(
      [],
      [{ label: "Old site", url: "https://old.example", factId: "f-old" }],
      facts,
    );
    expect(candidates).toEqual([
      {
        key: "official:0",
        label: "Old site",
        url: "https://old.example",
        factId: "f-old",
        checked: true,
      },
    ]);
  });
});

describe("campaign types of a profile", () => {
  it("uses the stored list", () => {
    expect(
      profileCampaignTypes({
        campaignTypes: ["product"],
        presaleStrategy: "kept",
      }),
    ).toEqual(["product"]);
  });
  it("keeps presale for profiles that store its strategy without a list", () => {
    expect(profileCampaignTypes({ presaleStrategy: "Launch plan" })).toEqual([
      "product",
      "presale",
    ]);
  });
  it("offers product campaigns only otherwise", () => {
    expect(profileCampaignTypes({})).toEqual(["product"]);
    expect(profileCampaignTypes(null)).toEqual(["product"]);
  });
});

describe("profile editor keeps brand kit fields", () => {
  const stored = {
    primaryColor: "#111111",
    logoAssetId: "logo-1",
    logos: { onDark: "logo-2" },
    productAssetIds: ["shot-1"],
    imagery: { kind: "photo", mood: "calm", subjects: "", avoid: ["people"] },
    typography: { headingWeight: 700, headingCase: "upper" },
    forbiddenDesigns: ["neon"],
    creative: { visualReview: true, maxArtCorrections: 2 },
  };

  it("sends imagery and creative unchanged when the form saves", () => {
    const saved = mergeVisualIdentity(stored, {
      primaryColor: "#222222",
      logoAssetId: "logo-1",
      designRules: ["Keep the logo unchanged."],
    });
    expect(saved).toEqual({
      ...stored,
      primaryColor: "#222222",
      designRules: ["Keep the logo unchanged."],
    });
  });

  it("removes the primary logo when the picker is cleared", () => {
    const saved = mergeVisualIdentity(stored, { primaryColor: "#111111" });
    expect(saved).not.toHaveProperty("logoAssetId");
    expect(saved.logos).toEqual(stored.logos);
  });

  it("works for a profile without a stored identity", () => {
    expect(mergeVisualIdentity(undefined, { primaryColor: "#000000" })).toEqual(
      {
        primaryColor: "#000000",
      },
    );
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrandKitView,
  VISION_REVIEW_HINT,
  brandKitSaveBody,
  brokenReferences,
  draftOf,
  mergeBrandKit,
  templateVariants,
  type KitAsset,
} from "./brand-kit-section";
import type { CreativeOptions } from "./creative-api";

const asset = (id: string, type: string, patch: Partial<KitAsset> = {}) => ({
  id,
  name: `Name ${id}`,
  type,
  approved: true,
  raster: true,
  hasHash: true,
  ...patch,
});
const assets: KitAsset[] = [
  asset("logo-1", "logo"),
  asset("logo-2", "logo"),
  asset("shot-1", "screenshot"),
  asset("old-logo", "logo", { approved: false }),
];
const options: CreativeOptions = {
  templates: [
    {
      id: "announcement",
      variants: { landscape: ["text_top"], square: ["text_top", "centered"] },
      needs: { art: "optional", product: "none" },
      copyLimits: { eyebrow: 30, headline: 60, subline: 90, cta: 20 },
    },
    {
      id: "tips",
      variants: { square: ["list_left"] },
      needs: { art: "none", product: "none" },
      copyLimits: { eyebrow: 30, headline: 60, subline: 90, cta: 20 },
    },
  ],
  formats: {},
  defaultChannelFormats: {
    linkedin: ["landscape"],
    x: ["landscape", "square"],
  },
  config: { enabledTemplates: ["announcement", "tips"], maxArtCorrections: 1 },
};
const identity = {
  primaryColor: "#112233",
  secondaryColor: "#254D66",
  headingFont: "Inter",
  logoAssetId: "logo-1",
  designRules: ["Keep the logo unchanged."],
  forbiddenDesigns: ["neon"],
  unknownFuture: { keep: true },
};
const profile = {
  productName: "Lumora Home",
  contentLanguage: "en",
  internalLanguage: "en",
  audience: "Homeowners",
  positioning: "Calm smart home",
  voice: ["calm"],
  guardrails: ["no hype"],
  primaryCtas: ["Join"],
  channelPriority: ["linkedin"],
  notificationPreference: "none",
  officialLinks: [],
  visualIdentity: identity,
};
const view = (over: Partial<Parameters<typeof BrandKitView>[0]> = {}) =>
  renderToStaticMarkup(
    <BrandKitView
      de={false}
      isOwner
      draft={draftOf(identity)}
      onChange={() => {}}
      assets={assets}
      options={options}
      pending={false}
      error={null}
      saved={false}
      onSave={() => {}}
      {...over}
    />,
  );

describe("brand kit editor", () => {
  it("brand kit save keeps colours, design rules and logo", () => {
    const draft = draftOf(identity);
    draft.logos = { onDark: "logo-2" };
    draft.productAssetIds = ["shot-1"];
    draft.imagery = {
      kind: "flat",
      mood: "warm",
      subjects: "",
      avoid: "a\n b\n",
    };
    draft.maxArtCorrections = 2;
    draft.visualReview = true;
    const body = brandKitSaveBody(profile, 7, draft) as any;
    expect(body.expectedVersion).toBe(7);
    expect(body.assetPolicy).toBe("approved_only");
    expect(body.productName).toBe("Lumora Home");
    expect(body.visualIdentity).toMatchObject({
      primaryColor: "#112233",
      secondaryColor: "#254D66",
      headingFont: "Inter",
      logoAssetId: "logo-1",
      designRules: ["Keep the logo unchanged."],
      forbiddenDesigns: ["neon"],
      unknownFuture: { keep: true },
      logos: { onDark: "logo-2" },
      productAssetIds: ["shot-1"],
      imagery: { kind: "flat", mood: "warm", subjects: "", avoid: ["a", "b"] },
      creative: { maxArtCorrections: 2, visualReview: true },
    });
  });

  it("sends the stored brand kit unchanged when nothing was edited", () => {
    const stored = {
      ...identity,
      logos: { mark: "logo-2" },
      imagery: { kind: "photo", mood: "calm", subjects: "", avoid: [] },
      typography: { headingWeight: 800, headingCase: "upper" },
      creative: {
        templates: { tips: { enabled: false } },
        logoPlacement: "top_left",
        formatsByChannel: { x: ["square"] },
      },
    };
    expect(mergeBrandKit(stored, draftOf(stored))).toEqual(stored);
  });

  it("variant options follow the template", () => {
    expect(templateVariants(options, "announcement")).toEqual([
      "text_top",
      "centered",
    ]);
    expect(templateVariants(options, "tips")).toEqual(["list_left"]);
    const html = view();
    expect(html).toContain("centered");
    expect(html).toContain("list left");
  });

  it("only owners can edit", () => {
    const html = view({ isOwner: false });
    expect(html).toContain("Only an owner can change the brand kit.");
    expect(html).not.toContain("Save brand kit");
    expect(html).not.toMatch(/<select(?![^>]*disabled)/);
    expect(view()).toContain("Save brand kit");
  });

  it("explains the cost of the vision review", () => {
    expect(view()).toContain(VISION_REVIEW_HINT);
  });

  it("shows unusable stored references so the owner can remove them", () => {
    const stale = draftOf({
      ...identity,
      logos: { mark: "old-logo" },
      productAssetIds: ["gone"],
    });
    expect(brokenReferences(stale, assets)).toEqual([
      { kind: "logo", role: "mark", assetId: "old-logo" },
      { kind: "product", assetId: "gone" },
    ]);
    const html = view({ draft: stale });
    expect(html).toContain("Some saved references cannot be used");
    expect(html).toContain("old-logo");
    expect(html).toContain("Remove");
    // Removing is a draft edit: the merged body no longer carries them.
    const cleaned = { ...stale, logos: {}, productAssetIds: [] };
    const merged = mergeBrandKit(identity, cleaned);
    expect(merged).not.toHaveProperty("logos");
    expect(merged).not.toHaveProperty("productAssetIds");
  });
});

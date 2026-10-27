import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrandKitView,
  VISION_REVIEW_HINT,
  brandKitSaveBody,
  brokenReferences,
  draftOf,
  editSaveBody,
  isStale,
  loadGate,
  saveErrorText,
  startEdit,
  mergeBrandKit,
  templateVariants,
  toKitAsset,
  type KitAsset,
} from "./brand-kit-section";
import type { CreativeOptions } from "./creative-api";

const asset = (id: string, type: string, patch: Partial<KitAsset> = {}) => ({
  id,
  version: 1,
  name: `Name ${id}`,
  type,
  approved: true,
  raster: true,
  hasHash: true,
  providerUse: false,
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

  // I2: provider use of the kit's logos and products, the owner's toggle.
  it("shows the provider use of the primary logo and the kit's chosen assets", () => {
    expect(
      toKitAsset({
        id: "a",
        version: 3,
        data: {
          type: "logo",
          usageApproved: true,
          assetStatus: "approved",
          providerUse: true,
        },
      }),
    ).toMatchObject({ version: 3, providerUse: true, approved: true });
    expect(
      toKitAsset({ id: "b", version: 1, data: { type: "logo" } }).providerUse,
    ).toBe(false);
    const draft = { ...draftOf(identity), productAssetIds: ["shot-1"] };
    const withUse = assets.map((a) =>
      a.id === "logo-1" ? { ...a, providerUse: true } : a,
    );
    const html = view({
      draft,
      assets: withUse,
      primaryLogoId: "logo-1",
      onProviderUse: () => {},
    });
    expect(html).toContain("Sending to AI providers");
    // The primary logo is on, the chosen screenshot is off.
    expect(html).toMatch(
      /Name logo-1[\s\S]*?<input type="checkbox"[^>]*checked=""[^>]*\/> May be sent to AI providers/,
    );
    expect(html).toContain("Name shot-1");
    expect(view({ draft, isOwner: false, primaryLogoId: "logo-1" })).toContain(
      "May be sent to AI providers: no",
    );
  });

  // R65: the project's opt-in to automatic creatives, an owner's choice.
  it("edits the project's opt-in to automatic creatives", () => {
    expect(draftOf(identity).automatic).toBe(false);
    const on = { ...draftOf(identity), automatic: true };
    expect(mergeBrandKit(identity, on).creative).toEqual({ enabled: true });
    // Off is the absent field, as before the opt-in existed.
    const off = mergeBrandKit(
      { ...identity, creative: { enabled: true, ctaStyle: "pill" } },
      {
        ...draftOf({
          ...identity,
          creative: { enabled: true, ctaStyle: "pill" },
        }),
        automatic: false,
      },
    );
    expect(off.creative).toEqual({ ctaStyle: "pill" });
    expect(
      draftOf({ ...identity, creative: { enabled: true } }).automatic,
    ).toBe(true);
    const html = view({ draft: on });
    expect(html).toContain("Automatic creatives for this project");
    expect(html).toMatch(
      /<input type="checkbox"[^>]*checked=""[^>]*\/> Automatic creatives/,
    );
    expect(view({ isOwner: false })).toMatch(
      /<input type="checkbox" disabled=""[^>]*\/> Automatic creatives/,
    );
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

describe("brand kit container logic", () => {
  const stored = { version: 3, data: profile };
  const ok = { loading: false, error: null, hasData: true };

  it("sends the version the edit started from and merges onto that base", () => {
    const edit = startEdit(stored);
    edit.kit.maxArtCorrections = 2;
    // Someone else saves version 4 with a new colour and kit field meanwhile.
    expect(isStale(4, edit)).toBe(true);
    expect(isStale(3, edit)).toBe(false);
    expect(isStale(4, null)).toBe(false);
    const body = editSaveBody(edit) as any;
    expect(body.expectedVersion).toBe(3);
    expect(body.visualIdentity).toMatchObject({
      primaryColor: "#112233",
      creative: { maxArtCorrections: 2 },
    });
  });

  it("names a version conflict in words", () => {
    expect(
      saveErrorText("MARKETING_PROFILE_VERSION_CONFLICT", false),
    ).toContain("changed elsewhere");
    expect(saveErrorText("OTHER", false)).toBe("OTHER");
    expect(saveErrorText(null, false)).toBeNull();
  });

  it("shows an error, not broken references, while a load failed", () => {
    expect(
      loadGate({
        profile: ok,
        options: ok,
        assets: { loading: false, error: new Error("x"), hasData: false },
      }),
    ).toEqual({ kind: "error", failed: ["assets"] });
    expect(
      loadGate({
        profile: { loading: false, error: new Error("x"), hasData: false },
        options: ok,
        assets: ok,
      }),
    ).toEqual({ kind: "error", failed: ["profile"] });
    expect(
      loadGate({
        profile: ok,
        options: { loading: false, error: new Error("x"), hasData: false },
        assets: ok,
      }),
    ).toEqual({ kind: "error", failed: ["options"] });
  });

  it("waits, reports a missing profile and is ready otherwise", () => {
    const loading = { loading: true, error: null, hasData: false };
    expect(loadGate({ profile: loading, options: ok, assets: ok })).toEqual({
      kind: "loading",
    });
    expect(
      loadGate({
        profile: { loading: false, error: null, hasData: false },
        options: ok,
        assets: ok,
      }),
    ).toEqual({ kind: "no-profile" });
    expect(loadGate({ profile: ok, options: ok, assets: ok })).toEqual({
      kind: "ready",
    });
  });

  it("offers a reload when the profile moved on", () => {
    const html = view({ stale: true, onReload: () => {} });
    expect(html).toContain("changed elsewhere");
    expect(html).toContain("Reload");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save brand kit/);
  });
});

import { describe, expect, it } from "vitest";
import { marketingProfile, visualIdentity } from "./index.ts";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
] as const;

/** A profile as it was saved before the brand kit: no new visualIdentity field. */
const savedProfile = {
  productName: "Lumora Home",
  contentLanguage: "en",
  internalLanguage: "de",
  audience: "Households that want a calm home",
  positioning: "Smart lighting that stays out of the way",
  productStrategy: "Explain what the product does",
  voice: ["Warm", "Clear"],
  guardrails: ["No health claims"],
  primaryCtas: ["Learn more."],
  channelPriority: ["x"],
  notificationPreference: "telegram",
  officialLinks: [
    { label: "Website", url: "https://lumora.example", factId: ids[0] },
  ],
  assetPolicy: "approved_only",
} as const;

const savedIdentity = {
  primaryColor: "#E8590C",
  secondaryColor: "#254D66",
  accentColor: "#F59F00",
  backgroundColor: "#FFF9F2",
  surfaceColor: "#FFFFFF",
  textColor: "#2B1B0E",
  headingFont: "DejaVu Sans",
  bodyFont: "Inter",
  logoAssetId: ids[1],
  designRules: ["Keep the logo clear of text."],
} as const;

const fullKit = {
  ...savedIdentity,
  logos: { secondary: ids[2], onDark: ids[3], onLight: ids[4], mark: ids[5] },
  productAssetIds: [ids[0], ids[1]],
  imagery: {
    kind: "photo",
    mood: "warm, calm, optimistic",
    subjects: "Living rooms in the evening, families, soft lamps",
    avoid: ["Stock handshake photos", "Neon colours"],
  },
  typography: { headingWeight: 700, headingCase: "upper" },
  forbiddenDesigns: ["Full-bleed text over busy photos"],
  creative: {
    templates: {
      lifestyle: { enabled: true, variant: "text_side" },
      product_showcase: { enabled: true, variant: "product_left" },
      tips: { enabled: false },
    },
    formatsByChannel: {
      x: ["landscape"],
      instagram: ["feed_portrait", "story"],
    },
    logoPlacement: "top_left",
    ctaStyle: "outline",
    maxArtCorrections: 2,
    visualReview: true,
  },
} as const;

describe("brand kit in the visual identity", () => {
  it("keeps saved profiles unchanged", () => {
    // Only the defaults that already existed are added; no brand kit key appears.
    const bare = marketingProfile.parse(savedProfile);
    expect(bare).toStrictEqual({
      ...savedProfile,
      visualIdentity: {
        primaryColor: "#0969FF",
        secondaryColor: "#254D66",
        accentColor: "#45C2FF",
        backgroundColor: "#F6FBFF",
        surfaceColor: "#FFFFFF",
        textColor: "#071522",
        headingFont: "Inter",
        bodyFont: "Inter",
        designRules: ["Preserve the approved logo unchanged."],
      },
    });
    const withIdentity = marketingProfile.parse({
      ...savedProfile,
      visualIdentity: savedIdentity,
    });
    expect(withIdentity).toStrictEqual({
      ...savedProfile,
      visualIdentity: savedIdentity,
    });
  });

  it("accepts a full brand kit and returns it unchanged", () => {
    expect(visualIdentity.parse(fullKit)).toStrictEqual(fullKit);
    const profile = marketingProfile.parse({
      ...savedProfile,
      visualIdentity: fullKit,
    });
    expect(profile.visualIdentity).toStrictEqual(fullKit);
  });

  it("defaults the optional imagery fields", () => {
    const parsed = visualIdentity.parse({
      imagery: { kind: "flat", mood: "calm" },
    });
    expect(parsed.imagery).toStrictEqual({
      kind: "flat",
      mood: "calm",
      subjects: "",
      avoid: [],
    });
  });

  it("accepts every variant the template has, also those only some formats can draw", () => {
    // Format restrictions are the resolver's job (R1), not the schema's.
    for (const [template, variant] of [
      ["lifestyle", "text_side"],
      ["lifestyle", "text_top"],
      ["product_showcase", "product_right"],
      ["feature_highlight", "product_left"],
      ["problem_solution", "text_bottom"],
      ["tips", "centered"],
      ["announcement", "text_bottom"],
      ["brand_message", "centered"],
    ] as const)
      expect(
        visualIdentity.safeParse({
          creative: { templates: { [template]: { enabled: true, variant } } },
        }).success,
        `${template}/${variant}`,
      ).toBe(true);
  });

  it("refuses a variant the template does not have", () => {
    expect(
      visualIdentity.safeParse({
        creative: {
          templates: { lifestyle: { enabled: true, variant: "product_left" } },
        },
      }).success,
    ).toBe(false);
    expect(
      visualIdentity.safeParse({
        creative: {
          templates: { tips: { enabled: true, variant: "text_side" } },
        },
      }).success,
    ).toBe(false);
    // A variant no template has.
    expect(
      visualIdentity.safeParse({
        creative: {
          templates: { lifestyle: { enabled: true, variant: "diagonal" } },
        },
      }).success,
    ).toBe(false);
  });

  it("refuses unknown templates", () => {
    expect(
      visualIdentity.safeParse({
        creative: { templates: { carousel: { enabled: true } } },
      }).success,
    ).toBe(false);
  });

  it("refuses unknown formats and out-of-range format lists", () => {
    const formats = (value: unknown) =>
      visualIdentity.safeParse({
        creative: { formatsByChannel: { x: value } },
      }).success;
    expect(formats(["landscape"])).toBe(true);
    expect(formats(["widescreen"])).toBe(false);
    expect(formats(["LANDSCAPE"])).toBe(false);
    expect(formats([])).toBe(false);
    expect(
      formats(["feed_portrait", "square", "story", "landscape", "square"]),
    ).toBe(false);
    // A format twice would draw the same rendition twice.
    expect(formats(["square", "square"])).toBe(false);
    expect(formats(["feed_portrait", "square", "story", "landscape"])).toBe(
      true,
    );
  });

  it("limits the channels of the format overrides to ten plain identifiers", () => {
    const channels = (names: string[]) =>
      visualIdentity.safeParse({
        creative: {
          formatsByChannel: Object.fromEntries(
            names.map((name) => [name, ["square"]]),
          ),
        },
      }).success;
    const ten = Array.from({ length: 10 }, (_, i) => `channel-${i}`);
    expect(channels(ten)).toBe(true);
    expect(channels([...ten, "channel-10"])).toBe(false);
    expect(channels(["linkedin-page"])).toBe(true);
    expect(channels([""])).toBe(false);
    expect(channels(["_hidden"])).toBe(false);
    expect(channels(["x".repeat(65)])).toBe(false);
  });

  it("drops a prototype key from the format overrides instead of storing it", () => {
    const parsed = visualIdentity.parse({
      creative: {
        formatsByChannel: JSON.parse('{"__proto__":["square"],"x":["story"]}'),
      },
    });
    expect(Object.keys(parsed.creative!.formatsByChannel!)).toEqual(["x"]);
    expect(Object.getPrototypeOf(parsed.creative!.formatsByChannel)).toBe(
      Object.prototype,
    );
  });

  it("bounds the lists and texts", () => {
    const parse = (value: Record<string, unknown>) =>
      visualIdentity.safeParse(value).success;
    const uuids = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
    expect(parse({ productAssetIds: uuids(20) })).toBe(true);
    expect(parse({ productAssetIds: uuids(21) })).toBe(false);
    expect(parse({ productAssetIds: ["not-an-id"] })).toBe(false);
    // The same product image twice would be placed twice.
    expect(parse({ productAssetIds: [uuids(1)[0], uuids(1)[0]] })).toBe(false);
    const imagery = (changes: Record<string, unknown>) =>
      parse({ imagery: { kind: "mixed", mood: "calm", ...changes } });
    expect(imagery({ mood: "m".repeat(300) })).toBe(true);
    expect(imagery({ mood: "m".repeat(301) })).toBe(false);
    expect(imagery({ subjects: "s".repeat(500) })).toBe(true);
    expect(imagery({ subjects: "s".repeat(501) })).toBe(false);
    expect(imagery({ avoid: Array(20).fill("a") })).toBe(true);
    expect(imagery({ avoid: Array(21).fill("a") })).toBe(false);
    expect(imagery({ avoid: ["a".repeat(200)] })).toBe(true);
    expect(imagery({ avoid: ["a".repeat(201)] })).toBe(false);
    expect(imagery({ kind: "watercolour" })).toBe(false);
    expect(parse({ forbiddenDesigns: Array(20).fill("a") })).toBe(true);
    expect(parse({ forbiddenDesigns: Array(21).fill("a") })).toBe(false);
    expect(parse({ forbiddenDesigns: ["a".repeat(300)] })).toBe(true);
    expect(parse({ forbiddenDesigns: ["a".repeat(301)] })).toBe(false);
  });

  it("limits typography and creative options to the supported values", () => {
    const parse = (value: Record<string, unknown>) =>
      visualIdentity.safeParse(value).success;
    for (const headingWeight of [600, 700, 800])
      expect(
        parse({ typography: { headingWeight, headingCase: "none" } }),
      ).toBe(true);
    expect(
      parse({ typography: { headingWeight: 500, headingCase: "none" } }),
    ).toBe(false);
    expect(
      parse({ typography: { headingWeight: 700, headingCase: "lower" } }),
    ).toBe(false);
    for (const maxArtCorrections of [0, 1, 2])
      expect(parse({ creative: { maxArtCorrections } })).toBe(true);
    expect(parse({ creative: { maxArtCorrections: 3 } })).toBe(false);
    expect(parse({ creative: { maxArtCorrections: 1.5 } })).toBe(false);
    expect(parse({ creative: { logoPlacement: "center" } })).toBe(false);
    expect(parse({ creative: { ctaStyle: "button" } })).toBe(false);
    expect(parse({ creative: { visualReview: "yes" } })).toBe(false);
    expect(parse({ creative: {} })).toBe(true);
  });

  it("refuses unknown keys in every brand kit object", () => {
    const parse = (value: Record<string, unknown>) =>
      visualIdentity.safeParse(value).success;
    expect(parse({ logos: { tertiary: ids[0] } })).toBe(false);
    expect(parse({ logos: { onDark: "not-an-id" } })).toBe(false);
    expect(parse({ imagery: { kind: "flat", mood: "x", extra: 1 } })).toBe(
      false,
    );
    expect(
      parse({ typography: { headingWeight: 700, headingCase: "none", x: 1 } }),
    ).toBe(false);
    expect(parse({ creative: { watermark: true } })).toBe(false);
    expect(
      parse({ creative: { templates: { tips: { enabled: true, x: 1 } } } }),
    ).toBe(false);
    expect(parse({ brandKit: {} })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { lumoraProfile } from "../../../../tests/support/creative-profile.ts";
import { DomainError } from "../../../shared.ts";
import { resolveCreativeConfig } from "./brand-kit.ts";
import {
  creativeBrief,
  resolveCreativeBrief,
  type StrategyCreative,
} from "./brief.ts";

const content = { title: "A calmer kitchen in three habits" };
const proposal: StrategyCreative = {
  keyMessage: "Small routines make a tidy kitchen",
  imageKind: "scene",
  motif: "A ceramic bowl of lemons on a linen-covered table",
  setting: "Sunny kitchen corner, morning light",
  template: "lifestyle",
  mood: "calm and bright",
};

function resolve(
  options: Partial<Parameters<typeof resolveCreativeBrief>[0]> & {
    identity?: Record<string, unknown>;
  } = {},
) {
  const { identity, ...input } = options;
  const profile = lumoraProfile(identity);
  return resolveCreativeBrief({
    proposal,
    content,
    profile,
    config: resolveCreativeConfig(profile),
    hasProducts: false,
    channelFormats: ["feed_portrait"],
    ...input,
  });
}

describe("resolveCreativeBrief", () => {
  it("completes a proposal with the profile, the formats and the layout's zones", () => {
    const brief = resolve({ channelFormats: ["feed_portrait", "square"] });
    expect(brief).toMatchObject({
      keyMessage: proposal.keyMessage,
      imageKind: "scene",
      motif: proposal.motif,
      setting: proposal.setting,
      mood: "calm and bright",
      template: "lifestyle",
      formats: ["feed_portrait", "square"],
      avoid: [
        "Stock handshake photos",
        "Cold blue office light",
        "Polaroid frames",
      ],
    });
    expect(brief.fallbackReason).toBeUndefined();
    expect(brief.goal).toContain("home goods");
    expect(brief.audience).toContain("calmer, tidier home");
    expect(brief.styleNotes).toContain("warm, calm, optimistic");
    // Text and logo only: no product is attached (R15).
    expect(brief.reservedZones).toHaveLength(2);
    for (const zone of brief.reservedZones) {
      expect(zone.w).toBeGreaterThan(0);
      expect(zone.x + zone.w).toBeLessThanOrEqual(1);
      expect(zone.y + zone.h).toBeLessThanOrEqual(1);
    }
  });

  it("takes the formats from the channel formats, without duplicates", () => {
    expect(
      resolve({ channelFormats: ["landscape", "story", "landscape"] }).formats,
    ).toEqual(["landscape", "story"]);
    expect(() => resolve({ channelFormats: [] })).toThrow(DomainError);
  });

  it("trims goal and audience to 300 characters", () => {
    const long = "Everyday routines made easier. ".repeat(40);
    const profile = lumoraProfile({}, { positioning: long, audience: long });
    const brief = resolveCreativeBrief({
      proposal,
      content,
      profile,
      config: resolveCreativeConfig(profile),
      hasProducts: false,
      channelFormats: ["square"],
    });
    expect(brief.goal).toHaveLength(300);
    expect(brief.audience).toHaveLength(300);
  });

  it("falls back from a disabled template to the first enabled one that fits", () => {
    const brief = resolve({
      identity: { creative: { templates: { lifestyle: { enabled: false } } } },
    });
    // Product templates need a product; problem_solution is the first scene fit.
    expect(brief.template).toBe("problem_solution");
    expect(brief.imageKind).toBe("scene");
    expect(brief.fallbackReason).toBe("TEMPLATE_DISABLED");
    const noArt = resolve({
      proposal: {
        ...proposal,
        imageKind: "graphic",
        template: "brand_message",
      },
      identity: {
        creative: { templates: { brand_message: { enabled: false } } },
      },
    });
    // A graphic has no photographic art: tips is the first template without required art.
    expect(noArt.template).toBe("tips");
    expect(noArt.fallbackReason).toBe("TEMPLATE_DISABLED");
  });

  it("fails clearly when every template is disabled", () => {
    const templates = Object.fromEntries(
      [
        "product_showcase",
        "feature_highlight",
        "problem_solution",
        "lifestyle",
        "tips",
        "announcement",
        "brand_message",
      ].map((id) => [id, { enabled: false }]),
    );
    expect(() => resolve({ identity: { creative: { templates } } })).toThrow(
      /NO_CREATIVE_TEMPLATE_ENABLED/,
    );
  });

  it("uses a scene with the lifestyle template when no product asset exists", () => {
    for (const imageKind of ["product", "combined"] as const) {
      const brief = resolve({
        proposal: { ...proposal, imageKind, template: "product_showcase" },
        hasProducts: false,
      });
      expect(brief).toMatchObject({
        imageKind: "scene",
        template: "lifestyle",
        fallbackReason: "NO_PRODUCT_ASSETS",
      });
    }
    // A template that carries a required product behaves the same.
    expect(
      resolve({
        proposal: { ...proposal, template: "feature_highlight" },
        hasProducts: false,
      }),
    ).toMatchObject({
      template: "lifestyle",
      fallbackReason: "NO_PRODUCT_ASSETS",
    });
  });

  it("keeps product kinds and the product zone when products exist", () => {
    const brief = resolve({
      proposal: {
        ...proposal,
        imageKind: "combined",
        template: "product_showcase",
      },
      hasProducts: true,
      channelFormats: ["landscape"],
    });
    expect(brief).toMatchObject({
      imageKind: "combined",
      template: "product_showcase",
    });
    expect(brief.reservedZones).toHaveLength(3);
    // A template without a product frame cannot show one: the art is a scene.
    expect(
      resolve({
        proposal: { ...proposal, imageKind: "product", template: "tips" },
        hasProducts: true,
      }),
    ).toMatchObject({ imageKind: "scene", template: "tips" });
    // A template that needs a product with a scene proposal shows the product.
    expect(
      resolve({
        proposal: { ...proposal, template: "feature_highlight" },
        hasProducts: true,
      }).imageKind,
    ).toBe("product");
  });

  it("drops the product zone of an optional product frame when no product is shown", () => {
    const brief = resolve({
      proposal: { ...proposal, template: "problem_solution" },
      hasProducts: true,
    });
    expect(brief.imageKind).toBe("scene");
    expect(brief.reservedZones).toHaveLength(2);
  });

  it("completes a missing proposal from the content", () => {
    const brief = resolve({
      proposal: null,
      content: { title: "Spring offers", coreMessage: "Fresh looks for less" },
    });
    expect(brief).toMatchObject({
      keyMessage: "Fresh looks for less",
      motif: "Spring offers",
      imageKind: "scene",
      template: "lifestyle",
      mood: "warm, calm, optimistic",
    });
    expect(
      resolve({ proposal: null, content: { title: "Spring offers" } })
        .keyMessage,
    ).toBe("Spring offers");
  });

  it("lets an explicit template and variant win over the proposal", () => {
    const brief = resolve({
      template: "tips",
      variant: "centered",
      channelFormats: ["square"],
    });
    expect(brief).toMatchObject({ template: "tips", variant: "centered" });
    expect(
      resolve({
        proposal: null,
        template: "feature_highlight",
        hasProducts: true,
      }).imageKind,
    ).toBe("product");
  });

  describe("variant", () => {
    const withDefault = (template: string, variant: string) => ({
      identity: {
        creative: { templates: { [template]: { enabled: true, variant } } },
      },
    });

    it("uses the project's default variant", () => {
      expect(resolve({ ...withDefault("lifestyle", "text_top") }).variant).toBe(
        "text_top",
      );
    });

    it("uses the template's first valid variant when the default does not fit the format (R1)", () => {
      const brief = resolve({
        proposal: {
          ...proposal,
          imageKind: "product",
          template: "product_showcase",
        },
        hasProducts: true,
        channelFormats: ["feed_portrait"],
        ...withDefault("product_showcase", "product_left"),
      });
      expect(brief.variant).toBe("text_top");
      // Valid on a later format: it stays the creative's variant, the pipeline adapts per format.
      expect(
        resolve({
          proposal: {
            ...proposal,
            imageKind: "product",
            template: "product_showcase",
          },
          hasProducts: true,
          channelFormats: ["feed_portrait", "landscape"],
          ...withDefault("product_showcase", "product_left"),
        }).variant,
      ).toBe("product_left");
    });

    it("prefers a side variant on landscape when none is chosen (R12, R16)", () => {
      expect(resolve({ channelFormats: ["landscape"] }).variant).toBe(
        "text_side",
      );
      expect(
        resolve({
          proposal: {
            ...proposal,
            imageKind: "product",
            template: "product_showcase",
          },
          hasProducts: true,
          channelFormats: ["landscape"],
        }).variant,
      ).toBe("product_right");
      expect(
        resolve({
          proposal: {
            ...proposal,
            imageKind: "product",
            template: "feature_highlight",
          },
          hasProducts: true,
          channelFormats: ["landscape"],
        }).variant,
      ).toBe("product_left");
      // Templates without a side variant, and tall formats, keep the first valid one.
      expect(
        resolve({
          proposal: { ...proposal, template: "problem_solution" },
          channelFormats: ["landscape"],
        }).variant,
      ).toBe("text_top");
      expect(resolve({ channelFormats: ["feed_portrait"] }).variant).toBe(
        "text_bottom",
      );
      // A landscape format among others still gets its side variant; tall ones adapt per format.
      expect(
        resolve({ channelFormats: ["feed_portrait", "landscape"] }).variant,
      ).toBe("text_side");
    });

    it("honours an explicit variant even on landscape", () => {
      expect(
        resolve({ channelFormats: ["landscape"], variant: "text_bottom" })
          .variant,
      ).toBe("text_bottom");
    });
  });
});

describe("creativeBrief (strategy output)", () => {
  it("accepts the proposal's shape and nothing else", () => {
    expect(creativeBrief.parse(proposal)).toEqual(proposal);
    expect(
      creativeBrief.safeParse({ ...proposal, mood: undefined }).success,
    ).toBe(true);
    for (const bad of [
      { ...proposal, template: "unknown" },
      { ...proposal, imageKind: "video" },
      { ...proposal, motif: "" },
      { ...proposal, motif: "x".repeat(301) },
      { ...proposal, extra: true },
    ])
      expect(creativeBrief.safeParse(bad).success).toBe(false);
  });
});

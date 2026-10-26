import { describe, expect, it } from "vitest";
import { lumoraProfile } from "../../../../tests/support/creative-profile.ts";
import { resolveCreativeConfig } from "./brand-kit.ts";

describe("resolveCreativeConfig", () => {
  it("enables every template and uses the defaults without creative settings", () => {
    const config = resolveCreativeConfig(lumoraProfile());
    expect(config).toEqual({
      enabledTemplates: [
        "product_showcase",
        "feature_highlight",
        "problem_solution",
        "lifestyle",
        "tips",
        "announcement",
        "brand_message",
      ],
      defaultVariants: {},
      formatsByChannel: {},
      logoPlacement: "auto",
      ctaStyle: "pill",
      maxArtCorrections: 1,
      visualReview: false,
    });
  });

  it("applies the brand kit's settings", () => {
    const formats = ["feed_portrait", "story"] as const;
    const profile = lumoraProfile({
      creative: {
        templates: {
          tips: { enabled: false, variant: "centered" },
          lifestyle: { enabled: true, variant: "text_side" },
          announcement: { enabled: true },
        },
        formatsByChannel: { instagram: [...formats] },
        logoPlacement: "bottom_right",
        ctaStyle: "outline",
        maxArtCorrections: 2,
        visualReview: true,
      },
    });
    const config = resolveCreativeConfig(profile);
    expect(config.enabledTemplates).not.toContain("tips");
    expect(config.enabledTemplates).toHaveLength(6);
    // The variant of a disabled template is kept; the brief only reads enabled ones.
    expect(config.defaultVariants).toEqual({
      tips: "centered",
      lifestyle: "text_side",
    });
    expect(config).toMatchObject({
      formatsByChannel: { instagram: ["feed_portrait", "story"] },
      logoPlacement: "bottom_right",
      ctaStyle: "outline",
      maxArtCorrections: 2,
      visualReview: true,
    });
    // A copy: changing the config never changes the profile.
    config.formatsByChannel.instagram!.push("square");
    expect(
      profile.visualIdentity.creative!.formatsByChannel!.instagram,
    ).toEqual(formats);
  });

  it("allows no art correction", () => {
    expect(
      resolveCreativeConfig(
        lumoraProfile({ creative: { maxArtCorrections: 0 } }),
      ).maxArtCorrections,
    ).toBe(0);
  });
});

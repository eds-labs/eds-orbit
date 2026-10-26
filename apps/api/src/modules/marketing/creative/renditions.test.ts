import { describe, expect, it } from "vitest";
import {
  composeCreative,
  CreativeError,
  type ComposeInput,
} from "../../../../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
} from "../../../../../../packages/creative/fixtures/demo-brands.ts";
import { composeRenditions, type RenditionInput } from "./renditions.ts";

const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};

async function input(
  changes: Partial<RenditionInput> = {},
): Promise<RenditionInput> {
  return {
    brand: await demoBrand("lumora"),
    brief: {
      template: "lifestyle",
      variant: "text_bottom",
      formats: ["square"],
    },
    copy: COPY,
    art: await fixtureArt("good", "lumora"),
    products: [],
    options: { logoPlacement: "auto", textScale: "m" },
    variantFixed: false,
    artState: { orbitGenerated: false, attempts: 0, maxCorrections: 1 },
    ...changes,
  };
}

/** A composer that refuses the first `overflows` calls with TEXT_OVERFLOW and records every call. */
function overflowing(overflows: number) {
  const calls: ComposeInput[] = [];
  const compose = async (request: ComposeInput) => {
    calls.push(request);
    if (calls.length <= overflows) throw new CreativeError("TEXT_OVERFLOW");
    return composeCreative(request);
  };
  return { compose, calls };
}

describe("composeRenditions", () => {
  it("composes one checked rendition per format and passes good art", async () => {
    const outcome = await composeRenditions(await input());
    expect(outcome.renditions).toHaveLength(1);
    const [rendition] = outcome.renditions;
    expect(rendition).toMatchObject({
      format: "square",
      variant: "text_bottom",
    });
    expect(rendition!.result).toMatchObject({ width: 1080, height: 1080 });
    expect(outcome).toMatchObject({
      verdict: "pass",
      failed: [],
      overflow: [],
      corrections: [],
      artCorrection: null,
    });
    // Composition and art checks, each tagged with its format.
    const codes = outcome.checks.map((c) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "TEXT_CONTRAST_LOW",
        "LOGO_INTEGRITY",
        "SUBJECT_TOO_SMALL",
        "EMPTY_AREA_EXCESSIVE",
      ]),
    );
    expect(outcome.checks.every((c) => c.detail?.format === "square")).toBe(
      true,
    );
  });

  it("draws each format in its own valid variant (R1)", async () => {
    const outcome = await composeRenditions(
      await input({
        brief: {
          template: "lifestyle",
          variant: "text_side",
          formats: ["landscape", "story"],
        },
      }),
    );
    expect(
      outcome.renditions.map((r) => [r.format, r.variant, r.result.width]),
    ).toEqual([
      ["landscape", "text_side", 1200],
      ["story", "text_bottom", 1080],
    ]);
  });

  it("corrects overflow with another variant for free and records it", async () => {
    const { compose, calls } = overflowing(1);
    const outcome = await composeRenditions(await input(), { compose });
    expect(calls.map((c) => c.variant)).toEqual(["text_bottom", "text_top"]);
    expect(outcome.renditions[0]!.variant).toBe("text_top");
    expect(outcome.verdict).toBe("corrected");
    expect(outcome.corrections).toEqual([
      expect.objectContaining({
        kind: "variant",
        reason: "TEXT_OVERFLOW",
        format: "square",
        value: "text_top",
        at: expect.any(String),
      }),
    ]);
  });

  it("gives up on copy that never fits after bounded corrections", async () => {
    const { compose, calls } = overflowing(Infinity);
    const outcome = await composeRenditions(await input(), { compose });
    // Two other variants, then the small text scale: four compositions.
    expect(calls.map((c) => [c.variant, c.options.textScale])).toEqual([
      ["text_bottom", "m"],
      ["text_top", "m"],
      ["text_side", "m"],
      ["text_side", "s"],
    ]);
    expect(outcome).toMatchObject({
      renditions: [],
      overflow: ["square"],
      verdict: "needs_owner",
      failed: ["TEXT_OVERFLOW"],
    });
  });

  it("keeps the composition that fit when a correction overflows (review 1)", async () => {
    // product_showcase on landscape: the first variants compose and fail an
    // art check; text_top does not fit the copy.
    const calls: Array<[string, string]> = [];
    const compose = async (request: ComposeInput) => {
      calls.push([request.variant, request.options.textScale]);
      if (request.variant === "text_top")
        throw new CreativeError("TEXT_OVERFLOW");
      return composeCreative(request);
    };
    const outcome = await composeRenditions(
      await input({
        brief: {
          template: "product_showcase",
          variant: "product_right",
          formats: ["landscape"],
        },
        art: await fixtureArt("flat", "lumora"),
        products: [await fixtureScreenshot("lumora")],
      }),
      { compose },
    );
    // The failed variant is not answered with the small text scale.
    expect(calls).toEqual([
      ["product_right", "m"],
      ["product_left", "m"],
      ["text_top", "m"],
    ]);
    expect(outcome.overflow).toEqual([]);
    expect(outcome.renditions).toHaveLength(1);
    expect(["product_right", "product_left"]).toContain(
      outcome.renditions[0]!.variant,
    );
    expect(outcome.failed).not.toContain("TEXT_OVERFLOW");
    expect(outcome.verdict).toBe("needs_owner");
  });

  it("returns the best attempt, not the last one", async () => {
    // text_bottom fails an art check; text_top composes worse (a render
    // fault on top); text_side does not fit.
    const calls: string[] = [];
    const compose = async (request: ComposeInput) => {
      calls.push(request.variant);
      if (request.variant === "text_side")
        throw new CreativeError("TEXT_OVERFLOW");
      const result = await composeCreative(request);
      return request.variant === "text_top" ? { ...result, width: 1 } : result;
    };
    const outcome = await composeRenditions(
      await input({ art: await fixtureArt("flat", "lumora") }),
      { compose },
    );
    expect(calls).toEqual(["text_bottom", "text_top", "text_side"]);
    expect(outcome.renditions.map((r) => [r.variant, r.textScale])).toEqual([
      ["text_bottom", "m"],
    ]);
    expect(outcome.failed).toContain("EMPTY_AREA_EXCESSIVE");
    expect(outcome.failed).not.toContain("CREATIVE_DIMENSIONS");
    // The checks are those of the rendition returned.
    expect(outcome.checks).toEqual(outcome.renditions[0]!.checks);
  });

  it("ranks an attempt with a refusal below every other (R34)", async () => {
    // text_bottom reads badly (two blockers); text_top carries bytes that
    // are not the approved logo (one blocker, but a refusal).
    const calls: string[] = [];
    const compose = async (request: ComposeInput) => {
      calls.push(request.variant);
      const result = await composeCreative(request);
      if (request.variant === "text_top")
        return {
          ...result,
          layers: result.layers.map((layer) =>
            layer.kind === "logo"
              ? { ...layer, sourceSha256: "0".repeat(64) }
              : layer,
          ),
        };
      return {
        ...result,
        // At the layout's maximum: a variant is the next correction.
        scrimOpacity: 1,
        layers: result.layers.map((layer) =>
          layer.color && layer.kind !== "logo"
            ? { ...layer, color: "#777777" }
            : layer,
        ),
        backdrops: Object.fromEntries(
          Object.entries(result.backdrops).map(([kind, backdrop]) => [
            kind,
            kind === "logo" ? backdrop : { p10: 0.5, p90: 0.5, busy: 1 },
          ]),
        ),
      };
    };
    const outcome = await composeRenditions(await input(), { compose });
    expect(calls).toEqual(["text_bottom", "text_top"]);
    expect(outcome.renditions[0]!.variant).toBe("text_bottom");
    expect(outcome.failed).toEqual(
      expect.arrayContaining(["TEXT_CONTRAST_LOW", "TEXT_BACKDROP_BUSY"]),
    );
    expect(outcome.failed).not.toContain("LOGO_INTEGRITY");
  });

  it("keeps a person's variant and leaves weak art to the owner", async () => {
    const outcome = await composeRenditions(
      await input({
        art: await fixtureArt("flat", "lumora"),
        variantFixed: true,
      }),
    );
    expect(outcome.verdict).toBe("needs_owner");
    expect(outcome.failed).toContain("EMPTY_AREA_EXCESSIVE");
    expect(outcome.corrections).toEqual([]);
    expect(outcome.renditions[0]!.variant).toBe("text_bottom");
    expect(outcome.artCorrection).toBeNull();
  });

  it("tries other variants for weak uploaded art, at most two", async () => {
    const outcome = await composeRenditions(
      await input({ art: await fixtureArt("flat", "lumora") }),
    );
    expect(outcome.verdict).toBe("needs_owner");
    expect(outcome.corrections.map((c) => c.kind)).toEqual([
      "variant",
      "variant",
    ]);
    expect(outcome.artCorrection).toBeNull();
  });

  it("tries free variants for Orbit's own art, then names the art correction (R35)", async () => {
    const outcome = await composeRenditions(
      await input({
        art: await fixtureArt("flat", "lumora"),
        artState: { orbitGenerated: true, attempts: 0, maxCorrections: 1 },
      }),
    );
    expect(outcome.verdict).toBe("needs_owner");
    expect(outcome.corrections.map((c) => c.kind)).toEqual([
      "variant",
      "variant",
    ]);
    expect(outcome.artCorrection).toMatchObject({
      kind: expect.stringMatching(/^(subject_larger|more_detail)$/),
    });
  });

  it("names the art correction when the free corrections run out (R35)", async () => {
    // A person's variant: no free correction for the art, the art is next.
    const fixed = await composeRenditions(
      await input({
        art: await fixtureArt("flat", "lumora"),
        variantFixed: true,
        artState: { orbitGenerated: true, attempts: 0, maxCorrections: 2 },
      }),
    );
    expect(fixed.corrections).toEqual([]);
    expect(fixed.artCorrection).not.toBeNull();
    // Without attempts left, or for uploaded art, there is none.
    for (const artState of [
      { orbitGenerated: true, attempts: 1, maxCorrections: 1 },
      { orbitGenerated: false, attempts: 0, maxCorrections: 1 },
    ])
      expect(
        (
          await composeRenditions(
            await input({
              art: await fixtureArt("flat", "lumora"),
              variantFixed: true,
              artState,
            }),
          )
        ).artCorrection,
      ).toBeNull();
  });

  it("passes engine refusals other than overflow to the caller", async () => {
    await expect(
      composeRenditions(await input({ art: undefined })),
    ).rejects.toMatchObject({ code: "ART_REQUIRED" });
  });
});

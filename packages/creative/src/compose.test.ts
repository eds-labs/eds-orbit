import { describe, expect, it } from "vitest";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  opaqueLogo,
} from "../fixtures/demo-brands.ts";
import { sha256Hex, type CreativeBrand, type RasterSource } from "./brand.ts";
import { CREATIVE_THRESHOLDS } from "./analysis.ts";
import { contrastRatio, relativeLuminance } from "./color.ts";
import {
  composeCreative,
  drawnArt,
  type ComposeInput,
  type ComposeResult,
  type LayerRecord,
} from "./compose.ts";
import { CREATIVE_FORMATS } from "./formats.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_TEMPLATE_IDS,
  type FormatId,
  type TemplateId,
} from "./ids.ts";
import {
  TEMPLATE_NEEDS,
  layoutFor,
  variantsFor,
  type Box,
} from "./templates.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
const TEXT_KINDS = ["eyebrow", "headline", "subline", "cta"] as const;

async function sizeOf(source: RasterSource) {
  const { default: sharp } = await import("sharp");
  const meta = await sharp(source.bytes).metadata();
  return { width: meta.width!, height: meta.height! };
}

function layer(result: ComposeResult, kind: LayerRecord["kind"]) {
  const found = result.layers.find((l) => l.kind === kind);
  if (!found) throw new Error(`no ${kind} layer`);
  return found;
}

/** The contrast QA computes: the text colour against the darker and the lighter end of its backdrop. */
function backdropContrast(result: ComposeResult, record: LayerRecord) {
  const backdrop = result.backdrops[record.kind as (typeof TEXT_KINDS)[number]];
  if (!backdrop || !record.color)
    throw new Error(`no backdrop for ${record.kind}`);
  return Math.min(
    contrastRatio(record.color, backdrop.p10),
    contrastRatio(record.color, backdrop.p90),
  );
}

/** Logo contrast as QA computes it (Task 5): the logo layer's colour against its recorded backdrop. */
function logoContrast(result: ComposeResult) {
  const logo = layer(result, "logo");
  const backdrop = result.backdrops.logo!;
  return Math.min(
    contrastRatio(logo.color!, backdrop.p10),
    contrastRatio(logo.color!, backdrop.p90),
  );
}

/** A transparent logo drawn only in white: invisible on white, readable on dark. */
async function whiteLogo(): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160">
        <circle cx="80" cy="80" r="64" fill="#FFFFFF"/>
        <rect x="176" y="48" width="280" height="64" rx="18" fill="#FFFFFF"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** Art of eight-pixel stripes in black and dark grey: structure at text scale, dark enough for white text everywhere. */
async function stripedArt(): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
        <defs><pattern id="s" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="8" height="16" fill="#404040"/></pattern></defs>
        <rect width="1024" height="1024" fill="#000000"/>
        <rect width="1024" height="1024" fill="url(#s)"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** QA's requirement for one text layer (spec §9, ruling R2); the subline is body text. */
const required = (record: LayerRecord) =>
  record.kind !== "subline" && record.fontSize! >= 32 ? 3 : 4.5;

/** |h − w·srcH/srcW| ≤ 1: the box keeps the source's aspect to the pixel. */
function expectAspectKept(record: LayerRecord) {
  const { w, h } = record.box;
  const source = record.sourceSize!;
  expect(Math.abs(h - (w * source.height) / source.width)).toBeLessThanOrEqual(
    1,
  );
}

const inside = (box: Box, outer: Box) =>
  box.x >= outer.x &&
  box.y >= outer.y &&
  box.x + box.w <= outer.x + outer.w &&
  box.y + box.h <= outer.y + outer.h;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function lifestyleInput(
  brandName: "lumora" | "kestrel",
  art: "good" | "tiny_subject" | "flat" | "bright" = "good",
  format: FormatId = "feed_portrait",
): Promise<ComposeInput> {
  return {
    template: "lifestyle",
    variant: "text_bottom",
    format,
    brand: await demoBrand(brandName),
    copy: COPY,
    art: await fixtureArt(art, brandName),
    options: OPTIONS,
  };
}

describe("composeCreative", () => {
  it("composes lifestyle in 4:5 with the approved logo", async () => {
    const input = await lifestyleInput("kestrel");
    const result = await composeCreative(input);

    expect(result.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect([result.width, result.height]).toEqual([1080, 1350]);
    const { default: sharp } = await import("sharp");
    const meta = await sharp(result.png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1080, 1350]);

    const primary = input.brand.logos.find((l) => l.role === "primary")!;
    const logo = layer(result, "logo");
    expect(logo.sourceSha256).toBe(primary.sha256);
    expect(logo.sourceSize).toEqual(await sizeOf(primary));
    expectAspectKept(logo);
    expect(result.logoRole).toBe("primary");
    expect(result.renderer.sharp).toBe(sharp.versions.sharp);
  });

  it("refuses logo bytes that are not the approved ones", async () => {
    const input = await lifestyleInput("kestrel");
    const tampered: CreativeBrand = {
      ...input.brand,
      logos: input.brand.logos.map((logo) => ({
        ...logo,
        sha256: "0".repeat(64),
      })),
    };
    await expect(
      composeCreative({ ...input, brand: tampered }),
    ).rejects.toMatchObject({ code: "BRAND_ASSET_INTEGRITY_FAILED" });
  });

  it("refuses art and screenshots whose bytes do not match their hash", async () => {
    const input = await lifestyleInput("kestrel");
    const art = {
      ...input.art!,
      bytes: Buffer.concat([input.art!.bytes, Buffer.from([0])]),
    };
    await expect(composeCreative({ ...input, art })).rejects.toMatchObject({
      code: "BRAND_ASSET_INTEGRITY_FAILED",
    });
    const screenshot = await fixtureScreenshot("kestrel");
    await expect(
      composeCreative({
        ...input,
        template: "feature_highlight",
        variant: "text_top",
        products: [{ ...screenshot, sha256: "f".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "BRAND_ASSET_INTEGRITY_FAILED" });
  });

  it("uses the dark-background logo on dark art", async () => {
    const input = await lifestyleInput("lumora");
    const result = await composeCreative(input);
    const onDark = input.brand.logos.find((l) => l.role === "onDark")!;
    expect(result.logoRole).toBe("onDark");
    const logo = layer(result, "logo");
    expect(logo.role).toBe("onDark");
    expect(logo.sourceSha256).toBe(onDark.sha256);
    expectAspectKept(logo);
  });

  it("keeps the screenshot unchanged", async () => {
    const brand = await demoBrand("kestrel");
    const screenshot = await fixtureScreenshot("kestrel");
    const result = await composeCreative({
      template: "feature_highlight",
      variant: "text_top",
      format: "square",
      brand,
      copy: COPY,
      products: [screenshot],
      options: OPTIONS,
    });
    const product = layer(result, "product");
    expect(product.sourceSha256).toBe(screenshot.sha256);
    expect(product.sourceSize).toEqual(await sizeOf(screenshot));
    expect(product.scale).toBeCloseTo(
      product.box.w / product.sourceSize!.width,
      3,
    );
    expectAspectKept(product);

    // The drawn pixels are the approved screenshot, only scaled: no tint, crop or frame over it.
    const { default: sharp } = await import("sharp");
    const { x, y, w, h } = product.box;
    const drawn = await sharp(result.png)
      .extract({ left: x, top: y, width: w, height: h })
      .removeAlpha()
      .raw()
      .toBuffer();
    const scaled = await sharp(screenshot.bytes)
      .resize(w, h, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    let diff = 0;
    for (let i = 0; i < drawn.length; i++)
      diff += Math.abs(drawn[i]! - scaled[i]!);
    expect(diff / drawn.length).toBeLessThan(2);
  });

  it("raises the scrim until text contrast passes", async () => {
    const input = await lifestyleInput("lumora", "bright");
    const result = await composeCreative(input);
    const base = layoutFor("lifestyle", "text_bottom", "feed_portrait", OPTIONS)
      .scrim!.base;
    expect(result.scrimOpacity).toBeGreaterThan(base);
    expect(
      backdropContrast(result, layer(result, "subline")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      backdropContrast(result, layer(result, "headline")),
    ).toBeGreaterThanOrEqual(3);
    expect(layer(result, "scrim").box).toEqual(
      layoutFor("lifestyle", "text_bottom", "feed_portrait", OPTIONS).scrim!
        .box,
    );
  });

  it("raises the scrim until busy art behind the text is calm (R17)", async () => {
    // Dark stripes: white text reads on them at any scrim, but they are busy.
    expect(contrastRatio("#FFFFFF", "#404040")).toBeGreaterThan(4.5);
    const input = await lifestyleInput("kestrel");
    const art = await stripedArt();
    const result = await composeCreative({ ...input, art });
    const scrim = layoutFor(
      "lifestyle",
      "text_bottom",
      "feed_portrait",
      OPTIONS,
    ).scrim!;
    expect(result.scrimOpacity).toBeGreaterThan(scrim.base);
    expect(result.scrimOpacity).toBeLessThanOrEqual(scrim.max);
    for (const record of result.layers.filter((l) =>
      TEXT_KINDS.includes(l.kind as never),
    )) {
      const backdrop =
        result.backdrops[record.kind as (typeof TEXT_KINDS)[number]]!;
      expect(backdrop.busy, record.kind).toBeLessThanOrEqual(
        CREATIVE_THRESHOLDS.busyText,
      );
      expect(backdropContrast(result, record)).toBeGreaterThanOrEqual(
        required(record),
      );
    }
    // The pill is a flat backdrop of its own.
    expect(result.backdrops.cta!.busy).toBe(0);
  });

  it.each([
    // Above the scrim, which reaches 0.22·H past the text (T20), and right of the logo.
    ["lifestyle", "text_bottom", { x: 300, y: 100, w: 600, h: 300 }],
    // The art strip behind the screenshot is contained over a blurred copy; left of the card.
    ["feature_highlight", "text_top", { x: 0, y: 730, w: 90, h: 560 }],
  ] as const)(
    "draws exactly the art drawnArt returns (%s, R21)",
    async (template, variant, region) => {
      const input = await lifestyleInput("kestrel");
      const products =
        template === "feature_highlight"
          ? [await fixtureScreenshot("kestrel")]
          : undefined;
      const result = await composeCreative({
        ...input,
        template,
        variant,
        products,
      });
      const layout = layoutFor(template, variant, "feed_portrait", OPTIONS);
      const art = layout.art!;
      const drawn = await drawnArt(input.art!, layout);
      const { default: sharp } = await import("sharp");
      const meta = await sharp(drawn).metadata();
      expect([meta.width, meta.height]).toEqual([art.w, art.h]);
      // Where nothing is drawn over the art, the creative shows these pixels.
      const pixels = async (png: Buffer, left: number, top: number) =>
        sharp(png)
          .extract({ left, top, width: region.w, height: region.h })
          .removeAlpha()
          .raw()
          .toBuffer();
      const composed = await pixels(result.png, region.x, region.y);
      const fromDrawn = await pixels(drawn, region.x - art.x, region.y - art.y);
      let diff = 0;
      for (let i = 0; i < composed.length; i++)
        diff += Math.abs(composed[i]! - fromDrawn[i]!);
      expect(diff / composed.length).toBeLessThan(0.5);
      // Bytes that are not the approved ones are refused here too.
      await expect(
        drawnArt({ ...input.art!, sha256: "0".repeat(64) }, layout),
      ).rejects.toMatchObject({ code: "BRAND_ASSET_INTEGRITY_FAILED" });
    },
  );

  it.each(["lumora", "kestrel"] as const)(
    "keeps the scrim when the same art comes as JPEG, at 768 or 2048 px or with noise (%s, R20)",
    async (brandName) => {
      const brand = await demoBrand(brandName);
      const art = await fixtureArt("good", brandName);
      const { default: sharp } = await import("sharp");
      const source = (bytes: Buffer) => ({ bytes, sha256: sha256Hex(bytes) });
      const { data, info } = await sharp(art.bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let seed = 7;
      const uniform = () =>
        (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const noisy = Buffer.from(data);
      for (let i = 0; i < noisy.length; i++)
        noisy[i] = Math.max(
          0,
          Math.min(
            255,
            Math.round(
              noisy[i]! +
                2 *
                  Math.sqrt(3) *
                  (uniform() + uniform() + uniform() + uniform() - 2),
            ),
          ),
        );
      const variants = [
        source(await sharp(art.bytes).jpeg({ quality: 70 }).toBuffer()),
        await fixtureArt("good", brandName, { width: 2048, height: 2048 }),
        await fixtureArt("good", brandName, { width: 768, height: 768 }),
        source(
          await sharp(noisy, {
            raw: { width: info.width, height: info.height, channels: 3 },
          })
            .png()
            .toBuffer(),
        ),
      ];
      for (const template of [
        "lifestyle",
        "problem_solution",
        "brand_message",
      ] as const) {
        const input = {
          template,
          variant: variantsFor(template, "feed_portrait")[0]!,
          format: "feed_portrait" as const,
          brand,
          copy: COPY,
          options: OPTIONS,
        };
        const reference = (await composeCreative({ ...input, art }))
          .scrimOpacity;
        for (const [i, variant] of variants.entries())
          expect(
            Math.abs(
              (await composeCreative({ ...input, art: variant })).scrimOpacity -
                reference,
            ),
            `${template} variant ${i}`,
          ).toBeLessThanOrEqual(0.1 + 1e-9);
      }
    },
    120_000,
  );

  it.each(["lumora", "kestrel"] as const)(
    "keeps an opaque logo visible on its own background (%s)",
    async (brandName) => {
      const input = await lifestyleInput(brandName, "bright");
      const logo = await opaqueLogo();
      const result = await composeCreative({
        ...input,
        brand: { ...input.brand, logos: [{ ...logo, role: "primary" }] },
      });
      const drawn = layer(result, "logo");
      expect(drawn.sourceSha256).toBe(logo.sha256);
      expectAspectKept(drawn);
      // The white square is the logo's own backdrop: it is never plated, and
      // its contrast is the dark mark against that square.
      expect(result.layers.some((l) => l.kind === "logo_plate")).toBe(false);
      expect(result.backdrops.logo).toEqual({ p10: 1, p90: 1 });
      expect(relativeLuminance(drawn.color!)).toBeLessThan(0.1);
      expect(logoContrast(result)).toBeGreaterThanOrEqual(2);
    },
  );

  it("plates a white logo on a white surface in a colour it reads on", async () => {
    const input = await lifestyleInput("lumora", "bright");
    const logo = await whiteLogo();
    const result = await composeCreative({
      ...input,
      brand: {
        ...input.brand,
        palette: { ...input.brand.palette, surfaceColor: "#FFFFFF" },
        logos: [{ ...logo, role: "primary" }],
      },
    });
    const drawn = layer(result, "logo");
    const plate = layer(result, "logo_plate");
    expect(drawn.sourceSha256).toBe(logo.sha256);
    expectAspectKept(drawn);
    expect(inside(drawn.box, plate.box)).toBe(true);
    expect(plate.color).not.toBe("#FFFFFF");
    expect(logoContrast(result)).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["feed_portrait", "text_bottom"],
    ["landscape", "text_side"],
  ] as const)(
    "puts a plate behind a dark transparent logo on dark art (%s)",
    async (format, variant) => {
      const kestrel = await demoBrand("kestrel");
      const result = await composeCreative({
        template: "lifestyle",
        variant,
        format,
        brand: kestrel,
        copy: COPY,
        art: await fixtureArt("good", "lumora"),
        options: OPTIONS,
      });
      const logo = layer(result, "logo");
      const plate = layer(result, "logo_plate");
      expect(logo.sourceSha256).toBe(kestrel.logos[0]!.sha256);
      expectAspectKept(logo);
      expect(inside(logo.box, plate.box)).toBe(true);
      const anchor = layoutFor("lifestyle", variant, format, OPTIONS).logo.box;
      expect(inside(plate.box, anchor)).toBe(true);
      // The plate's padding follows the anchor height (R19), so the logo stays large.
      expect(logo.box.y - plate.box.y).toBe(Math.round(0.12 * anchor.h));
      expect(Math.max(logo.box.w, logo.box.h)).toBeGreaterThanOrEqual(
        0.06 * Math.min(result.width, result.height),
      );
      expect(plate.color).toBe(kestrel.palette.surfaceColor);
      expect(logoContrast(result)).toBeGreaterThanOrEqual(2);
    },
  );

  it("refuses a missing required art or product", async () => {
    const input = await lifestyleInput("kestrel");
    await expect(
      composeCreative({ ...input, art: undefined }),
    ).rejects.toMatchObject({ code: "ART_REQUIRED" });
    await expect(
      composeCreative({
        ...input,
        template: "feature_highlight",
        variant: "text_top",
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_ASSET_REQUIRED" });
  });

  it("refuses a screenshot the template has no place for", async () => {
    const input = await lifestyleInput("kestrel");
    await expect(
      composeCreative({
        ...input,
        products: [await fixtureScreenshot("kestrel")],
      }),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_INPUT" });
  });

  it("omits the CTA with ctaStyle none", async () => {
    const input = await lifestyleInput("kestrel");
    const result = await composeCreative({
      ...input,
      brand: { ...input.brand, ctaStyle: "none" },
    });
    expect(result.layers.some((l) => l.kind === "cta")).toBe(false);
    expect(result.backdrops.cta).toBeUndefined();
    expect(result.ctaStyleApplied).toBe("none");
  });

  it("records the pill as the CTA backdrop and picks a readable label", async () => {
    const input = await lifestyleInput("lumora");
    const result = await composeCreative(input);
    const cta = layer(result, "cta");
    const pill = relativeLuminance(input.brand.palette.primaryColor);
    expect(result.ctaStyleApplied).toBe("pill");
    expect(result.backdrops.cta).toEqual({ p10: pill, p90: pill, busy: 0 });
    expect(backdropContrast(result, cta)).toBeGreaterThanOrEqual(required(cta));
  });

  it("falls back to an outline CTA when no label colour is readable on the pill", async () => {
    const input = await lifestyleInput("lumora");
    const brand: CreativeBrand = {
      ...input.brand,
      palette: {
        ...input.brand.palette,
        primaryColor: "#B0B0B0",
        textColor: "#6B6B6B",
      },
    };
    const result = await composeCreative({ ...input, brand });
    expect(result.ctaStyleApplied).toBe("outline");
    const cta = layer(result, "cta");
    expect(result.backdrops.cta!.p10).not.toBe(relativeLuminance("#B0B0B0"));
    expect(backdropContrast(result, cta)).toBeGreaterThanOrEqual(required(cta));
  });

  it("anchors the text stack at the scrim's solid edge", async () => {
    const bottom = await composeCreative(await lifestyleInput("kestrel"));
    const textBottom = layoutFor(
      "lifestyle",
      "text_bottom",
      "feed_portrait",
      OPTIONS,
    ).textBox;
    const texts = bottom.layers.filter((l) =>
      TEXT_KINDS.includes(l.kind as never),
    );
    expect(Math.max(...texts.map((l) => l.box.y + l.box.h))).toBe(
      textBottom.y + textBottom.h,
    );

    const input = await lifestyleInput("kestrel");
    const top = await composeCreative({ ...input, variant: "text_top" });
    const textTop = layoutFor(
      "lifestyle",
      "text_top",
      "feed_portrait",
      OPTIONS,
    ).textBox;
    const topTexts = top.layers.filter((l) =>
      TEXT_KINDS.includes(l.kind as never),
    );
    expect(Math.min(...topTexts.map((l) => l.box.y))).toBe(textTop.y);
  });

  it("leaves brand-fill templates without art unscrimmed", async () => {
    const brand = await demoBrand("kestrel");
    const result = await composeCreative({
      template: "product_showcase",
      variant: "product_right",
      format: "square",
      brand,
      copy: COPY,
      products: [await fixtureScreenshot("kestrel")],
      options: OPTIONS,
    });
    expect(result.scrimOpacity).toBe(0);
    expect(result.layers.some((l) => l.kind === "scrim")).toBe(false);
    for (const record of result.layers.filter((l) =>
      TEXT_KINDS.includes(l.kind as never),
    ))
      expect(backdropContrast(result, record)).toBeGreaterThanOrEqual(
        required(record),
      );
  });

  it("uses a forced logo role and its narrower layout box", async () => {
    const input = await lifestyleInput("kestrel");
    const primary = input.brand.logos[0]!;
    const brand: CreativeBrand = {
      ...input.brand,
      logos: [primary, { ...primary, role: "mark" }],
    };
    const result = await composeCreative({ ...input, brand, logoRole: "mark" });
    expect(result.logoRole).toBe("mark");
    const anchor = layoutFor("lifestyle", "text_bottom", "feed_portrait", {
      ...OPTIONS,
      logoRole: "mark",
    }).logo.box;
    expect(inside(layer(result, "logo").box, anchor)).toBe(true);
    expect(layer(result, "logo").role).toBe("mark");
    await expect(
      composeCreative({ ...input, logoRole: "onLight" }),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_INPUT" });
  });

  it("is deterministic in one environment", async () => {
    const input = await lifestyleInput("lumora");
    const first = await composeCreative(input);
    const second = await composeCreative(input);
    expect(second.sha256).toBe(first.sha256);
    expect(second.layers).toEqual(first.layers);
    expect(second.backdrops).toEqual(first.backdrops);
  });

  it("fails on overflow", async () => {
    const input = await lifestyleInput("kestrel");
    const headline = "A headline far too long for any layout "
      .repeat(8)
      .slice(0, 280);
    expect(headline).toHaveLength(280);
    await expect(
      composeCreative({ ...input, copy: { ...COPY, headline } }),
    ).rejects.toMatchObject({ code: "TEXT_OVERFLOW" });
  });

  it("refuses an out-of-range scrim boost", async () => {
    const input = await lifestyleInput("kestrel");
    await expect(
      composeCreative({ ...input, scrimBoost: 4 as never }),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_INPUT" });
  });

  describe.each(CREATIVE_FORMAT_IDS)("every template on %s", (format) => {
    it("places readable layers inside the safe area without overlaps", async () => {
      for (const brandName of ["lumora", "kestrel"] as const) {
        const brand = await demoBrand(brandName);
        for (const template of CREATIVE_TEMPLATE_IDS) {
          const variant = defaultVariant(template, format);
          // R23: busy art under a full tint stops at 0.6 and stays busy (QA reports it).
          const busyCap =
            layoutFor(template, variant, format, OPTIONS).scrim?.direction ===
            "full"
              ? 0.6
              : Infinity;
          const result = await composeCreative({
            template,
            variant,
            format,
            brand,
            copy: COPY,
            art: await fixtureArt("good", brandName),
            products:
              TEMPLATE_NEEDS[template].product === "none"
                ? undefined
                : [await fixtureScreenshot(brandName)],
            options: OPTIONS,
          });
          const { width, height, safe } = CREATIVE_FORMATS[format];
          expect([result.width, result.height]).toEqual([width, height]);
          const safeBox = {
            x: safe.left,
            y: safe.top,
            w: width - safe.left - safe.right,
            h: height - safe.top - safe.bottom,
          };
          const placed = result.layers.filter(
            (l) =>
              l.kind !== "art" && l.kind !== "scrim" && l.kind !== "logo_plate",
          );
          for (const record of placed) {
            expect(
              inside(record.box, safeBox),
              `${template} ${record.kind}`,
            ).toBe(true);
            if (TEXT_KINDS.includes(record.kind as never)) {
              expect(
                backdropContrast(result, record),
                `${brandName} ${template} ${record.kind}`,
              ).toBeGreaterThanOrEqual(required(record));
              if (result.scrimOpacity < busyCap)
                expect(
                  result.backdrops[record.kind as (typeof TEXT_KINDS)[number]]!
                    .busy,
                  `${brandName} ${template} ${record.kind} busy`,
                ).toBeLessThanOrEqual(CREATIVE_THRESHOLDS.busyText);
            }
          }
          for (const [i, a] of placed.entries())
            for (const b of placed.slice(i + 1))
              expect(
                overlaps(a.box, b.box),
                `${template} ${a.kind}/${b.kind}`,
              ).toBe(false);
          const plate = result.layers.find((l) => l.kind === "logo_plate");
          if (plate) expect(inside(plate.box, safeBox)).toBe(true);
          expect(
            logoContrast(result),
            `${brandName} ${template} logo`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }, 120_000);
  });
});

/** The default variant as the resolver picks it (R12: on landscape a side variant first for templates with a product box). */
function defaultVariant(template: TemplateId, format: FormatId) {
  const variants = variantsFor(template, format);
  if (format === "landscape" && TEMPLATE_NEEDS[template].product !== "none") {
    const side = variants.find((v) =>
      ["product_right", "product_left", "text_side"].includes(v),
    );
    if (side) return side;
  }
  return variants[0]!;
}

describe("brand scrim, pill ring and band art (T20)", () => {
  /** Kestrel with another palette; everything else (logos, CTA style) stays. */
  const kestrelWith = async (palette: Partial<CreativeBrand["palette"]>) => {
    const brand = await demoBrand("kestrel");
    return { ...brand, palette: { ...brand.palette, ...palette } };
  };

  it("tints the scrim with a deep secondary colour and falls back otherwise", async () => {
    const input = await lifestyleInput("kestrel");
    const deep = await composeCreative(input);
    // Kestrel's secondary #082F38 is deep (luminance < 0.05): the scrim is teal.
    expect(relativeLuminance(input.brand.palette.secondaryColor)).toBeLessThan(
      0.05,
    );
    expect(layer(deep, "scrim").color).toBe("#082F38");
    // Every text layer still meets QA's contrast over the tinted scrim.
    for (const record of deep.layers.filter((l) =>
      TEXT_KINDS.includes(l.kind as never),
    ))
      expect(
        backdropContrast(deep, record),
        record.kind,
      ).toBeGreaterThanOrEqual(required(record));
    // A lighter secondary leaves the dark text colour as the scrim ...
    const light = await composeCreative({
      ...input,
      brand: await kestrelWith({ secondaryColor: "#8C3B2C" }),
    });
    expect(layer(light, "scrim").color).toBe("#0B1F24");
    // ... and with light text too, the scrim is black.
    const neutral = await composeCreative({
      ...input,
      brand: await kestrelWith({
        secondaryColor: "#8C3B2C",
        textColor: "#E6E6E6",
      }),
    });
    expect(layer(neutral, "scrim").color).toBe("#000000");
  });

  it("rings a pill that hardly stands off its backdrop", async () => {
    // Kestrel's teal pill over its teal-tinted scrim: ringed in the lime accent.
    const kestrel = await composeCreative(await lifestyleInput("kestrel"));
    expect(kestrel.ctaStyleApplied).toBe("pill");
    expect(layer(kestrel, "cta").ring).toBe("#B5E655");
    // An accent too close to the pill colour: the ring takes the label colour.
    const input = await lifestyleInput("kestrel");
    const closeAccent = await composeCreative({
      ...input,
      brand: await kestrelWith({ accentColor: "#14596B" }),
    });
    const cta = layer(closeAccent, "cta");
    expect(contrastRatio("#14596B", "#0F4C5C")).toBeLessThan(3);
    expect(cta.ring).toBe(cta.color);
    // Lumora's coral pill on its cream brand field stands off: no ring.
    const lumora = await composeCreative({
      template: "tips",
      variant: "text_top",
      format: "square",
      brand: await demoBrand("lumora"),
      copy: COPY,
      options: OPTIONS,
    });
    expect(lumora.ctaStyleApplied).toBe("pill");
    expect(layer(lumora, "cta").ring).toBeUndefined();
  });

  it("crops band art by the aspect tolerance before containing it", async () => {
    // The tips band of the square format (2.9:1) with 3:2 art: off by 1.94.
    const art = await fixtureArt("good", "kestrel", {
      width: 1536,
      height: 1024,
    });
    const result = await composeCreative({
      template: "tips",
      variant: "text_top",
      format: "square",
      brand: await demoBrand("kestrel"),
      copy: COPY,
      art,
      options: OPTIONS,
    });
    const box = layoutFor("tips", "text_top", "square", OPTIONS).art!;
    expect(box.w / box.h / (1536 / 1024)).toBeGreaterThan(1.35);
    // Cropped to 1.35 × off from the box (centred), then contained: the art
    // is drawn box-high and (box aspect / 1.35)-wide.
    const cropHeight = Math.round(1536 / (box.w / box.h / 1.35));
    const drawnWidth = Math.round((box.h * 1536) / cropHeight);
    const record = layer(result, "art");
    expect(record.scale!).toBeCloseTo(drawnWidth / 1536, 2);
    // Containing the uncropped art would have drawn it only 3:2 wide.
    expect(record.scale!).toBeGreaterThan((box.h * 1.5) / 1536 + 0.05);
    // drawnArt shares the fit: the band shows exactly what QA judges.
    const drawn = await drawnArt(
      art,
      layoutFor("tips", "text_top", "square", OPTIONS),
    );
    const { default: sharp } = await import("sharp");
    const meta = await sharp(drawn).metadata();
    expect([meta.width, meta.height]).toEqual([box.w, box.h]);
  });
});

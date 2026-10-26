import { describe, expect, it } from "vitest";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  opaqueLogo,
} from "../fixtures/demo-brands.ts";
import type { CreativeBrand, RasterSource } from "./brand.ts";
import { contrastRatio, relativeLuminance } from "./color.ts";
import {
  composeCreative,
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

  it("keeps an opaque logo visible", async () => {
    const input = await lifestyleInput("lumora", "bright");
    const logo = await opaqueLogo();
    const result = await composeCreative({
      ...input,
      brand: { ...input.brand, logos: [{ ...logo, role: "primary" }] },
    });
    const drawn = layer(result, "logo");
    expect(drawn.sourceSha256).toBe(logo.sha256);
    expectAspectKept(drawn);
    const plate = result.layers.find((l) => l.kind === "logo_plate");
    const contrast = Math.min(
      contrastRatio(drawn.color!, result.backdrops.logo!.p10),
      contrastRatio(drawn.color!, result.backdrops.logo!.p90),
    );
    expect(plate !== undefined || contrast >= 2).toBe(true);
    if (plate) expect(inside(drawn.box, plate.box)).toBe(true);
  });

  it("puts a plate behind a dark transparent logo on dark art", async () => {
    const kestrel = await demoBrand("kestrel");
    const result = await composeCreative({
      template: "lifestyle",
      variant: "text_bottom",
      format: "feed_portrait",
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
    expect(
      inside(
        plate.box,
        layoutFor("lifestyle", "text_bottom", "feed_portrait", OPTIONS).logo
          .box,
      ),
    ).toBe(true);
    expect(
      Math.min(
        contrastRatio(logo.color!, result.backdrops.logo!.p10),
        contrastRatio(logo.color!, result.backdrops.logo!.p90),
      ),
    ).toBeGreaterThanOrEqual(2);
  });

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
    expect(result.backdrops.cta).toEqual({ p10: pill, p90: pill });
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
          const result = await composeCreative({
            template,
            variant: defaultVariant(template, format),
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
            if (TEXT_KINDS.includes(record.kind as never))
              expect(
                backdropContrast(result, record),
                `${brandName} ${template} ${record.kind}`,
              ).toBeGreaterThanOrEqual(required(record));
          }
          for (const [i, a] of placed.entries())
            for (const b of placed.slice(i + 1))
              expect(
                overlaps(a.box, b.box),
                `${template} ${a.kind}/${b.kind}`,
              ).toBe(false);
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

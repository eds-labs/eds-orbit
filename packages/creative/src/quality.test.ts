import { describe, expect, it } from "vitest";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  opaqueLogo,
  type DemoBrandName,
} from "../fixtures/demo-brands.ts";
import { sha256Hex, type CreativeLogo, type RasterSource } from "./brand.ts";
import { CREATIVE_THRESHOLDS } from "./analysis.ts";
import { relativeLuminance } from "./color.ts";
import {
  composeCreative,
  drawnArt,
  type ComposeResult,
  type LayerRecord,
} from "./compose.ts";
import {
  CREATIVE_TEMPLATE_IDS,
  type FormatId,
  type TemplateId,
  type VariantId,
} from "./ids.ts";
import {
  checkArt,
  checkComposition,
  failedBlockers,
  type CreativeCheck,
  type CreativeCheckCode,
} from "./quality.ts";
import {
  TEMPLATE_NEEDS,
  artZones,
  layoutFor,
  variantsFor,
  type LayoutSpec,
} from "./templates.ts";

const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
const TEXT_KINDS = ["eyebrow", "headline", "subline", "cta"] as const;

const failed = (checks: CreativeCheck[]) =>
  checks.filter((c) => !c.passed).map((c) => c.code);
const find = (checks: CreativeCheck[], code: CreativeCheckCode) => {
  const check = checks.find((c) => c.code === code);
  if (!check) throw new Error(`no ${code} check`);
  return check;
};

/** The approved hashes of a composition's inputs. */
function approvedOf(result: ComposeResult) {
  const of = (kind: LayerRecord["kind"]) =>
    result.layers.filter((l) => l.kind === kind).map((l) => l.sourceSha256!);
  return { logoSha256: of("logo"), productSha256: of("product") };
}

/** A copy of the result whose layers of one kind are changed by `change`. */
function withLayer(
  result: ComposeResult,
  kind: LayerRecord["kind"],
  change: (layer: LayerRecord) => LayerRecord,
): ComposeResult {
  return {
    ...result,
    layers: result.layers.map((l) => (l.kind === kind ? change(l) : l)),
  };
}

/** The default variant as the resolver picks it (R12, R16: a side variant first on landscape). */
function defaultVariant(template: TemplateId, format: FormatId) {
  const variants = variantsFor(template, format);
  if (
    format === "landscape" &&
    (TEMPLATE_NEEDS[template].product !== "none" || template === "lifestyle")
  ) {
    const side = variants.find((v) =>
      ["product_right", "product_left", "text_side"].includes(v),
    );
    if (side) return side;
  }
  return variants[0]!;
}

/** A creative with art, a screenshot (where the template has room) and the brand's logo. */
async function compose(
  brandName: DemoBrandName,
  template: TemplateId,
  format: FormatId = "feed_portrait",
  options: {
    logos?: CreativeLogo[];
    artBrand?: DemoBrandName;
    variant?: VariantId;
  } = {},
) {
  const art = await fixtureArt("good", options.artBrand ?? brandName);
  const variant = options.variant ?? defaultVariant(template, format);
  const brand = await demoBrand(brandName);
  const result = await composeCreative({
    template,
    variant,
    format,
    brand: options.logos ? { ...brand, logos: options.logos } : brand,
    copy: COPY,
    art,
    products:
      TEMPLATE_NEEDS[template].product === "none"
        ? undefined
        : [await fixtureScreenshot(brandName)],
    options: OPTIONS,
  });
  const layout = layoutFor(template, variant, format, OPTIONS);
  return { result, art, layout, variant };
}

/** Failed blockers of a creative: its composition and its drawn art. */
async function blockersOf({
  result,
  art,
  layout,
}: Awaited<ReturnType<typeof compose>>) {
  const checks = [
    ...checkComposition(result, approvedOf(result)),
    ...(await artChecks(art, layout)),
  ];
  return {
    blockers: failedBlockers(checks),
    detail: JSON.stringify(checks.filter((c) => !c.passed)),
  };
}

/** The lifestyle layout the art-only tests use. */
const LIFESTYLE = layoutFor(
  "lifestyle",
  "text_bottom",
  "feed_portrait",
  OPTIONS,
);

/** The art checks as the pipeline runs them: on the drawn art, with its zones (R21). */
async function artChecks(art: RasterSource, layout: LayoutSpec = LIFESTYLE) {
  return checkArt(await drawnArt(art, layout), artZones(layout));
}

/** The art with deterministic, roughly Gaussian noise of standard deviation `sigma` per channel. */
async function withNoise(
  art: RasterSource,
  sigma: number,
): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(art.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let seed = 12345;
  const uniform = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const noisy = Buffer.from(data);
  for (let i = 0; i < noisy.length; i++) {
    const gauss =
      (uniform() + uniform() + uniform() + uniform() - 2) * Math.sqrt(3);
    noisy[i] = Math.max(
      0,
      Math.min(255, Math.round(noisy[i]! + gauss * sigma)),
    );
  }
  const bytes = await sharp(noisy, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** The art re-encoded as JPEG. */
async function asJpeg(
  art: RasterSource,
  quality: number,
): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(art.bytes).jpeg({ quality }).toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** A PNG of the given size: a plain dark-blue field with optional SVG shapes on it. */
async function field(width: number, height: number, shapes = "") {
  const { default: sharp } = await import("sharp");
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="#20304A"/>${shapes}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/** 1024² art of vertical stripes, `period` px apart, in two colours. */
async function stripes(
  dark: string,
  light: string,
  period: number,
): Promise<RasterSource> {
  const bytes = await (
    await import("sharp")
  )
    .default(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
          <defs><pattern id="s" width="${period}" height="${period}" patternUnits="userSpaceOnUse">
            <rect width="${period / 2}" height="${period}" fill="${light}"/></pattern></defs>
          <rect width="1024" height="1024" fill="${dark}"/>
          <rect width="1024" height="1024" fill="url(#s)"/>
        </svg>`,
      ),
    )
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** A clean vector illustration without grain: a large glossy orb and a card on a dark gradient. */
async function vectorArt(): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B2A4A"/><stop offset="1" stop-color="#0E1424"/></linearGradient>
          <radialGradient id="orb" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#7FE3FF"/><stop offset="0.6" stop-color="#2B7BFF"/><stop offset="1" stop-color="#1A2F7A"/></radialGradient>
        </defs>
        <rect width="1024" height="1536" fill="url(#bg)"/>
        <circle cx="512" cy="560" r="330" fill="url(#orb)"/>
        <rect x="250" y="650" width="520" height="300" rx="46" fill="#E8EEFA"/>
        <rect x="300" y="720" width="260" height="30" rx="15" fill="#2B7BFF"/>
        <rect x="300" y="780" width="400" height="22" rx="11" fill="#9FB4E0"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

describe("checkArt", () => {
  it.each(["lumora", "kestrel"] as const)(
    "judges the motif, not the file or its grain (%s, R20)",
    async (brand) => {
      // The layouts whose verdicts flipped with JPEG in review 1.
      const layouts = (
        [
          "lifestyle",
          "product_showcase",
          "problem_solution",
          "brand_message",
        ] as const
      ).map(
        (template) =>
          [
            template,
            layoutFor(
              template,
              variantsFor(template, "feed_portrait")[0]!,
              "feed_portrait",
              OPTIONS,
            ),
          ] as const,
      );
      for (const kind of ["good", "tiny_subject", "flat"] as const) {
        const art = await fixtureArt(kind, brand);
        const variants = {
          jpeg70: await asJpeg(art, 70),
          native2048: await fixtureArt(kind, brand, {
            width: 2048,
            height: 2048,
          }),
          noise2: await withNoise(art, 2),
        };
        for (const [template, layout] of layouts) {
          const label = `${kind} ${template}`;
          const verdict = failed(await artChecks(art, layout));
          expect(verdict.length === 0, label).toBe(kind === "good");
          for (const [name, variant] of Object.entries(variants))
            expect(
              failed(await artChecks(variant, layout)),
              `${label} ${name}`,
            ).toEqual(verdict);
        }
      }
    },
    120_000,
  );

  it("passes a clean vector subject without grain (R20)", async () => {
    expect(failed(await artChecks(await vectorArt()))).toEqual([]);
  });

  it("fails flat art and a tiny subject even with noise (R20)", async () => {
    const flat = await withNoise(await fixtureArt("flat", "lumora"), 2);
    expect(failed(await artChecks(flat))).toContain("EMPTY_AREA_EXCESSIVE");
    const tiny = await withNoise(
      await fixtureArt("tiny_subject", "kestrel"),
      2,
    );
    expect(failed(await artChecks(tiny))).toContain("SUBJECT_TOO_SMALL");
  });

  it("skips decorative strips wider than 4:1 (R24)", async () => {
    // tips/centered on landscape draws its art into a 9:1 strip.
    const strip = layoutFor("tips", "centered", "landscape", OPTIONS);
    expect(strip.art!.w / strip.art!.h).toBeGreaterThan(4);
    for (const kind of ["good", "flat"] as const) {
      const checks = await artChecks(await fixtureArt(kind, "kestrel"), strip);
      expect(checks.map((c) => c.code).sort()).toEqual([
        "EMPTY_AREA_EXCESSIVE",
        "SUBJECT_TOO_SMALL",
      ]);
      for (const check of checks)
        expect(check, kind).toMatchObject({
          passed: true,
          detail: { skipped: "ART_STRIP" },
        });
    }
    // 5:1 and 1:5 strips are decorative; a 3:1 field is still judged.
    expect(failed(await checkArt(await field(1000, 200), []))).toEqual([]);
    expect(failed(await checkArt(await field(200, 1000), []))).toEqual([]);
    expect(failed(await checkArt(await field(900, 300), []))).toEqual([
      "SUBJECT_TOO_SMALL",
      "EMPTY_AREA_EXCESSIVE",
    ]);
  });

  it("counts every significant subject, not only the largest (R26)", async () => {
    // Two 400 px discs at opposite corners are one composition, not a small subject.
    const two = await checkArt(
      await field(
        1000,
        1000,
        `<circle cx="250" cy="250" r="200" fill="#E8B04C"/><circle cx="750" cy="750" r="200" fill="#7FE3FF"/>`,
      ),
      [],
    );
    expect(find(two, "SUBJECT_TOO_SMALL").passed).toBe(true);
    // A tiny subject and flat art still fail, with and without noise.
    for (const brand of ["lumora", "kestrel"] as const)
      for (const kind of ["tiny_subject", "flat"] as const) {
        const art = await fixtureArt(kind, brand);
        for (const variant of [art, await withNoise(art, 2)])
          expect(
            failed(await artChecks(variant)),
            `${brand} ${kind}`,
          ).toContain("SUBJECT_TOO_SMALL");
      }
  });

  it.each(["lumora", "kestrel"] as const)(
    "flags bad art (%s)",
    async (brand) => {
      const tiny = await artChecks(await fixtureArt("tiny_subject", brand));
      expect(failed(tiny)).toContain("SUBJECT_TOO_SMALL");
      expect(find(tiny, "SUBJECT_TOO_SMALL").severity).toBe("blocker");

      const flat = await artChecks(await fixtureArt("flat", brand));
      expect(failed(flat)).toContain("EMPTY_AREA_EXCESSIVE");
      expect(find(flat, "EMPTY_AREA_EXCESSIVE").severity).toBe("blocker");
      expect(failedBlockers(flat)).toContain("EMPTY_AREA_EXCESSIVE");

      const good = await artChecks(await fixtureArt("good", brand));
      expect(good.map((c) => c.code).sort()).toEqual([
        "EMPTY_AREA_EXCESSIVE",
        "SUBJECT_TOO_SMALL",
      ]);
      expect(failed(good)).toEqual([]);
    },
  );
});

describe("checkComposition", () => {
  it("passes a good composition", async () => {
    const { result } = await compose("lumora", "lifestyle");
    const checks = checkComposition(result, approvedOf(result));
    expect(failed(checks)).toEqual([]);
    expect(failedBlockers(checks)).toEqual([]);
    expect(checks.map((c) => c.code).sort()).toEqual(
      [
        "ASSET_UPSCALED",
        "CREATIVE_DIMENSIONS",
        "CREATIVE_FILE_TOO_LARGE",
        "LAYER_OVERLAP",
        "LOGO_CONTRAST_LOW",
        "LOGO_INTEGRITY",
        "SAFE_AREA_VIOLATION",
        "SCREENSHOT_INTEGRITY",
        "TEXT_BACKDROP_BUSY",
        "TEXT_CONTRAST_LOW",
      ].sort(),
    );
  });

  it("detects tampered or weak results", async () => {
    const { result } = await compose("kestrel", "feature_highlight");
    const approved = approvedOf(result);
    const blockers = (changed: ComposeResult) =>
      failedBlockers(checkComposition(changed, approved));
    expect(blockers(result)).toEqual([]);

    // Logo bytes that were not approved.
    expect(
      failedBlockers(
        checkComposition(result, { ...approved, logoSha256: ["0".repeat(64)] }),
      ),
    ).toEqual(["LOGO_INTEGRITY"]);
    // A screenshot that was not approved.
    expect(
      failedBlockers(
        checkComposition(result, {
          ...approved,
          productSha256: ["f".repeat(64)],
        }),
      ),
    ).toEqual(["SCREENSHOT_INTEGRITY"]);
    // A logo or screenshot whose aspect changed.
    expect(
      blockers(
        withLayer(result, "logo", (l) => ({
          ...l,
          box: { ...l.box, h: l.box.h + 6 },
        })),
      ),
    ).toContain("LOGO_INTEGRITY");
    expect(
      blockers(
        withLayer(result, "product", (l) => ({
          ...l,
          box: { ...l.box, w: l.box.w - 20 },
        })),
      ),
    ).toEqual(["SCREENSHOT_INTEGRITY"]);
    // A logo whose longer side is below the minimum (R19: 0.06 of the canvas's shorter side).
    expect(
      blockers(
        withLayer(result, "logo", (l) => {
          const w =
            Math.ceil(
              CREATIVE_THRESHOLDS.minLogoSideShare *
                Math.min(result.width, result.height),
            ) - 1;
          return {
            ...l,
            box: {
              ...l.box,
              w,
              h: Math.round((w * l.sourceSize!.height) / l.sourceSize!.width),
            },
          };
        }),
      ),
    ).toEqual(["LOGO_INTEGRITY"]);
    // Backdrops forced to the text colour.
    const textOnItself: ComposeResult = {
      ...result,
      backdrops: { ...result.backdrops },
    };
    for (const layer of result.layers)
      if (TEXT_KINDS.includes(layer.kind as never)) {
        const l = relativeLuminance(layer.color!);
        textOnItself.backdrops[layer.kind as (typeof TEXT_KINDS)[number]] = {
          p10: l,
          p90: l,
          busy: 0,
        };
      }
    expect(blockers(textOnItself)).toEqual(["TEXT_CONTRAST_LOW"]);
    // A busy backdrop behind the headline (R17).
    expect(
      blockers({
        ...result,
        backdrops: {
          ...result.backdrops,
          headline: {
            ...result.backdrops.headline!,
            busy: CREATIVE_THRESHOLDS.busyText + 0.01,
          },
        },
      }),
    ).toEqual(["TEXT_BACKDROP_BUSY"]);
    // The logo on a backdrop of its own colour.
    const ink = relativeLuminance(
      result.layers.find((l) => l.kind === "logo")!.color!,
    );
    expect(
      blockers({
        ...result,
        backdrops: { ...result.backdrops, logo: { p10: ink, p90: ink } },
      }),
    ).toEqual(["LOGO_CONTRAST_LOW"]);
    // A PNG over the size limit.
    const large = Buffer.concat([
      result.png,
      Buffer.alloc(CREATIVE_THRESHOLDS.maxFileBytes + 1 - result.png.length),
    ]);
    expect(large.length).toBe(CREATIVE_THRESHOLDS.maxFileBytes + 1);
    expect(blockers({ ...result, png: large })).toEqual([
      "CREATIVE_FILE_TOO_LARGE",
    ]);
    // Pixels of another size than the format.
    const { default: sharp } = await import("sharp");
    const small = await sharp(result.png).resize(540).png().toBuffer();
    expect(blockers({ ...result, png: small })).toEqual([
      "CREATIVE_DIMENSIONS",
    ]);
    expect(blockers({ ...result, png: Buffer.from("not a png") })).toContain(
      "CREATIVE_DIMENSIONS",
    );
    // A layer outside the safe area, and two layers on top of each other.
    expect(
      blockers(
        withLayer(result, "headline", (l) => ({
          ...l,
          box: { ...l.box, x: 10 },
        })),
      ),
    ).toContain("SAFE_AREA_VIOLATION");
    const product = result.layers.find((l) => l.kind === "product")!;
    expect(
      blockers(
        withLayer(result, "subline", (l) => ({
          ...l,
          box: { ...l.box, y: product.box.y + 4 },
        })),
      ),
    ).toEqual(["LAYER_OVERLAP"]);
    // No logo at all.
    expect(
      blockers({
        ...result,
        layers: result.layers.filter((l) => l.kind !== "logo"),
      }),
    ).toEqual(expect.arrayContaining(["LOGO_INTEGRITY", "LOGO_CONTRAST_LOW"]));
  });

  it("stops a busy-driven full tint at 0.6 behind centred text and reports the busy backdrop (R23)", async () => {
    // Dark stripes: white text reads on them at any scrim, so only busyness raises it.
    const result = await composeCreative({
      template: "brand_message",
      variant: "centered",
      format: "feed_portrait",
      brand: await demoBrand("kestrel"),
      copy: COPY,
      art: await stripes("#000000", "#404040", 16),
      options: OPTIONS,
    });
    expect(result.scrimOpacity).toBe(0.6);
    expect(failed(checkComposition(result, approvedOf(result)))).toEqual([
      "TEXT_BACKDROP_BUSY",
    ]);
  });

  it("still raises the scrim to the layout maximum for contrast (R23)", async () => {
    // A mid-grey text colour gives a mid-grey scrim: no text colour reaches
    // its contrast on black and white stripes, so contrast drives it to the cap.
    const lumora = await demoBrand("lumora");
    const result = await composeCreative({
      template: "brand_message",
      variant: "centered",
      format: "feed_portrait",
      brand: {
        ...lumora,
        palette: { ...lumora.palette, textColor: "#6B6B6B" },
      },
      copy: COPY,
      art: await stripes("#000000", "#FFFFFF", 128),
      options: OPTIONS,
    });
    expect(result.scrimOpacity).toBe(
      layoutFor("brand_message", "centered", "feed_portrait", OPTIONS).scrim!
        .max,
    );
  });

  it("warns on upscaled assets (Review Focus 4)", async () => {
    const brand = await demoBrand("kestrel");
    const small = await fixtureScreenshot("kestrel", {
      width: 400,
      height: 300,
    });
    const result = await composeCreative({
      template: "feature_highlight",
      variant: "text_top",
      format: "feed_portrait",
      brand,
      copy: COPY,
      products: [small],
      options: OPTIONS,
    });
    const product = result.layers.find((l) => l.kind === "product")!;
    expect(product.scale).toBeGreaterThan(CREATIVE_THRESHOLDS.maxUpscale);
    const checks = checkComposition(result, approvedOf(result));
    const upscaled = find(checks, "ASSET_UPSCALED");
    expect(upscaled.passed).toBe(false);
    expect(upscaled.severity).toBe("warning");
    expect(upscaled.detail).toMatchObject({ layer: "product" });
    expect(failed(checks)).toEqual(["ASSET_UPSCALED"]);
    expect(failedBlockers(checks)).toEqual([]);
  });

  it.each(["feed_portrait", "landscape"] as const)(
    "calibration: both demo brands pass every template (%s)",
    async (format) => {
      for (const brandName of ["lumora", "kestrel"] as const)
        for (const template of CREATIVE_TEMPLATE_IDS) {
          const creative = await compose(brandName, template, format);
          const { blockers, detail } = await blockersOf(creative);
          const label = `${brandName} ${template}: ${detail}`;
          if (
            creative.layout.scrim?.direction === "full" &&
            blockers.join() === "TEXT_BACKDROP_BUSY"
          ) {
            // R23: busy art under a full tint stops at 0.6; the correction is
            // another variant (R22), which must then pass.
            expect(creative.result.scrimOpacity, label).toBe(0.6);
            const next = variantsFor(template, format).find(
              (v) => v !== creative.variant,
            )!;
            const corrected = await blockersOf(
              await compose(brandName, template, format, { variant: next }),
            );
            expect(corrected.blockers, `${label} -> ${next}`).toEqual([]);
            continue;
          }
          expect(blockers, label).toEqual([]);
        }
    },
    120_000,
  );

  it("calibration: a square logo and a plated logo pass on landscape (R19)", async () => {
    const square = await opaqueLogo();
    const cases = [
      // A square logo in the corner under the product and in the side layout.
      await compose("lumora", "product_showcase", "landscape", {
        logos: [{ ...square, role: "primary" }],
      }),
      await compose("lumora", "lifestyle", "landscape", {
        logos: [{ ...square, role: "primary" }],
      }),
      // Kestrel's dark wordmark on Lumora's dark art gets a plate.
      await compose("kestrel", "lifestyle", "landscape", {
        artBrand: "lumora",
      }),
    ];
    expect(cases[2]!.result.layers.some((l) => l.kind === "logo_plate")).toBe(
      true,
    );
    for (const { result } of cases) {
      const logo = result.layers.find((l) => l.kind === "logo")!;
      expect(Math.max(logo.box.w, logo.box.h)).toBeGreaterThanOrEqual(
        CREATIVE_THRESHOLDS.minLogoSideShare * result.height,
      );
      expect(
        failedBlockers(checkComposition(result, approvedOf(result))),
      ).toEqual([]);
    }
  });
});

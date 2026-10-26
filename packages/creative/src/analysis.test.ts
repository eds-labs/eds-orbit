import { describe, expect, it } from "vitest";
import { fixtureArt } from "../fixtures/demo-brands.ts";
import {
  CREATIVE_THRESHOLDS,
  analyzeArt,
  contrastRatio,
  backdropBusyness,
  regionLuminance,
  relativeLuminance,
  requiredTextContrast,
} from "./analysis.ts";
import { drawnArt } from "./compose.ts";
import type { Raw } from "./raster.ts";
import { artZones, layoutFor } from "./templates.ts";

const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
/** The most common layout; art is measured as drawn into it (R21). */
const LIFESTYLE = layoutFor(
  "lifestyle",
  "text_bottom",
  "feed_portrait",
  OPTIONS,
);
const RESERVED = artZones(LIFESTYLE);

/** An opaque RGBA canvas whose pixel (x, y) is the grey value `grey(x, y)`. */
function canvasOf(
  width: number,
  height: number,
  grey: (x: number, y: number) => number,
): Raw {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.fill(grey(x, y), i, i + 3);
      data[i + 3] = 255;
    }
  return { data, width, height };
}

/** A PNG: white on the left half, black on the right half. */
async function twoTone(width: number, height: number) {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: { width, height, channels: 3, background: "#000000" },
  })
    .composite([
      {
        input: {
          create: {
            width: width / 2,
            height,
            channels: 3,
            background: "#FFFFFF",
          },
        },
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

describe("analysis", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    expect(
      Math.abs(contrastRatio("#777777", "#FFFFFF") - 4.48),
    ).toBeLessThanOrEqual(0.01);
    expect(relativeLuminance([255, 255, 255])).toBe(1);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("holds text to the contrast compose ensures (R2)", () => {
    const { bodyContrast, largeContrast, largeTextPx } = CREATIVE_THRESHOLDS;
    expect(requiredTextContrast("headline", largeTextPx)).toBe(largeContrast);
    expect(requiredTextContrast("headline", largeTextPx - 1)).toBe(
      bodyContrast,
    );
    expect(requiredTextContrast("eyebrow", 24)).toBe(bodyContrast);
    expect(requiredTextContrast("cta", 34)).toBe(largeContrast);
    // The subline is body text at every size.
    expect(requiredTextContrast("subline", 43)).toBe(bodyContrast);
  });

  it("measures the luminance of a region", async () => {
    const png = await twoTone(100, 50);
    expect(await regionLuminance(png, { x: 0, y: 0, w: 50, h: 50 })).toEqual({
      mean: 1,
      p10: 1,
      p90: 1,
    });
    const both = await regionLuminance(png, { x: 0, y: 0, w: 100, h: 50 });
    expect(both.p10).toBe(0);
    expect(both.p90).toBe(1);
    expect(both.mean).toBeCloseTo(0.5, 6);
    // Boxes are clipped to the canvas; a box with no pixel is refused.
    expect(
      (await regionLuminance(png, { x: 60, y: -20, w: 100, h: 100 })).p90,
    ).toBe(0);
    await expect(
      regionLuminance(png, { x: 100, y: 0, w: 10, h: 10 }),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_INPUT" });
    await expect(
      regionLuminance(Buffer.from("not a png"), { x: 0, y: 0, w: 1, h: 1 }),
    ).rejects.toMatchObject({ code: "RASTER_INPUT_INVALID" });
  });

  it("measures busyness at a fixed scale, which a scrim scales down", () => {
    const box = { x: 0, y: 0, w: 40, h: 40 };
    expect(
      backdropBusyness(
        canvasOf(40, 40, () => 128),
        box,
      ),
    ).toBe(0);
    // One-pixel stripes are grain at text scale: they average out.
    const grain = canvasOf(40, 40, (x) => (x % 2 ? 200 : 0));
    expect(backdropBusyness(grain, box)).toBe(0);
    // Eight-pixel stripes are structure a text crosses.
    const stripes = canvasOf(40, 40, (x) => (x % 8 < 4 ? 200 : 0));
    expect(backdropBusyness(stripes, box)).toBeGreaterThan(
      10 * CREATIVE_THRESHOLDS.busyText,
    );
    // A 50 % black scrim halves every difference, and so the busyness.
    const scrimmed = canvasOf(40, 40, (x) => (x % 8 < 4 ? 100 : 0));
    expect(backdropBusyness(scrimmed, box)).toBeCloseTo(
      backdropBusyness(stripes, box) / 2,
      9,
    );
    // Only the box counts.
    const half = canvasOf(40, 40, (x, y) =>
      y < 20 ? 128 : x % 8 < 4 ? 200 : 0,
    );
    expect(backdropBusyness(half, { x: 0, y: 0, w: 40, h: 20 })).toBe(0);
  });

  it.each(["lumora", "kestrel"] as const)(
    "measures subject coverage and flat share (%s)",
    async (brand) => {
      const { subjectMinCoverage, flatMaxShare } = CREATIVE_THRESHOLDS;
      const measure = async (kind: "good" | "tiny_subject" | "flat") =>
        analyzeArt(
          await drawnArt(await fixtureArt(kind, brand), LIFESTYLE),
          artZones(LIFESTYLE),
        );
      const good = await measure("good");
      expect(good.subjectCoverage).toBeGreaterThanOrEqual(subjectMinCoverage);
      expect(good.flatShare).toBeLessThanOrEqual(flatMaxShare);
      expect(good.meanDetail).toBeGreaterThan(CREATIVE_THRESHOLDS.flatRange);

      const tiny = await measure("tiny_subject");
      expect(tiny.subjectCoverage).toBeLessThan(subjectMinCoverage);

      const flat = await measure("flat");
      expect(flat.subjectCoverage).toBe(0);
      expect(flat.flatShare).toBeGreaterThan(flatMaxShare);
    },
  );

  it("finds a smooth subject by its colour and keeps the largest one", async () => {
    const { default: sharp } = await import("sharp");
    const art = (circles: string) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">
            <rect width="1000" height="1000" fill="#20304A"/>${circles}</svg>`,
        ),
      )
        .png()
        .toBuffer();
    // A plain disc 600 px across: its bounding box is 36 % of the art.
    const disc = await analyzeArt(
      await art(`<circle cx="500" cy="500" r="300" fill="#E8B04C"/>`),
      [],
    );
    expect(disc.subjectCoverage).toBeGreaterThan(0.34);
    expect(disc.subjectCoverage).toBeLessThan(0.42);
    // A small second shape far away does not stretch the subject's box.
    const two = await analyzeArt(
      await art(
        `<circle cx="500" cy="500" r="300" fill="#E8B04C"/><circle cx="930" cy="930" r="40" fill="#E8B04C"/>`,
      ),
      [],
    );
    expect(two.subjectCoverage).toBeCloseTo(disc.subjectCoverage, 6);
    // The plain field around it is the empty area.
    expect(disc.flatShare).toBeGreaterThan(0.55);
  });

  it("counts flat cells only outside the reserved zones", async () => {
    const flat = (await fixtureArt("flat", "kestrel")).bytes;
    expect((await analyzeArt(flat, [])).flatShare).toBe(1);
    // Nothing left outside: no empty area to count.
    expect(
      (await analyzeArt(flat, [{ x: 0, y: 0, w: 1, h: 1 }])).flatShare,
    ).toBe(0);
    // The share is of the whole art: half of it reserved leaves half empty.
    expect(
      (await analyzeArt(flat, [{ x: 0, y: 0, w: 1, h: 0.5 }])).flatShare,
    ).toBeCloseTo(0.5, 6);
  });

  it("measures art independent of its file resolution", async () => {
    const { default: sharp } = await import("sharp");
    const good = (await fixtureArt("good", "kestrel")).bytes;
    // The same picture as a 4× larger, softer file reads the same.
    const large = await sharp(good).resize(4096, 4096).png().toBuffer();
    const original = await analyzeArt(good, RESERVED);
    const upscaled = await analyzeArt(large, RESERVED);
    expect(upscaled.subjectCoverage).toBeGreaterThanOrEqual(
      CREATIVE_THRESHOLDS.subjectMinCoverage,
    );
    expect(upscaled.flatShare).toBeLessThanOrEqual(
      CREATIVE_THRESHOLDS.flatMaxShare,
    );
    expect(upscaled.meanDetail).toBeGreaterThan(0.5 * original.meanDetail);
  });
});

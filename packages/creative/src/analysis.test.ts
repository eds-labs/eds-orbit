import { describe, expect, it } from "vitest";
import { fixtureArt } from "../fixtures/demo-brands.ts";
import {
  CREATIVE_THRESHOLDS,
  analyzeArt,
  contrastRatio,
  detailEnergy,
  regionLuminance,
  relativeLuminance,
  requiredTextContrast,
} from "./analysis.ts";
import type { Raw } from "./raster.ts";
import { layoutFor } from "./templates.ts";

const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
/** Text and logo zones of the most common layout, as the pipeline passes them. */
const RESERVED = layoutFor(
  "lifestyle",
  "text_bottom",
  "feed_portrait",
  OPTIONS,
).reservedZones;

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

  it("measures detail energy, which a scrim scales down", () => {
    const box = { x: 0, y: 0, w: 40, h: 40 };
    expect(
      detailEnergy(
        canvasOf(40, 40, () => 128),
        box,
      ),
    ).toBe(0);
    // One-pixel stripes 0/200: every pixel has |Laplacian| 400.
    const stripes = canvasOf(40, 40, (x) => (x % 2 ? 200 : 0));
    expect(detailEnergy(stripes, { x: 1, y: 1, w: 38, h: 38 })).toBeCloseTo(
      400 / 255,
      6,
    );
    // A 50 % black scrim halves every difference, and so the energy.
    const scrimmed = canvasOf(40, 40, (x) => (x % 2 ? 100 : 0));
    expect(detailEnergy(scrimmed, box)).toBeCloseTo(
      detailEnergy(stripes, box) / 2,
      6,
    );
    // Only the box counts.
    const half = canvasOf(40, 40, (x, y) => (y < 20 ? 128 : x % 2 ? 200 : 0));
    expect(detailEnergy(half, { x: 0, y: 0, w: 40, h: 19 })).toBe(0);
  });

  it.each(["lumora", "kestrel"] as const)(
    "measures subject coverage and flat share (%s)",
    async (brand) => {
      const { subjectMinCoverage, flatMaxShare } = CREATIVE_THRESHOLDS;
      const good = await analyzeArt(
        (await fixtureArt("good", brand)).bytes,
        RESERVED,
      );
      expect(good.subjectCoverage).toBeGreaterThanOrEqual(subjectMinCoverage);
      expect(good.flatShare).toBeLessThanOrEqual(flatMaxShare);
      expect(good.meanDetail).toBeGreaterThan(CREATIVE_THRESHOLDS.flatCell);

      const tiny = await analyzeArt(
        (await fixtureArt("tiny_subject", brand)).bytes,
        RESERVED,
      );
      expect(tiny.subjectCoverage).toBeLessThan(subjectMinCoverage);

      const flat = await analyzeArt(
        (await fixtureArt("flat", brand)).bytes,
        RESERVED,
      );
      expect(flat.flatShare).toBeGreaterThan(flatMaxShare);
    },
  );

  it("counts flat cells only outside the reserved zones", async () => {
    const flat = (await fixtureArt("flat", "kestrel")).bytes;
    expect((await analyzeArt(flat, [])).flatShare).toBe(1);
    // Nothing left outside: no empty area to count.
    expect(
      (await analyzeArt(flat, [{ x: 0, y: 0, w: 1, h: 1 }])).flatShare,
    ).toBe(0);
  });

  it("measures art at display scale, not at its file resolution", async () => {
    const { default: sharp } = await import("sharp");
    const good = (await fixtureArt("good", "kestrel")).bytes;
    // The same picture as a 4× larger file is just as detailed on the canvas.
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

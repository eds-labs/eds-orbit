import { describe, expect, it } from "vitest";
import { demoBrand, opaqueLogo } from "../fixtures/demo-brands.ts";
import { CREATIVE_THRESHOLDS, backdropBusyness } from "./analysis.ts";
import { sha256Hex, type CreativeBrand, type RasterSource } from "./brand.ts";
import { relativeLuminance } from "./color.ts";
import { placeLogo } from "./logo.ts";
import { svgImage, worstContrast, type Raw } from "./raster.ts";
import { layoutFor } from "./templates.ts";

// The plate behind a transparent logo (spec §9): drawn when no variant reaches
// QA's 2:1, and also when the chosen one stays below 3:1 or sits on a busy
// backdrop, as long as the plate improves the logo's contrast.

const LAYOUT = layoutFor("lifestyle", "text_bottom", "feed_portrait", {
  logoPlacement: "auto",
  textScale: "m",
});
const { width: W, height: H } = LAYOUT.format;

async function sharpLib() {
  return (await import("sharp")).default;
}

/** An opaque RGBA canvas drawn from an SVG body. */
async function canvas(body: string): Promise<Raw> {
  const sharp = await sharpLib();
  const { data, info } = await sharp(svgImage(W, H, body))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** A flat field of one colour. */
const flat = (color: string) =>
  canvas(`<rect width="${W}" height="${H}" fill="${color}"/>`);

/** Vertical 8 px stripes of two colours: busy at the 4 px cell scale. */
const stripes = (a: string, b: string) =>
  canvas(
    `<defs><pattern id="s" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="8" height="16" fill="${a}"/><rect x="8" width="8" height="16" fill="${b}"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#s)"/>`,
  );

/** A transparent logo drawn in one colour. */
async function inkLogo(color: string): Promise<RasterSource> {
  const sharp = await sharpLib();
  const bytes = await sharp(
    svgImage(
      400,
      160,
      `<rect x="10" y="30" width="380" height="100" rx="20" fill="${color}"/>`,
    ),
  )
    .png()
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

async function brandWith(logo: RasterSource): Promise<CreativeBrand> {
  const brand = await demoBrand("kestrel");
  return { ...brand, logos: [{ ...logo, role: "primary" }] };
}

async function place(on: Raw, logo: RasterSource) {
  return placeLogo(
    await sharpLib(),
    on,
    LAYOUT,
    await brandWith(logo),
    undefined,
  );
}

describe("placeLogo", () => {
  it("plates a logo that passes QA but sits on a busy backdrop", async () => {
    const backdrop = await stripes("#E0E0E0", "#A0A0A0");
    expect(backdropBusyness(backdrop, LAYOUT.logo.box)).toBeGreaterThan(
      CREATIVE_THRESHOLDS.busyLogo,
    );
    const logo = await inkLogo("#555555");
    const unplated = worstContrast("#555555", {
      p10: relativeLuminance("#A0A0A0"),
      p90: relativeLuminance("#E0E0E0"),
    });
    // Passing QA (2:1) but below the comfort level on its own.
    expect(unplated).toBeGreaterThanOrEqual(CREATIVE_THRESHOLDS.logoContrast);
    const result = await place(backdrop, logo);
    expect(result.plate).not.toBeNull();
    expect(worstContrast(result.placed.color, result.backdrop)).toBeGreaterThan(
      unplated,
    );
  });

  it("plates a well-contrasted logo on a busy backdrop", async () => {
    const result = await place(
      await stripes("#E0E0E0", "#A0A0A0"),
      await inkLogo("#111111"),
    );
    expect(result.plate).not.toBeNull();
  });

  it("plates a logo below 3:1 on a calm backdrop", async () => {
    const backdrop = await flat("#A0A0A0");
    expect(backdropBusyness(backdrop, LAYOUT.logo.box)).toBeLessThan(1e-6);
    const contrast = worstContrast("#FFFFFF", {
      p10: relativeLuminance("#A0A0A0"),
      p90: relativeLuminance("#A0A0A0"),
    });
    expect(contrast).toBeGreaterThanOrEqual(2);
    expect(contrast).toBeLessThan(3);
    const result = await place(backdrop, await inkLogo("#FFFFFF"));
    expect(result.plate).not.toBeNull();
    expect(
      worstContrast(result.placed.color, result.backdrop),
    ).toBeGreaterThanOrEqual(3);
  });

  it("draws no plate for a logo of at least 3:1 on a calm backdrop", async () => {
    const result = await place(await flat("#F0F0F0"), await inkLogo("#222222"));
    expect(result.plate).toBeNull();
    expect(
      worstContrast(result.placed.color, result.backdrop),
    ).toBeGreaterThanOrEqual(3);
  });

  it("never plates a logo with its own opaque backing, even on a busy backdrop", async () => {
    const result = await place(
      await stripes("#E0E0E0", "#303030"),
      await opaqueLogo(),
    );
    expect(result.plate).toBeNull();
  });
});

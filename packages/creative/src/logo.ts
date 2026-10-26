import type { CreativeBrand, CreativeLogo } from "./brand.ts";
import { contrastRatio, relativeLuminance } from "./color.ts";
import type { LogoRole } from "./ids.ts";
import {
  flatten,
  luminanceStats,
  openRaster,
  svgImage,
  toHex,
  worstContrast,
  type Raw,
  type Sharp,
} from "./raster.ts";
import type { Box, LayoutSpec } from "./templates.ts";

// The approved logo: variant choice by backdrop, proportional scaling into its
// anchor, and a plate behind it when no variant is visible on its own.

const LOGO_CONTRAST = 2;
/** Mean luminance below which the logo backdrop counts as dark. */
const DARK_BACKDROP = 0.4;
const PLATE_OPACITY = 0.9;
const AUTO_ROLES: readonly LogoRole[] = ["onDark", "onLight", "primary"];

type PlacedLogo = {
  logo: CreativeLogo;
  png: Buffer;
  box: Box;
  color: string;
  sourceSize: { width: number; height: number };
};

/** Scales a logo into the anchor box (less `inset` per side), aligned to the anchor's corner. */
async function fitLogo(
  sharp: Sharp,
  logo: CreativeLogo,
  layout: LayoutSpec,
  inset: number,
): Promise<PlacedLogo> {
  const { box: anchor, corner } = layout.logo;
  const { width = 0, height = 0 } = await openRaster(
    sharp,
    logo.bytes,
  ).metadata();
  const scaled = await openRaster(sharp, logo.bytes)
    .resize(anchor.w - 2 * inset, anchor.h - 2 * inset, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = scaled.info;
  const png = await sharp(scaled.data, {
    raw: { width: w, height: h, channels: 4 },
  })
    .png()
    .toBuffer();
  return {
    logo,
    png,
    box: {
      x: corner.endsWith("left")
        ? anchor.x + inset
        : anchor.x + anchor.w - inset - w,
      y: corner.startsWith("top")
        ? anchor.y + inset
        : anchor.y + anchor.h - inset - h,
      w,
      h,
    },
    color: inkColor(scaled.data),
    sourceSize: { width, height },
  };
}

/**
 * The logo's representative ink: the pixel at the alpha-weighted median
 * luminance. Half the logo is at least as light and half at least as dark, so
 * its contrast stands for most of the logo, not for one bright detail.
 */
function inkColor(rgba: Buffer) {
  const pixels: { l: number; a: number; i: number }[] = [];
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (!a) continue;
    pixels.push({
      l: relativeLuminance([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]),
      a,
      i,
    });
    total += a;
  }
  pixels.sort((p, q) => p.l - q.l || p.i - q.i);
  let seen = 0;
  for (const { a, i } of pixels) {
    seen += a;
    if (seen >= total / 2) return toHex([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
  }
  return "#000000";
}

/**
 * Chooses the logo variant by the luminance behind the anchor (or the forced
 * role) and keeps it visible: another variant when that reads better, else a
 * surface-coloured plate behind the unchanged logo.
 */
export async function placeLogo(
  sharp: Sharp,
  canvas: Raw,
  layout: LayoutSpec,
  brand: CreativeBrand,
  forced: LogoRole | undefined,
) {
  const byRole = new Map<LogoRole, CreativeLogo>();
  for (const logo of brand.logos)
    if (!byRole.has(logo.role)) byRole.set(logo.role, logo);
  const contrastOf = (placed: PlacedLogo, on: Raw) => {
    const { p10, p90 } = luminanceStats(on, placed.box);
    return {
      backdrop: { p10, p90 },
      contrast: worstContrast(placed.color, { p10, p90 }),
    };
  };

  const dark = luminanceStats(canvas, layout.logo.box).mean < DARK_BACKDROP;
  const preference: LogoRole[] = forced
    ? [forced]
    : [dark ? "onDark" : "onLight", "primary", ...AUTO_ROLES];
  const roles = [...new Set(preference)].filter((role) => byRole.has(role));
  const options = await Promise.all(
    roles.map((role) => fitLogo(sharp, byRole.get(role)!, layout, 0)),
  );
  const scored = options.map((placed) => ({
    placed,
    ...contrastOf(placed, canvas),
  }));
  const choice =
    scored[0]!.contrast >= LOGO_CONTRAST
      ? scored[0]!
      : scored.reduce((a, b) => (b.contrast > a.contrast ? b : a));
  if (choice.contrast >= LOGO_CONTRAST)
    return {
      placed: choice.placed,
      backdrop: choice.backdrop,
      canvas,
      plate: null,
    };

  // No variant reads on this backdrop: put the variant that reads best on the surface on a plate.
  const surface = brand.palette.surfaceColor;
  const inset = Math.round(0.012 * layout.format.width);
  const onSurface = options.reduce((a, b) =>
    contrastRatio(b.color, surface) > contrastRatio(a.color, surface) ? b : a,
  );
  const placed = await fitLogo(sharp, onSurface.logo, layout, inset);
  const plate = {
    x: placed.box.x - inset,
    y: placed.box.y - inset,
    w: placed.box.w + 2 * inset,
    h: placed.box.h + 2 * inset,
  };
  const radius = Math.min(
    Math.round(plate.h / 2),
    Math.round(0.015 * layout.format.width),
  );
  const plated = await flatten(sharp, canvas, [
    {
      input: svgImage(
        layout.format.width,
        layout.format.height,
        `<rect x="${plate.x}" y="${plate.y}" width="${plate.w}" height="${plate.h}" rx="${radius}" fill="${surface}" fill-opacity="${PLATE_OPACITY}"/>`,
      ),
      left: 0,
      top: 0,
    },
  ]);
  return {
    placed,
    backdrop: contrastOf(placed, plated).backdrop,
    canvas: plated,
    plate,
  };
}

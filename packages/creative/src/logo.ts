import { CREATIVE_THRESHOLDS } from "./analysis.ts";
import type { CreativeBrand, CreativeLogo } from "./brand.ts";
import { contrastRatio, parseHex, relativeLuminance } from "./color.ts";
import type { LogoRole } from "./ids.ts";
import {
  flatten,
  luminanceStats,
  openRaster,
  svgImage,
  toHex,
  worstContrast,
  type Backdrop,
  type Raw,
  type Sharp,
} from "./raster.ts";
import type { Box, LayoutSpec } from "./templates.ts";

// The approved logo: variant choice by backdrop, proportional scaling into its
// anchor, and a plate behind it when no variant is visible on its own.

/** QA's logo contrast requirement (spec §9). */
const LOGO_CONTRAST = CREATIVE_THRESHOLDS.logoContrast;
/** Mean luminance below which the logo backdrop counts as dark. */
const DARK_BACKDROP = 0.4;
const PLATE_OPACITY = 0.9;
const AUTO_ROLES: readonly LogoRole[] = ["onDark", "onLight", "primary"];

/** Alpha from which an edge pixel counts as opaque. */
const OPAQUE_ALPHA = 250;
/** Largest channel difference at which a pixel still counts as the logo's own background. */
const BACKING_TOLERANCE = 48;

type PlacedLogo = {
  logo: CreativeLogo;
  png: Buffer;
  box: Box;
  /** Representative ink colour (see `inkColor`). */
  color: string;
  /**
   * The colour of the logo's own opaque background (every edge pixel opaque,
   * e.g. a mark on a white square), or `null` for a transparent logo. Such a
   * logo is its own backdrop: it is never plated.
   */
  backing: string | null;
  sourceSize: { width: number; height: number };
};

/** Where the logo ended up, what lies behind it, and the plate drawn for it (if any). */
type LogoLayers = {
  placed: PlacedLogo;
  backdrop: Backdrop;
  canvas: Raw;
  plate: { box: Box; color: string } | null;
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
    ...inked(scaled.data, w, h),
    sourceSize: { width, height },
  };
}

/** The logo's own background colour (per-channel median of its edge), or `null` when any edge pixel is see-through. */
function backingColor(rgba: Buffer, w: number, h: number) {
  const edge: number[][] = [[], [], []];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (y !== 0 && y !== h - 1 && x !== 0 && x !== w - 1) continue;
      const i = (y * w + x) * 4;
      if (rgba[i + 3]! < OPAQUE_ALPHA) return null;
      for (let c = 0; c < 3; c++) edge[c]!.push(rgba[i + c]!);
    }
  return toHex(
    edge.map((values) => values.sort((a, b) => a - b)[values.length >> 1]!),
  );
}

/** Ink and backing of a scaled logo; on an opaque logo the ink is taken from the mark only. */
function inked(rgba: Buffer, w: number, h: number) {
  const backing = backingColor(rgba, w, h);
  if (!backing)
    return { color: inkColor(rgba, () => true) ?? "#000000", backing };
  const [r, g, b] = parseHex(backing);
  const mark = (i: number) =>
    Math.max(
      Math.abs(rgba[i]! - r),
      Math.abs(rgba[i + 1]! - g),
      Math.abs(rgba[i + 2]! - b),
    ) > BACKING_TOLERANCE;
  return { color: inkColor(rgba, mark) ?? backing, backing };
}

/**
 * The logo's representative ink: among the pixels `counts` accepts, the one at
 * the alpha-weighted median luminance. Half the logo is at least as light and
 * half at least as dark, so its contrast stands for most of the logo, not for
 * one bright detail. `null` when no pixel counts.
 */
function inkColor(rgba: Buffer, counts: (index: number) => boolean) {
  const pixels: { l: number; a: number; i: number }[] = [];
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (!a || !counts(i)) continue;
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
  return null;
}

/**
 * Chooses the logo variant by the luminance behind the anchor (or the forced
 * role) and keeps it visible: another variant when that reads better, else a
 * plate behind the unchanged logo. A logo with its own opaque background is
 * its own backdrop and is never plated. The plate is surface-coloured first;
 * when the logo still does not reach `LOGO_CONTRAST` on it, the text colour,
 * white and black are tried, and the best plate is kept.
 */
export async function placeLogo(
  sharp: Sharp,
  canvas: Raw,
  layout: LayoutSpec,
  brand: CreativeBrand,
  forced: LogoRole | undefined,
): Promise<LogoLayers> {
  const byRole = new Map<LogoRole, CreativeLogo>();
  for (const logo of brand.logos)
    if (!byRole.has(logo.role)) byRole.set(logo.role, logo);
  const contrastOf = (placed: PlacedLogo, on: Raw) => {
    if (placed.backing) {
      const l = relativeLuminance(placed.backing);
      return {
        backdrop: { p10: l, p90: l },
        contrast: contrastRatio(placed.color, placed.backing),
      };
    }
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
  const plateable = options.filter((placed) => !placed.backing);
  if (choice.contrast >= LOGO_CONTRAST || !plateable.length)
    return {
      placed: choice.placed,
      backdrop: choice.backdrop,
      canvas,
      plate: null,
    };

  // No variant reads on this backdrop: put the variant that reads best on the plate on a plate.
  const inset = Math.round(0.012 * layout.format.width);
  const insetLogos = new Map<CreativeLogo, Promise<PlacedLogo>>();
  const colors = [
    brand.palette.surfaceColor,
    brand.palette.textColor,
    "#FFFFFF",
    "#000000",
  ];
  let best: (LogoLayers & { contrast: number }) | null = null;
  for (const [index, color] of colors.entries()) {
    if (
      colors
        .slice(0, index)
        .some((c) => c.toUpperCase() === color.toUpperCase())
    )
      continue;
    const option = plateable.reduce((a, b) =>
      contrastRatio(b.color, color) > contrastRatio(a.color, color) ? b : a,
    );
    if (!insetLogos.has(option.logo))
      insetLogos.set(option.logo, fitLogo(sharp, option.logo, layout, inset));
    const placed = await insetLogos.get(option.logo)!;
    const box = {
      x: placed.box.x - inset,
      y: placed.box.y - inset,
      w: placed.box.w + 2 * inset,
      h: placed.box.h + 2 * inset,
    };
    const radius = Math.min(
      Math.round(box.h / 2),
      Math.round(0.015 * layout.format.width),
    );
    const plated = await flatten(sharp, canvas, [
      {
        input: svgImage(
          layout.format.width,
          layout.format.height,
          `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${radius}" fill="${color}" fill-opacity="${PLATE_OPACITY}"/>`,
        ),
        left: 0,
        top: 0,
      },
    ]);
    const attempt = {
      placed,
      ...contrastOf(placed, plated),
      canvas: plated,
      plate: { box, color },
    };
    if (attempt.contrast >= LOGO_CONTRAST) return attempt;
    if (!best || attempt.contrast > best.contrast) best = attempt;
  }
  return best!;
}

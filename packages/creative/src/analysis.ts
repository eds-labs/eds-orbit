import { CreativeError } from "./errors.ts";
import { luminanceStats, openRaster, type Raw } from "./raster.ts";
import type { Box, RelBox, TextLayerKind } from "./templates.ts";

// Deterministic, cheap image measures for creative QA (spec §6 "Analysis"):
// luminance of a region, a detail map of the art, and the detail energy
// (busyness) behind text. Detail is the mean absolute Laplacian of the grey
// value divided by 255, so 0 is a flat field.

export { contrastRatio, relativeLuminance } from "./color.ts";

/** Thresholds of the deterministic checks (spec §9), calibrated on the demo brands' fixtures. */
export const CREATIVE_THRESHOLDS = {
  /** WCAG contrast of body text, and of large text from `largeTextPx`. */
  bodyContrast: 4.5,
  largeContrast: 3,
  largeTextPx: 32,
  logoContrast: 2,
  /** Share of the art the bounding box of high-detail cells must cover. */
  subjectMinCoverage: 0.25,
  /** Largest share of flat cells outside the reserved zones. */
  flatMaxShare: 0.45,
  maxFileBytes: 8_388_608,
  /** Smallest drawn logo width, as a share of the canvas width. */
  minLogoWidthShare: 0.06,
  /** Largest scale of a raster layer before it counts as upscaled. */
  maxUpscale: 1.5,
  /** Detail above which a cell counts as subject (`detailCell`) or below which as flat (`flatCell`). */
  detailCell: 0.08,
  flatCell: 0.02,
  /** Cells per side of the art's detail grid. */
  grid: 16,
  /** Largest detail energy behind a text layer (R17). */
  busyText: 0.06,
} as const;

/**
 * Art is measured at about the size it is drawn: a file whose shorter side is
 * larger than the tall formats' canvas width is scaled down to it first, so a
 * high-resolution upload does not read as flat.
 */
const ANALYSIS_SIDE = 1080;

/**
 * The contrast a text layer must reach (spec §9, R2): large text from
 * `largeTextPx`, body text below; the subline counts as body text at every
 * size. Compose colours text against the same rule.
 */
export const requiredTextContrast = (kind: TextLayerKind, fontSize: number) =>
  kind !== "subline" && fontSize >= CREATIVE_THRESHOLDS.largeTextPx
    ? CREATIVE_THRESHOLDS.largeContrast
    : CREATIVE_THRESHOLDS.bodyContrast;

/** Decodes raster bytes into an opaque sRGB canvas, optionally scaled down to `shorterSide`. */
async function decode(bytes: Buffer, shorterSide?: number): Promise<Raw> {
  const { default: sharp } = await import("sharp");
  try {
    let image = openRaster(sharp, bytes);
    if (shorterSide)
      image = image.resize({
        width: shorterSide,
        height: shorterSide,
        fit: "outside",
        withoutEnlargement: true,
      });
    const { data, info } = await image
      .flatten()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new CreativeError("RASTER_INPUT_INVALID");
  }
}

/** The whole-pixel part of `box` on the canvas; a box without a pixel there is invalid. */
function clip(canvas: Raw, box: Box): Box {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width, Math.round(box.x + box.w)) - x;
  const h = Math.min(canvas.height, Math.round(box.y + box.h)) - y;
  if (!(w > 0 && h > 0)) throw new CreativeError("INVALID_TEMPLATE_INPUT");
  return { x, y, w, h };
}

/**
 * Detail per cell of a `cells`×`cells` grid over `box` (a clipped box): the
 * mean absolute 4-neighbour Laplacian (canvas edges repeated) of the grey
 * value, which weighs the encoded sRGB channels with the Rec. 709
 * coefficients, divided by 255. Integer arithmetic keeps it exact.
 */
function detailGrid(canvas: Raw, box: Box, cells: number): Float64Array {
  const { data, width: W, height: H } = canvas;
  const grey = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return 2126 * data[i]! + 7152 * data[i + 1]! + 722 * data[i + 2]!;
  };
  const sums = new Float64Array(cells * cells);
  const counts = new Float64Array(cells * cells);
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = Math.floor(((y - box.y) * cells) / box.h) * cells;
    const up = Math.max(0, y - 1);
    const down = Math.min(H - 1, y + 1);
    for (let x = box.x; x < box.x + box.w; x++) {
      const laplacian =
        grey(Math.max(0, x - 1), y) +
        grey(Math.min(W - 1, x + 1), y) +
        grey(x, up) +
        grey(x, down) -
        4 * grey(x, y);
      const cell = row + Math.floor(((x - box.x) * cells) / box.w);
      sums[cell]! += Math.abs(laplacian);
      counts[cell]!++;
    }
  }
  // The grey weights sum to 10 000.
  return sums.map((sum, i) =>
    counts[i] ? sum / counts[i]! / 10_000 / 255 : 0,
  );
}

/**
 * Detail energy of the canvas inside `box`: how busy what lies behind a layer
 * is (0 for a flat field). A scrim of opacity `a` scales it by `1 − a`.
 */
export function detailEnergy(canvas: Raw, box: Box): number {
  return detailGrid(canvas, clip(canvas, box), 1)[0]!;
}

/** Mean and p10/p90 of the relative luminance inside `box` (clipped to the image). */
export async function regionLuminance(
  png: Buffer,
  box: Box,
): Promise<{ mean: number; p10: number; p90: number }> {
  const canvas = await decode(png);
  return luminanceStats(canvas, clip(canvas, box));
}

/**
 * Detail map of an art on a `grid`×`grid` grid:
 * - `subjectCoverage`: area of the bounding box of the cells above
 *   `detailCell`, as a share of the art;
 * - `flatShare`: cells below `flatCell` among the cells whose centre lies
 *   outside every reserved zone (fractions of the art), 0 when none does;
 * - `meanDetail`: the mean detail of all cells.
 */
export async function analyzeArt(
  png: Buffer,
  reserved: RelBox[],
): Promise<{ subjectCoverage: number; flatShare: number; meanDetail: number }> {
  const { grid, detailCell, flatCell } = CREATIVE_THRESHOLDS;
  const canvas = await decode(png, ANALYSIS_SIDE);
  const cells = detailGrid(
    canvas,
    { x: 0, y: 0, w: canvas.width, h: canvas.height },
    grid,
  );
  // Bounding box of the subject cells, in cells.
  let left: number = grid;
  let top: number = grid;
  let right = -1;
  let bottom = -1;
  let open = 0;
  let flat = 0;
  let total = 0;
  for (let row = 0; row < grid; row++)
    for (let col = 0; col < grid; col++) {
      const detail = cells[row * grid + col]!;
      total += detail;
      if (detail > detailCell) {
        left = Math.min(left, col);
        right = Math.max(right, col);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
      }
      const cx = (col + 0.5) / grid;
      const cy = (row + 0.5) / grid;
      if (
        reserved.some(
          (zone) =>
            cx >= zone.x &&
            cx < zone.x + zone.w &&
            cy >= zone.y &&
            cy < zone.y + zone.h,
        )
      )
        continue;
      open++;
      if (detail < flatCell) flat++;
    }
  return {
    subjectCoverage:
      right < 0 ? 0 : ((right - left + 1) * (bottom - top + 1)) / grid ** 2,
    flatShare: open ? flat / open : 0,
    meanDetail: total / grid ** 2,
  };
}

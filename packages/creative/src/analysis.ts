import { CreativeError } from "./errors.ts";
import { luminanceStats, openRaster, type Raw } from "./raster.ts";
import type { Box, RelBox, TextLayerKind } from "./templates.ts";

// Deterministic, cheap image measures for creative QA (spec §6 "Analysis"):
// luminance of a region, the subject and empty area of an art, and how busy
// the backdrop behind text is. Art and backdrops are judged on coarse grids
// of area-averaged cells, so they measure the motif and its structure, not
// grain, JPEG artefacts or the file's resolution (R20).

export { contrastRatio, relativeLuminance } from "./color.ts";

/** Thresholds of the deterministic checks (spec §9), calibrated on the demo brands' fixtures. */
export const CREATIVE_THRESHOLDS = {
  /** WCAG contrast of body text, and of large text from `largeTextPx`. */
  bodyContrast: 4.5,
  largeContrast: 3,
  largeTextPx: 32,
  logoContrast: 2,
  /** Share of the art the bounding box of the subject must cover. */
  subjectMinCoverage: 0.25,
  /** Largest share of the art that is flat and outside the reserved zones. */
  flatMaxShare: 0.45,
  maxFileBytes: 8_388_608,
  /** Smallest longer side of the drawn logo, as a share of the canvas's shorter side (R19). */
  minLogoSideShare: 0.06,
  /** Largest scale of a raster layer before it counts as upscaled. */
  maxUpscale: 1.5,
  /** Cells on the shorter side of the art's analysis grid (R20). */
  artCells: 64,
  /** Colour distance from the background (Euclidean RGB / 255) from which a cell is subject. */
  subjectColor: 0.15,
  /** Luminance range of a cell's 3×3 neighbourhood from which it is subject (structure). */
  subjectRange: 0.12,
  /** Range below which a background-coloured cell is flat. */
  flatRange: 0.03,
  /** Pixels per side of the grey cells behind text (R20: a fixed canvas scale). */
  busyCell: 4,
  /** Largest busyness behind a text layer (R17). */
  busyText: 0.015,
} as const;

/**
 * The contrast a text layer must reach (spec §9, R2): large text from
 * `largeTextPx`, body text below; the subline counts as body text at every
 * size. Compose colours text against the same rule.
 */
export const requiredTextContrast = (kind: TextLayerKind, fontSize: number) =>
  kind !== "subline" && fontSize >= CREATIVE_THRESHOLDS.largeTextPx
    ? CREATIVE_THRESHOLDS.largeContrast
    : CREATIVE_THRESHOLDS.bodyContrast;

/**
 * Decodes raster bytes into an opaque sRGB canvas. With `shorterSide`, a
 * larger image is first scaled down to it and lightly blurred (the art grid
 * needs no more pixels than that).
 */
async function decode(bytes: Buffer, shorterSide?: number): Promise<Raw> {
  const { default: sharp } = await import("sharp");
  try {
    let image = openRaster(sharp, bytes);
    if (shorterSide)
      image = image
        .resize({
          width: shorterSide,
          height: shorterSide,
          fit: "outside",
          withoutEnlargement: true,
        })
        .blur(1);
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

/** A grid of area-averaged cells: mean sRGB channels (0..255) and luma (0..1, Rec. 709 weights). */
type Cells = {
  cols: number;
  rows: number;
  rgb: Float64Array;
  luma: Float64Array;
};

/** Averages the pixels of `box` (a clipped box) over a `cols`×`rows` grid of equal cells. */
function cellsOf(canvas: Raw, box: Box, cols: number, rows: number): Cells {
  const rgb = new Float64Array(cols * rows * 3);
  const counts = new Float64Array(cols * rows);
  const { data, width } = canvas;
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = Math.floor(((y - box.y) * rows) / box.h) * cols;
    for (let x = box.x; x < box.x + box.w; x++) {
      const cell = row + Math.floor(((x - box.x) * cols) / box.w);
      const i = (y * width + x) * 4;
      rgb[cell * 3]! += data[i]!;
      rgb[cell * 3 + 1]! += data[i + 1]!;
      rgb[cell * 3 + 2]! += data[i + 2]!;
      counts[cell]!++;
    }
  }
  const luma = new Float64Array(cols * rows);
  for (let cell = 0; cell < cols * rows; cell++) {
    const n = counts[cell]! || 1;
    for (let c = 0; c < 3; c++) rgb[cell * 3 + c]! /= n;
    luma[cell] =
      (0.2126 * rgb[cell * 3]! +
        0.7152 * rgb[cell * 3 + 1]! +
        0.0722 * rgb[cell * 3 + 2]!) /
      255;
  }
  return { cols, rows, rgb, luma };
}

/** Calls `visit` with the values of a cell's 3×3 neighbourhood (clipped at the grid edge). */
function neighbourhood(
  cells: Cells,
  values: Float64Array,
  col: number,
  row: number,
  visit: (value: number) => void,
) {
  for (
    let r = Math.max(0, row - 1);
    r <= Math.min(cells.rows - 1, row + 1);
    r++
  )
    for (
      let c = Math.max(0, col - 1);
      c <= Math.min(cells.cols - 1, col + 1);
      c++
    )
      visit(values[r * cells.cols + c]!);
}

/**
 * How busy the canvas is inside `box` (0 for a flat field): the grey value is
 * averaged over `busyCell`-pixel cells (so grain and JPEG noise drop out),
 * and the standard deviation of each cell's 3×3 neighbourhood is averaged.
 * A scrim of opacity `a` scales it by `1 − a`.
 */
export function backdropBusyness(canvas: Raw, box: Box): number {
  const area = clip(canvas, box);
  const { busyCell } = CREATIVE_THRESHOLDS;
  const cells = cellsOf(
    canvas,
    area,
    Math.max(1, Math.round(area.w / busyCell)),
    Math.max(1, Math.round(area.h / busyCell)),
  );
  let total = 0;
  for (let row = 0; row < cells.rows; row++)
    for (let col = 0; col < cells.cols; col++) {
      let n = 0;
      let sum = 0;
      let squares = 0;
      neighbourhood(cells, cells.luma, col, row, (value) => {
        n++;
        sum += value;
        squares += value * value;
      });
      total += Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
    }
  return total / (cells.cols * cells.rows);
}

/** Mean and p10/p90 of the relative luminance inside `box` (clipped to the image). */
export async function regionLuminance(
  png: Buffer,
  box: Box,
): Promise<{ mean: number; p10: number; p90: number }> {
  const canvas = await decode(png);
  return luminanceStats(canvas, clip(canvas, box));
}

/** Per-channel median colour of the cells on the grid's border. */
function borderColour(cells: Cells) {
  const channels: number[][] = [[], [], []];
  for (let row = 0; row < cells.rows; row++)
    for (let col = 0; col < cells.cols; col++) {
      if (row > 0 && row < cells.rows - 1 && col > 0 && col < cells.cols - 1)
        continue;
      for (let c = 0; c < 3; c++)
        channels[c]!.push(cells.rgb[(row * cells.cols + col) * 3 + c]!);
    }
  return channels.map((values) => {
    values.sort((a, b) => a - b);
    return values[values.length >> 1]!;
  });
}

/** Bounding box (in cells) of the largest 8-connected component of `mask`, or `null`. */
function largestComponent(mask: Uint8Array, cols: number, rows: number) {
  const seen = new Uint8Array(mask.length);
  let best: { size: number; box: [number, number, number, number] } | null =
    null;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    const box: [number, number, number, number] = [cols, rows, -1, -1];
    while (stack.length) {
      const cell = stack.pop()!;
      const col = cell % cols;
      const row = (cell - col) / cols;
      size++;
      box[0] = Math.min(box[0], col);
      box[1] = Math.min(box[1], row);
      box[2] = Math.max(box[2], col);
      box[3] = Math.max(box[3], row);
      for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++)
        for (
          let c = Math.max(0, col - 1);
          c <= Math.min(cols - 1, col + 1);
          c++
        ) {
          const next = r * cols + c;
          if (mask[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
    }
    if (!best || size > best.size) best = { size, box };
  }
  return best?.box ?? null;
}

/**
 * The subject and empty area of an art, on a grid of area-averaged cells
 * (`artCells` on the shorter side). The background colour is the median of
 * the border cells. A cell is subject when its colour differs from the
 * background by more than `subjectColor` or the luma range of its 3×3
 * neighbourhood exceeds `subjectRange`; it is flat when it has the background
 * colour and a range below `flatRange`.
 * - `subjectCoverage`: area of the bounding box of the largest connected
 *   subject (8-connected cells; specks lose to it), as a share of the art;
 * - `flatShare`: the empty area left visible: flat cells whose centre lies
 *   outside every reserved zone (fractions of the art), as a share of all
 *   cells. (A share of the free cells alone would read the thin margins
 *   between text and product as an empty art.)
 * - `meanDetail`: the mean neighbourhood range of all cells (informational).
 */
export async function analyzeArt(
  png: Buffer,
  reserved: RelBox[],
): Promise<{ subjectCoverage: number; flatShare: number; meanDetail: number }> {
  const { artCells, subjectColor, subjectRange, flatRange } =
    CREATIVE_THRESHOLDS;
  const canvas = await decode(png, 16 * artCells);
  const cell = Math.min(canvas.width, canvas.height) / artCells;
  const cols = Math.max(1, Math.round(canvas.width / cell));
  const rows = Math.max(1, Math.round(canvas.height / cell));
  const cells = cellsOf(
    canvas,
    { x: 0, y: 0, w: canvas.width, h: canvas.height },
    cols,
    rows,
  );
  const background = borderColour(cells);
  const subject = new Uint8Array(cols * rows);
  let flat = 0;
  let ranges = 0;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      let low = Infinity;
      let high = -Infinity;
      neighbourhood(cells, cells.luma, col, row, (value) => {
        low = Math.min(low, value);
        high = Math.max(high, value);
      });
      const range = high - low;
      ranges += range;
      const distance =
        Math.hypot(
          cells.rgb[index * 3]! - background[0]!,
          cells.rgb[index * 3 + 1]! - background[1]!,
          cells.rgb[index * 3 + 2]! - background[2]!,
        ) / 255;
      if (distance > subjectColor || range > subjectRange) subject[index] = 1;
      const cx = (col + 0.5) / cols;
      const cy = (row + 0.5) / rows;
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
      if (distance <= subjectColor && range < flatRange) flat++;
    }
  const box = largestComponent(subject, cols, rows);
  return {
    subjectCoverage: box
      ? ((box[2] - box[0] + 1) * (box[3] - box[1] + 1)) / (cols * rows)
      : 0,
    flatShare: flat / (cols * rows),
    meanDetail: ranges / (cols * rows),
  };
}

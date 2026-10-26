import type { OverlayOptions } from "sharp";
import { LINEAR_CHANNEL, contrastRatio } from "./color.ts";
import type { Box } from "./templates.ts";

// Raw-canvas helpers shared by composition and analysis: decoding with input
// limits, compositing, SVG overlays and luminance statistics of a region.

export type Sharp = Awaited<typeof import("sharp")>["default"];
/** An opaque RGBA canvas in sharp's raw layout. */
export type Raw = { data: Buffer; width: number; height: number };
/** Relative luminance percentiles of what lies behind a layer, measured before it is drawn. */
export type Backdrop = { p10: number; p90: number };

const MAX_INPUT_PIXELS = 40_000_000;

/** `#RRGGBB` of an sRGB triple (channel values are rounded). */
export const toHex = (rgb: readonly number[]) =>
  "#" +
  rgb
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** Mean and p10/p90 of the relative luminance of the canvas pixels inside `box`. */
export function luminanceStats(canvas: Raw, box: Box) {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(canvas.width, box.x + box.w);
  const y1 = Math.min(canvas.height, box.y + box.h);
  const values = new Float64Array(Math.max(1, (x1 - x0) * (y1 - y0)));
  let n = 0;
  let sum = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * canvas.width + x) * 4;
      const l =
        0.2126 * LINEAR_CHANNEL[canvas.data[i]!]! +
        0.7152 * LINEAR_CHANNEL[canvas.data[i + 1]!]! +
        0.0722 * LINEAR_CHANNEL[canvas.data[i + 2]!]!;
      values[n++] = l;
      sum += l;
    }
  values.sort();
  const at = (p: number) => values[Math.max(0, Math.floor(p * (n - 1)))]!;
  return { mean: sum / Math.max(1, n), p10: at(0.1), p90: at(0.9) };
}

/** Contrast of a colour against the darker and the lighter end of a backdrop. */
export const worstContrast = (color: string, backdrop: Backdrop) =>
  Math.min(
    contrastRatio(color, backdrop.p10),
    contrastRatio(color, backdrop.p90),
  );

/** Composites overlays onto a raw canvas and returns the result as a new raw canvas. */
export async function flatten(
  sharp: Sharp,
  base: Raw,
  overlays: OverlayOptions[],
): Promise<Raw> {
  const image = sharp(base.data, {
    raw: { width: base.width, height: base.height, channels: 4 },
  });
  const { data, info } = await (
    overlays.length ? image.composite(overlays) : image
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** An SVG document of the given size around `body`, as bytes for sharp. */
export const svgImage = (width: number, height: number, body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
  );

/** Decodes approved bytes with bounded input size, strict decoding and no animation. */
export const openRaster = (sharp: Sharp, bytes: Buffer) =>
  sharp(bytes, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "warning",
    animated: false,
  });

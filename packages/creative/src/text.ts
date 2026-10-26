import type { BrandFont } from "./brand.ts";
import { CreativeError } from "./errors.ts";

/** How one text block is typeset: font, size range, spacing and line limit. */
export type TextStyle = {
  font: BrandFont;
  weight: 400 | 600 | 700 | 800;
  color: string;
  maxSize: number;
  minSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  align: "left" | "center";
  uppercase: boolean;
  maxLines: number;
};

/** Transparent PNG of the fitted text and its measured size in pixels. */
export type FittedText = {
  png: Buffer;
  width: number;
  height: number;
  size: number;
};

/** Longest text accepted for a single block. */
const MAX_TEXT_LENGTH = 300;
/** Pango font sizes are expressed in 1/1024 point; at 72 dpi one point is one pixel. */
const PANGO_UNITS = 1024;
/** Largest width sharp accepts for a text render. */
const MAX_BOX_WIDTH = 1_000_000;
/** Typed as a record so that a new `BrandFont` member must be added here too. */
const FONTS: Record<BrandFont, true> = {
  Inter: true,
  "DejaVu Sans": true,
  Arial: true,
  "system-ui": true,
};
const WEIGHTS: readonly number[] = [400, 600, 700, 800];
/** Control characters, line/paragraph separators and bidi overrides; emoji joiners stay allowed. */
const FORBIDDEN_CHARS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

type Sharp = Awaited<typeof import("sharp")>["default"];
type Face = { font: BrandFont; weight: number; color: string };
/** Natural line pitch of a font at one size and the ink height of a single reference line. */
type LineMetrics = { pitch: number; ink: number };

/** Escapes the characters that are special in Pango markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}

/** Integer sizes from `maxSize` down to `minSize` in steps of 2 px; empty if none lies in range. */
function candidateSizes(style: TextStyle): number[] {
  const high = Math.floor(style.maxSize);
  const low = Math.ceil(style.minSize);
  const sizes: number[] = [];
  for (let size = high; size > low; size -= 2) sizes.push(size);
  if (high >= low) sizes.push(low);
  return sizes;
}

/** Renders Pango markup content with one face and returns the PNG and its measured size. */
function render(
  sharp: Sharp,
  content: string,
  face: Face,
  size: number,
  layout: { width: number; align: "left" | "center"; spacing: number },
) {
  const markup =
    `<span font_family="${face.font}" font_weight="${face.weight}" ` +
    `font_size="${Math.round(size * PANGO_UNITS)}" foreground="${face.color}">${content}</span>`;
  return sharp({
    text: {
      text: markup,
      rgba: true,
      width: layout.width,
      dpi: 72,
      wrap: "word",
      align: layout.align,
      spacing: layout.spacing,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

const metricsCache = new Map<string, Promise<LineMetrics>>();

/**
 * Measures the natural line pitch from reference renders ("Hg" on one and on three lines):
 * Pango's `spacing` is added on top of it, and the height of a render is ink, not line boxes.
 * Cached per font, weight and size.
 */
function lineMetrics(sharp: Sharp, face: Face, size: number) {
  const key = `${face.font}|${face.weight}|${size}`;
  let metrics = metricsCache.get(key);
  if (!metrics) {
    const reference = (lines: number) =>
      render(
        sharp,
        Array.from({ length: lines }, () => "Hg").join("\n"),
        { ...face, color: "#000000" },
        size,
        { width: Math.ceil(size * 8), align: "left", spacing: 0 },
      );
    metrics = Promise.all([reference(1), reference(3)]).then(
      ([one, three]) => ({
        pitch: (three.info.height - one.info.height) / 2,
        ink: one.info.height,
      }),
    );
    metrics.catch(() => metricsCache.delete(key));
    metricsCache.set(key, metrics);
  }
  return metrics;
}

/**
 * Typesets `text` with real font metrics (Pango via sharp) and returns the largest integer size
 * between `maxSize` and `minSize` whose block fits the box in at most `maxLines` lines at the
 * requested line height. Text is never cut or drawn outside the box: when even `minSize` does
 * not fit, the result is `TEXT_OVERFLOW`. `width` and `height` of the result are the measured
 * block, which can be narrower than the box.
 */
export async function fitText(
  text: string,
  box: { width: number; height: number },
  style: TextStyle,
): Promise<FittedText> {
  if (
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH ||
    FORBIDDEN_CHARS.test(text)
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  if (!Object.hasOwn(FONTS, style.font))
    throw new CreativeError("INVALID_BRAND_FONT");
  if (!/^#[0-9A-F]{6}$/i.test(style.color))
    throw new CreativeError("INVALID_BRAND_COLOR");
  const boxWidth = Math.floor(box.width);
  if (
    !WEIGHTS.includes(style.weight) ||
    (style.align !== "left" && style.align !== "center") ||
    ![box.height, style.maxSize, style.minSize, style.lineHeight].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !(boxWidth >= 1 && boxWidth <= MAX_BOX_WIDTH) ||
    !Number.isInteger(style.maxLines) ||
    style.maxLines < 1 ||
    style.minSize > style.maxSize
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");

  const { default: sharp } = await import("sharp");
  const content = escapeMarkup(style.uppercase ? text.toUpperCase() : text);
  const face: Face = {
    font: style.font,
    weight: style.weight,
    color: style.color,
  };
  for (const size of candidateSizes(style)) {
    const metrics = await lineMetrics(sharp, face, size);
    // Pango adds `spacing` to the natural pitch; it may be negative for tight line heights.
    const spacing = Math.round(size * style.lineHeight - metrics.pitch);
    const pitch = Math.max(1, metrics.pitch + spacing);
    const { data, info } = await render(sharp, content, face, size, {
      width: boxWidth,
      align: style.align,
      spacing,
    });
    // Ink height is one line's ink plus one pitch per further line.
    const lines =
      Math.max(0, Math.round((info.height - metrics.ink) / pitch)) + 1;
    if (
      info.width <= boxWidth &&
      lines <= style.maxLines &&
      info.height <= box.height
    )
      return { png: data, width: info.width, height: info.height, size };
  }
  throw new CreativeError("TEXT_OVERFLOW");
}

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

/** Escapes the characters that are special in Pango markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}

/** Candidate sizes from `maxSize` down to `minSize`, in steps of 2 px. */
function candidateSizes(style: TextStyle): number[] {
  const sizes: number[] = [];
  for (let size = style.maxSize; size > style.minSize; size -= 2)
    sizes.push(size);
  sizes.push(style.minSize);
  return sizes;
}

/**
 * Typesets `text` with real font metrics (Pango via sharp) and returns the largest size
 * between `maxSize` and `minSize` that fits the box and `maxLines`. Text is never cut or
 * drawn outside the box: when even `minSize` does not fit, the result is `TEXT_OVERFLOW`.
 */
export async function fitText(
  text: string,
  box: { width: number; height: number },
  style: TextStyle,
): Promise<FittedText> {
  if (
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH ||
    /[\u0000-\u001f]/u.test(text)
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  if (!/^#[0-9A-F]{6}$/i.test(style.color))
    throw new CreativeError("INVALID_BRAND_COLOR");
  if (
    ![box.width, box.height, style.maxSize, style.minSize].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    style.minSize > style.maxSize
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");

  const { default: sharp } = await import("sharp");
  const content = escapeMarkup(style.uppercase ? text.toUpperCase() : text);
  for (const size of candidateSizes(style)) {
    const markup =
      `<span font_family="${style.font}" font_weight="${style.weight}" ` +
      `font_size="${size * PANGO_UNITS}" foreground="${style.color}">${content}</span>`;
    const { data, info } = await sharp({
      text: {
        text: markup,
        rgba: true,
        width: box.width,
        dpi: 72,
        wrap: "word",
        align: style.align,
        spacing: Math.round(size * (style.lineHeight - 1)),
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    const maxHeight = Math.min(
      box.height,
      style.maxLines * size * style.lineHeight + 1,
    );
    if (info.width <= box.width && info.height <= maxHeight)
      return { png: data, width: info.width, height: info.height, size };
  }
  throw new CreativeError("TEXT_OVERFLOW");
}

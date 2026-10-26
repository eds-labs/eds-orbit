import type { CreativeBrand } from "./brand.ts";
import { CreativeError } from "./errors.ts";
import type { VariantId } from "./ids.ts";
import type { Sharp } from "./raster.ts";
import type { Box, LayoutSpec, TextLayerKind } from "./templates.ts";
import { fitText, type FittedText, type TextStyle } from "./text.ts";

// The text stack: fitting eyebrow, headline, subline and CTA into the
// layout's text box, evening out short last lines, and placing the blocks.

/** The headline should be at least this much larger than the subline when there is room. */
const HIERARCHY = 1.5;
/** Shares of their size range the eyebrow, subline and CTA may use, tried until the headline fits well. */
const SUPPORT_STEPS = [1, 2 / 3, 1 / 3, 0];
/** A last line shorter than this share of its block is rebalanced. */
const SHORT_LAST_LINE = 0.5;
/** Text is first fitted in this colour; colours are chosen once the backdrop is known. */
const FIT_COLOR = "#000000";

export type Block = {
  kind: TextLayerKind;
  text: string;
  /** The box and style the text was fitted with; re-rendered in its final colour later. */
  fit: { box: { width: number; height: number }; style: TextStyle };
  fitted: FittedText;
  /** Where the block (for the CTA: the button) sits on the canvas. */
  frame: Box;
  /** CTA only: offset of the label inside the button. */
  label?: { x: number; y: number };
};
type StyleBase = Omit<TextStyle, "color" | "maxSize" | "minSize">;

function textStyles(
  brand: CreativeBrand,
  align: "left" | "center",
): Record<TextLayerKind, StyleBase> {
  const { palette, typography } = brand;
  return {
    eyebrow: {
      font: palette.bodyFont,
      weight: 700,
      lineHeight: 1.25,
      align,
      uppercase: true,
      maxLines: 2,
    },
    headline: {
      font: palette.headingFont,
      weight: typography.headingWeight,
      lineHeight: 1.08,
      align,
      uppercase: typography.headingCase === "upper",
      maxLines: 4,
    },
    subline: {
      font: palette.bodyFont,
      weight: 400,
      lineHeight: 1.35,
      align,
      uppercase: false,
      maxLines: 4,
    },
    cta: {
      font: palette.bodyFont,
      weight: 700,
      lineHeight: 1.1,
      align: "left",
      uppercase: false,
      maxLines: 1,
    },
  };
}

/** Button geometry for a CTA label of the given size. */
const ctaPadX = (size: number) => Math.round(0.95 * size);
const ctaHeight = (size: number) => Math.round(2 * size);

/** Vertical gap between two neighbouring layers, from the fitted sizes. */
function gapBetween(
  above: TextLayerKind,
  below: TextLayerKind,
  size: (kind: TextLayerKind) => number,
) {
  if (above === "eyebrow") return Math.round(0.7 * size("eyebrow"));
  if (above === "headline")
    return Math.round((below === "cta" ? 0.55 : 0.38) * size("headline"));
  return Math.round(1.0 * size("subline"));
}

/**
 * Fits the stack into the text box. The headline gets the room the other
 * layers leave; those start at their maximum and step down their size range
 * until the headline fits at least `HIERARCHY` times the subline size.
 */
async function fitStack(
  copy: Partial<Record<TextLayerKind, string>>,
  layout: LayoutSpec,
  styles: Record<TextLayerKind, StyleBase>,
) {
  const kinds = layout.stack.filter((kind) => copy[kind] !== undefined);
  const { textBox } = layout;
  const fit = async (
    kind: TextLayerKind,
    box: { width: number; height: number },
    share: number,
  ) => {
    const { max, min } = layout.sizes[kind];
    const style: TextStyle = {
      ...styles[kind],
      color: FIT_COLOR,
      maxSize: min + share * (max - min),
      minSize: min,
    };
    return {
      kind,
      text: copy[kind]!,
      fit: { box, style },
      fitted: await fitText(copy[kind]!, box, style),
    };
  };

  let best: Omit<Block, "frame" | "label">[] | null = null;
  for (const share of SUPPORT_STEPS) {
    const support = await Promise.all(
      kinds
        .filter((kind) => kind !== "headline")
        .map((kind) =>
          fit(
            kind,
            {
              width:
                kind === "cta"
                  ? textBox.w - 2 * ctaPadX(layout.sizes.cta.max)
                  : textBox.w,
              height: textBox.h,
            },
            share,
          ),
        ),
    );
    const sizeOf = (kind: TextLayerKind) =>
      kind === "headline"
        ? layout.sizes.headline.max
        : support.find((b) => b.kind === kind)!.fitted.size;
    let used = 0;
    for (const block of support)
      used +=
        block.kind === "cta"
          ? ctaHeight(block.fitted.size)
          : block.fitted.height;
    for (let i = 1; i < kinds.length; i++)
      used += gapBetween(kinds[i - 1]!, kinds[i]!, sizeOf);
    const room = textBox.h - used;
    if (room < layout.sizes.headline.min) continue;
    let headline;
    try {
      headline = await fit("headline", { width: textBox.w, height: room }, 1);
    } catch (error) {
      if (error instanceof CreativeError && error.code === "TEXT_OVERFLOW")
        continue;
      throw error;
    }
    const blocks = kinds.map((kind) =>
      kind === "headline" ? headline : support.find((b) => b.kind === kind)!,
    );
    const subline = support.find((b) => b.kind === "subline");
    if (
      !subline ||
      headline.fitted.size >= HIERARCHY * subline.fitted.size ||
      headline.fitted.size >= layout.sizes.headline.max
    )
      return blocks;
    // No clear hierarchy yet: remember the largest headline in case no step gives one.
    if (
      !best ||
      headline.fitted.size >
        best.find((b) => b.kind === "headline")!.fitted.size
    )
      best = blocks;
  }
  if (!best) throw new CreativeError("TEXT_OVERFLOW");
  return best;
}

/** Width of the inked part of a text block's last line, from the bottom rows of its PNG. */
async function lastLineWidth(sharp: Sharp, fitted: FittedText) {
  const { data, info } = await sharp(fitted.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Lines are at least 1.08 em apart and descenders reach about 0.25 em, so the
  // bottom 0.6 em hold only the last line.
  const top = Math.max(0, info.height - Math.round(0.6 * fitted.size));
  let left = info.width;
  let right = -1;
  for (let y = top; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3]! > 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
  return right - left + 1;
}

/**
 * When a wrapped block ends in a short last line (a lone word or two), narrows
 * it to the smallest width that keeps its size and does not grow its height
 * (so no line is added), which evens out the lines. Other blocks come back
 * unchanged.
 */
async function balance(
  sharp: Sharp,
  block: Omit<Block, "frame" | "label">,
): Promise<Omit<Block, "frame" | "label">> {
  if (
    block.kind === "cta" ||
    (await lastLineWidth(sharp, block.fitted)) >=
      SHORT_LAST_LINE * block.fitted.width
  )
    return block;
  const { box, style } = block.fit;
  const size = block.fitted.size;
  const fixed = { ...style, maxSize: size, minSize: size };
  const at = async (width: number) => {
    try {
      const fitted = await fitText(
        block.text,
        { width, height: box.height },
        fixed,
      );
      return fitted.height <= block.fitted.height ? fitted : null;
    } catch (error) {
      if (error instanceof CreativeError && error.code === "TEXT_OVERFLOW")
        return null;
      throw error;
    }
  };
  // Greedy wrapping only adds lines as the width shrinks; a balanced block of
  // two or more lines is never narrower than half the widest line.
  let fits = { width: block.fitted.width, fitted: block.fitted };
  let low = Math.floor(block.fitted.width / 2);
  while (fits.width - low > 4) {
    const mid = Math.floor((low + fits.width) / 2);
    const fitted = await at(mid);
    if (fitted) fits = { width: mid, fitted };
    else low = mid;
  }
  if (fits.width === block.fitted.width) return block;
  return {
    ...block,
    fit: { box: { width: fits.width, height: box.height }, style },
    fitted: fits.fitted,
  };
}

/** Where the stack hugs its box: at the scrim's solid edge (R13), else by variant. */
function stackAnchor(layout: LayoutSpec, variant: VariantId) {
  const direction = layout.scrim?.direction;
  if (direction === "down" || (!direction && variant === "text_top"))
    return "top";
  if (direction === "up" || (!direction && variant === "text_bottom"))
    return "bottom";
  return "middle";
}

/** Places the fitted blocks top to bottom inside the text box. */
function placeStack(
  blocks: Omit<Block, "frame" | "label">[],
  layout: LayoutSpec,
  variant: VariantId,
): Block[] {
  const { textBox, textAlign } = layout;
  const sizeOf = (kind: TextLayerKind) =>
    blocks.find((b) => b.kind === kind)?.fitted.size ?? 0;
  const dims = blocks.map((b) =>
    b.kind === "cta"
      ? {
          w: b.fitted.width + 2 * ctaPadX(b.fitted.size),
          h: ctaHeight(b.fitted.size),
        }
      : { w: b.fitted.width, h: b.fitted.height },
  );
  const gaps = blocks.map((b, i) =>
    i === 0 ? 0 : gapBetween(blocks[i - 1]!.kind, b.kind, sizeOf),
  );
  const total =
    dims.reduce((sum, d) => sum + d.h, 0) + gaps.reduce((a, b) => a + b, 0);
  const anchor = stackAnchor(layout, variant);
  let y =
    anchor === "top"
      ? textBox.y
      : anchor === "bottom"
        ? textBox.y + textBox.h - total
        : textBox.y + Math.round((textBox.h - total) / 2);
  return blocks.map((block, i) => {
    const { w, h } = dims[i]!;
    y += gaps[i]!;
    const x =
      textAlign === "center"
        ? textBox.x + Math.round((textBox.w - w) / 2)
        : textBox.x;
    const frame = { x, y, w, h };
    y += h;
    return block.kind === "cta"
      ? {
          ...block,
          frame,
          label: {
            x: ctaPadX(block.fitted.size),
            y: Math.round((h - block.fitted.height) / 2),
          },
        }
      : { ...block, frame };
  });
}

/**
 * Fits, balances and places the text stack; `copy` holds only the layers to
 * draw. Text is fitted in a neutral colour; callers re-render it in the final
 * colour at the same size and box.
 */
export async function textStack(
  sharp: Sharp,
  copy: Partial<Record<TextLayerKind, string>>,
  layout: LayoutSpec,
  brand: CreativeBrand,
  variant: VariantId,
): Promise<Block[]> {
  const fitted = await fitStack(
    copy,
    layout,
    textStyles(brand, layout.textAlign),
  );
  return placeStack(
    await Promise.all(fitted.map((block) => balance(sharp, block))),
    layout,
    variant,
  );
}

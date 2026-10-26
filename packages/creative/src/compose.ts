import type { OverlayOptions } from "sharp";
import {
  sha256Hex,
  verifyBrand,
  type BrandPalette,
  type CreativeBrand,
  type CreativeLogo,
  type RasterSource,
} from "./brand.ts";
import { LINEAR_CHANNEL, contrastRatio, relativeLuminance } from "./color.ts";
import { CreativeError } from "./errors.ts";
import {
  LOGO_ROLES,
  type FormatId,
  type LogoPlacement,
  type LogoRole,
  type TemplateId,
  type TextScale,
  type VariantId,
} from "./ids.ts";
import {
  TEMPLATE_NEEDS,
  layoutFor,
  type Box,
  type LayoutSpec,
  type TextLayerKind,
} from "./templates.ts";
import { fitText, type FittedText, type TextStyle } from "./text.ts";

/** Copy of one creative; optional layers without text are left out. */
export type CreativeCopy = {
  eyebrow?: string;
  headline: string;
  subline?: string;
  cta?: string;
};

export type ComposeInput = {
  template: TemplateId;
  variant: VariantId;
  format: FormatId;
  brand: CreativeBrand;
  copy: CreativeCopy;
  /** Generated or uploaded artwork; `TEMPLATE_NEEDS` says whether the template requires it. */
  art?: RasterSource;
  /** Approved screenshots or product images; a layout has one product frame. */
  products?: RasterSource[];
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  /** Free correction: each step starts the scrim 0.12 stronger. */
  scrimBoost?: 0 | 1 | 2 | 3;
  /** Forces a logo variant instead of choosing one by the backdrop. */
  logoRole?: LogoRole;
};

/** One drawn layer of the manifest QA checks, in drawing order. */
export type LayerRecord = {
  kind: "art" | "product" | "scrim" | TextLayerKind | "logo" | "logo_plate";
  box: Box;
  sourceSha256?: string;
  sourceSize?: { width: number; height: number };
  /** Drawn width divided by source width. */
  scale?: number;
  fontSize?: number;
  /** Text or CTA label colour; for the logo its alpha-weighted mean colour; for the plate its fill. */
  color?: string;
  role?: LogoRole;
};

/** Relative luminance percentiles of what lies behind a layer, measured before it is drawn. */
export type Backdrop = { p10: number; p90: number };

export type ComposeResult = {
  png: Buffer;
  sha256: string;
  width: number;
  height: number;
  format: FormatId;
  template: TemplateId;
  variant: VariantId;
  layers: LayerRecord[];
  /** For a pill CTA the backdrop is the pill colour; for a plated logo, the plate. */
  backdrops: Partial<Record<TextLayerKind | "logo", Backdrop>>;
  scrimOpacity: number;
  logoRole: LogoRole;
  /** The CTA as drawn: a pill falls back to an outline when no label colour is readable on it (R2). */
  ctaStyleApplied: "pill" | "outline" | "none";
  renderer: { sharp: string; vips: string };
};

type Sharp = Awaited<typeof import("sharp")>["default"];
/** An opaque RGBA canvas in sharp's raw layout. */
type Raw = { data: Buffer; width: number; height: number };

const MAX_INPUT_PIXELS = 40_000_000;
/** Art whose aspect differs from its region by more than this factor is contained, not cropped. */
const ART_ASPECT_TOLERANCE = 1.35;
/** Share of contained art (along its open sides) that fades into the blurred copy. */
const ART_FEATHER = 0.12;
const SCRIM_BOOST_STEP = 0.12;
const SCRIM_RAISE_STEP = 0.1;
/** QA's contrast requirements (spec §9): body text, large text from 32 px, logos. */
const BODY_CONTRAST = 4.5;
const LARGE_CONTRAST = 3;
const LARGE_TEXT_PX = 32;
const LOGO_CONTRAST = 2;
/** Mean luminance below which the logo backdrop counts as dark. */
const DARK_BACKDROP = 0.4;
const PLATE_OPACITY = 0.9;
/** The headline should be at least this much larger than the subline when there is room. */
const HIERARCHY = 1.5;
/** Shares of their size range the eyebrow, subline and CTA may use, tried until the headline fits well. */
const SUPPORT_STEPS = [1, 2 / 3, 1 / 3, 0];
/** A last line shorter than this share of its block is rebalanced. */
const SHORT_LAST_LINE = 0.5;
/** Text is first fitted in this colour; colours are chosen once the backdrop is known. */
const FIT_COLOR = "#000000";
const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
} as const;
const AUTO_ROLES: readonly LogoRole[] = ["onDark", "onLight", "primary"];

// ---------------------------------------------------------------------------
// Pixels and colours
// ---------------------------------------------------------------------------

const toHex = (rgb: readonly number[]) =>
  "#" +
  rgb
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** Mean and p10/p90 of the relative luminance of the canvas pixels inside `box`. */
function luminanceStats(canvas: Raw, box: Box) {
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
const worstContrast = (color: string, backdrop: Backdrop) =>
  Math.min(
    contrastRatio(color, backdrop.p10),
    contrastRatio(color, backdrop.p90),
  );

/** The candidate with the best worst-case contrast; the first one wins a tie. */
function mostReadable(candidates: string[], backdrop: Backdrop) {
  let best = { color: candidates[0]!, contrast: -1 };
  for (const color of candidates) {
    const contrast = worstContrast(color, backdrop);
    if (contrast > best.contrast) best = { color, contrast };
  }
  return best;
}

/** QA's requirement for a text layer (spec §9, R2); the subline counts as body text. */
const requiredContrast = (kind: TextLayerKind, size: number) =>
  kind !== "subline" && size >= LARGE_TEXT_PX ? LARGE_CONTRAST : BODY_CONTRAST;

/** Text colours: the palette's text colour and a light one (the surface when it is light enough). */
function textColors(palette: BrandPalette) {
  const light =
    relativeLuminance(palette.surfaceColor) > 0.8
      ? palette.surfaceColor
      : "#FFFFFF";
  return [palette.textColor, light];
}

async function flatten(
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

const svg = (width: number, height: number, body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
  );

const open = (sharp: Sharp, bytes: Buffer) =>
  sharp(bytes, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "warning",
    animated: false,
  });

// ---------------------------------------------------------------------------
// Art and products: approved bytes, only scaled
// ---------------------------------------------------------------------------

/**
 * Cover-fits the art into its region around the salient subject; art whose
 * aspect is too far off is contained over a blurred cover copy of itself.
 */
async function artLayers(sharp: Sharp, art: RasterSource, box: Box) {
  const { width = 0, height = 0 } = await open(sharp, art.bytes).metadata();
  const ratio = width / height / (box.w / box.h);
  const record = {
    kind: "art" as const,
    box,
    sourceSha256: art.sha256,
    sourceSize: { width, height },
  };
  if (Math.max(ratio, 1 / ratio) <= ART_ASPECT_TOLERANCE) {
    const input = await open(sharp, art.bytes)
      .resize(box.w, box.h, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .png()
      .toBuffer();
    return {
      overlays: [{ input, left: box.x, top: box.y }],
      record: { ...record, scale: Math.max(box.w / width, box.h / height) },
    };
  }
  const backdrop = await open(sharp, art.bytes)
    .resize(box.w, box.h, { fit: "cover" })
    .blur(Math.max(8, 0.04 * Math.max(box.w, box.h)))
    .png()
    .toBuffer();
  const contained = await open(sharp, art.bytes)
    .resize(box.w, box.h, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = contained.info;
  // Feather the open sides into the blurred copy, so no hard seam shows.
  const across = w < box.w;
  const feather = Math.round(ART_FEATHER * (across ? w : h)) / (across ? w : h);
  const mask = svg(
    w,
    h,
    `<defs><linearGradient id="f" x1="0" y1="0" x2="${across ? 1 : 0}" y2="${across ? 0 : 1}">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="${feather}" stop-color="#FFFFFF"/>
    <stop offset="${1 - feather}" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#f)"/>`,
  );
  const front = await sharp(contained.data)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return {
    overlays: [
      { input: backdrop, left: box.x, top: box.y },
      {
        input: front,
        left: box.x + Math.round((box.w - w) / 2),
        top: box.y + Math.round((box.h - h) / 2),
      },
    ],
    record: { ...record, scale: w / width },
  };
}

/**
 * The screenshot scaled into its box (aspect kept) and centred on a rounded
 * card with a soft shadow. The card is wider than the screenshot by enough
 * that its rounded corners never cover a pixel of it.
 */
async function productLayers(
  sharp: Sharp,
  product: RasterSource,
  box: Box,
  format: LayoutSpec["format"],
  palette: BrandPalette,
) {
  const W = format.width;
  const radius = Math.round(0.03 * W);
  const pad = Math.max(
    Math.ceil(radius * (1 - Math.SQRT1_2)) + 2,
    Math.round(0.012 * W),
  );
  const { width = 0, height = 0 } = await open(sharp, product.bytes).metadata();
  const scaled = await open(sharp, product.bytes)
    .resize(box.w - 2 * pad, box.h - 2 * pad, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const w = scaled.info.width;
  const h = scaled.info.height;
  const x = box.x + Math.round((box.w - w) / 2);
  const y = box.y + Math.round((box.h - h) / 2);
  const card = { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad };
  const blur = Math.round(0.018 * W);
  const frame = svg(
    W,
    format.height,
    `<defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
    <rect x="${card.x}" y="${card.y + Math.round(0.012 * W)}" width="${card.w}" height="${card.h}" rx="${radius}" fill="#000000" fill-opacity="0.3" filter="url(#shadow)"/>
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="${radius}" fill="${palette.surfaceColor}"/>`,
  );
  return {
    overlays: [
      { input: frame, left: 0, top: 0 },
      { input: scaled.data, left: x, top: y },
    ],
    record: {
      kind: "product" as const,
      box: { x, y, w, h },
      sourceSha256: product.sha256,
      sourceSize: { width, height },
      scale: w / width,
    },
  };
}

// ---------------------------------------------------------------------------
// Text stack
// ---------------------------------------------------------------------------

type Block = {
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

// ---------------------------------------------------------------------------
// Scrim
// ---------------------------------------------------------------------------

const GRADIENT_VECTORS = {
  up: [0, 1, 0, 0],
  down: [0, 0, 0, 1],
  right: [0, 0, 1, 0],
  left: [1, 0, 0, 0],
} as const;

/**
 * The scrim as a full-canvas SVG: solid behind the text stack (from the
 * scrim's solid edge to just past the stack), then easing out to nothing.
 */
function scrimSvg(
  layout: LayoutSpec,
  scrim: NonNullable<LayoutSpec["scrim"]>,
  color: string,
  opacity: number,
  blocks: Block[],
) {
  const { width: W, height: H } = layout.format;
  const { box, direction } = scrim;
  if (direction === "full")
    return svg(
      W,
      H,
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${color}" fill-opacity="${opacity}"/>`,
    );
  const margin = Math.round(0.04 * Math.min(W, H));
  const top = Math.min(...blocks.map((b) => b.frame.y));
  const bottom = Math.max(...blocks.map((b) => b.frame.y + b.frame.h));
  const left = Math.min(...blocks.map((b) => b.frame.x));
  const right = Math.max(...blocks.map((b) => b.frame.x + b.frame.w));
  const covered = {
    up: (box.y + box.h - top + margin) / box.h,
    down: (bottom + margin - box.y) / box.h,
    right: (right + margin - box.x) / box.w,
    left: (box.x + box.w - left + margin) / box.w,
  }[direction];
  const solid = Math.min(0.85, Math.max(0.2, covered));
  const stops = [
    `<stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/>`,
  ];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const fade = 1 - t * t * (3 - 2 * t);
    stops.push(
      `<stop offset="${(solid + (1 - solid) * t).toFixed(4)}" stop-color="${color}" stop-opacity="${(opacity * fade).toFixed(4)}"/>`,
    );
  }
  const [x1, y1, x2, y2] = GRADIENT_VECTORS[direction];
  return svg(
    W,
    H,
    `<defs><linearGradient id="scrim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.join("")}</linearGradient></defs>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="url(#scrim)"/>`,
  );
}

/** Text colours and backdrops of every block on a canvas; `readable` when all meet QA's requirement. */
function colourStack(
  canvas: Raw,
  blocks: Block[],
  palette: BrandPalette,
  pill: { color: string; label: string } | null,
) {
  const candidates = textColors(palette);
  const backdrops: Partial<Record<TextLayerKind, Backdrop>> = {};
  const colors: Partial<Record<TextLayerKind, string>> = {};
  let readable = true;
  for (const block of blocks) {
    if (block.kind === "cta" && pill) {
      const l = relativeLuminance(pill.color);
      backdrops.cta = { p10: l, p90: l };
      colors.cta = pill.label;
      continue;
    }
    const { p10, p90 } = luminanceStats(canvas, block.frame);
    const backdrop = { p10, p90 };
    const required = requiredContrast(block.kind, block.fitted.size);
    let { color, contrast } = mostReadable(candidates, backdrop);
    if (
      block.kind === "eyebrow" &&
      worstContrast(palette.accentColor, backdrop) >= required
    ) {
      color = palette.accentColor;
      contrast = worstContrast(color, backdrop);
    }
    backdrops[block.kind] = backdrop;
    colors[block.kind] = color;
    if (contrast < required) readable = false;
  }
  return { backdrops, colors, readable };
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

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
  const { width = 0, height = 0 } = await open(sharp, logo.bytes).metadata();
  const scaled = await open(sharp, logo.bytes)
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
async function placeLogo(
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
      input: svg(
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

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function assertIntact(source: RasterSource) {
  if (sha256Hex(source.bytes) !== source.sha256)
    throw new CreativeError("BRAND_ASSET_INTEGRITY_FAILED");
}

/**
 * Composes one creative: brand background, art, scrim, the approved product
 * screenshot, the text stack and the approved logo, in one sharp pipeline.
 * Logos and screenshots are their approved bytes (SHA-256 checked), only
 * scaled with their aspect kept. The scrim is strengthened until every text
 * layer meets QA's contrast requirement or the layout's maximum is reached.
 * Throws `ART_REQUIRED`, `PRODUCT_ASSET_REQUIRED`,
 * `BRAND_ASSET_INTEGRITY_FAILED`, `TEXT_OVERFLOW`, `RASTER_RENDER_FAILED`,
 * `RASTER_OUTPUT_INVALID` and `INVALID_TEMPLATE_INPUT`.
 */
export async function composeCreative(
  input: ComposeInput,
): Promise<ComposeResult> {
  const { template, variant, format, brand, art } = input;
  const products = input.products ?? [];
  const scrimBoost = input.scrimBoost ?? 0;
  if (
    ![0, 1, 2, 3].includes(scrimBoost) ||
    (input.logoRole !== undefined &&
      (!LOGO_ROLES.includes(input.logoRole) ||
        !brand.logos.some((logo) => logo.role === input.logoRole)))
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  verifyBrand(brand);
  if (art) assertIntact(art);
  products.forEach(assertIntact);

  const layout = layoutFor(template, variant, format, {
    ...input.options,
    logoRole: input.logoRole,
  });
  const needs = TEMPLATE_NEEDS[template];
  if (needs.art === "required" && !art) throw new CreativeError("ART_REQUIRED");
  if (needs.product === "required" && !products.length)
    throw new CreativeError("PRODUCT_ASSET_REQUIRED");
  if (products.length > 1 || (products.length && !layout.product))
    throw new CreativeError("INVALID_TEMPLATE_INPUT");

  const { palette } = brand;
  const copy: Partial<Record<TextLayerKind, string>> = {};
  for (const kind of layout.stack) {
    const text = input.copy[kind];
    if (kind === "headline" || text?.trim()) copy[kind] = text?.trim() ?? "";
  }
  if (brand.ctaStyle === "none") delete copy.cta;

  const { default: sharp } = await import("sharp");
  try {
    const { width: W, height: H } = layout.format;
    const layers: LayerRecord[] = [];

    // 1. Brand background and art.
    const background: OverlayOptions[] =
      layout.background === "brand_gradient"
        ? [
            {
              input: svg(
                W,
                H,
                `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.primaryColor}"/><stop offset="1" stop-color="${palette.secondaryColor}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/>`,
              ),
              left: 0,
              top: 0,
            },
          ]
        : [];
    if (art && layout.art) {
      const placed = await artLayers(sharp, art, layout.art);
      background.push(...placed.overlays);
      layers.push(placed.record);
    }
    const { data, info } = await sharp({
      create: {
        width: W,
        height: H,
        channels: 4,
        background: palette.backgroundColor,
      },
    })
      .composite(background)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const base: Raw = { data, width: info.width, height: info.height };

    // 2. Text stack geometry (colours come later).
    const fitted = await fitStack(
      copy,
      layout,
      textStyles(brand, layout.textAlign),
    );
    const blocks = placeStack(
      await Promise.all(fitted.map((block) => balance(sharp, block))),
      layout,
      variant,
    );
    const cta = blocks.find((b) => b.kind === "cta");
    let pill: { color: string; label: string } | null = null;
    if (cta && brand.ctaStyle === "pill") {
      const label = mostReadable(textColors(palette), {
        p10: relativeLuminance(palette.primaryColor),
        p90: relativeLuminance(palette.primaryColor),
      });
      if (label.contrast >= requiredContrast("cta", cta.fitted.size))
        pill = { color: palette.primaryColor, label: label.color };
    }

    // 3. Product, drawn after the scrim so it is never tinted.
    const product =
      products[0] && layout.product
        ? await productLayers(
            sharp,
            products[0],
            layout.product,
            layout.format,
            palette,
          )
        : null;

    // 4. Scrim: from its start opacity up in steps until the text reads, capped at the layout's maximum.
    const scrim = layout.scrim;
    const scrimColor =
      relativeLuminance(palette.textColor) < 0.2
        ? palette.textColor
        : "#000000";
    let opacity = scrim
      ? Math.min(
          scrim.max,
          (art ? scrim.base : 0) + SCRIM_BOOST_STEP * scrimBoost,
        )
      : 0;
    let canvas: Raw;
    let colouring: ReturnType<typeof colourStack>;
    for (;;) {
      const overlays: OverlayOptions[] = [];
      if (scrim && opacity > 0)
        overlays.push({
          input: scrimSvg(layout, scrim, scrimColor, opacity, blocks),
          left: 0,
          top: 0,
        });
      if (product) overlays.push(...product.overlays);
      canvas = await flatten(sharp, base, overlays);
      colouring = colourStack(canvas, blocks, palette, pill);
      if (colouring.readable || !scrim || opacity >= scrim.max) break;
      opacity = Math.min(
        scrim.max,
        Math.round((opacity + SCRIM_RAISE_STEP) * 100) / 100,
      );
    }
    if (scrim && opacity > 0) layers.push({ kind: "scrim", box: scrim.box });
    if (product) layers.push(product.record);

    // 5. Text in its final colours, and the CTA button.
    const textOverlays: OverlayOptions[] = [];
    for (const block of blocks) {
      const color = colouring.colors[block.kind]!;
      const { size } = block.fitted;
      const rendered = await fitText(block.text, block.fit.box, {
        ...block.fit.style,
        color,
        maxSize: size,
        minSize: size,
      });
      if (
        rendered.width !== block.fitted.width ||
        rendered.height !== block.fitted.height
      )
        throw new CreativeError("RASTER_RENDER_FAILED");
      const { frame } = block;
      if (block.kind === "cta") {
        const stroke = Math.max(2, Math.round(0.08 * size));
        const outline =
          worstContrast(palette.accentColor, colouring.backdrops.cta!) >=
          LARGE_CONTRAST
            ? palette.accentColor
            : color;
        textOverlays.push({
          input: svg(
            W,
            H,
            pill
              ? `<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="${frame.h / 2}" fill="${pill.color}"/>`
              : `<rect x="${frame.x + stroke / 2}" y="${frame.y + stroke / 2}" width="${frame.w - stroke}" height="${frame.h - stroke}" rx="${(frame.h - stroke) / 2}" fill="none" stroke="${outline}" stroke-width="${stroke}"/>`,
          ),
          left: 0,
          top: 0,
        });
      }
      textOverlays.push({
        input: rendered.png,
        left: frame.x + (block.label?.x ?? 0),
        top: frame.y + (block.label?.y ?? 0),
      });
      layers.push({ kind: block.kind, box: frame, fontSize: size, color });
    }
    const texted = await flatten(sharp, canvas!, textOverlays);

    // 6. Logo, with a plate only when no variant is visible on its own.
    const logo = await placeLogo(sharp, texted, layout, brand, input.logoRole);
    if (logo.plate)
      layers.push({
        kind: "logo_plate",
        box: logo.plate,
        color: palette.surfaceColor,
      });
    layers.push({
      kind: "logo",
      box: logo.placed.box,
      sourceSha256: logo.placed.logo.sha256,
      sourceSize: logo.placed.sourceSize,
      scale: logo.placed.box.w / logo.placed.sourceSize.width,
      color: logo.placed.color,
      role: logo.placed.logo.role,
    });
    const final = await flatten(sharp, logo.canvas, [
      {
        input: logo.placed.png,
        left: logo.placed.box.x,
        top: logo.placed.box.y,
      },
    ]);
    const output = await sharp(final.data, {
      raw: { width: final.width, height: final.height, channels: 4 },
    })
      .removeAlpha()
      .png(PNG_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    if (output.info.width !== W || output.info.height !== H)
      throw new CreativeError("RASTER_OUTPUT_INVALID");

    return {
      png: output.data,
      sha256: sha256Hex(output.data),
      width: W,
      height: H,
      format,
      template,
      variant,
      layers,
      backdrops: { ...colouring!.backdrops, logo: logo.backdrop },
      scrimOpacity: scrim && opacity > 0 ? opacity : 0,
      logoRole: logo.placed.logo.role,
      ctaStyleApplied: cta ? (pill ? "pill" : "outline") : "none",
      renderer: {
        sharp: sharp.versions.sharp ?? "",
        vips: sharp.versions.vips,
      },
    };
  } catch (error) {
    if (error instanceof CreativeError) throw error;
    throw new CreativeError("RASTER_RENDER_FAILED");
  }
}

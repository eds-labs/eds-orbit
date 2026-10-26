import type { OverlayOptions } from "sharp";
import {
  CREATIVE_THRESHOLDS,
  detailEnergy,
  requiredTextContrast,
} from "./analysis.ts";
import {
  sha256Hex,
  verifyBrand,
  type BrandPalette,
  type CreativeBrand,
  type RasterSource,
} from "./brand.ts";
import { relativeLuminance } from "./color.ts";
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
import { placeLogo } from "./logo.ts";
import {
  flatten,
  luminanceStats,
  openRaster,
  svgImage,
  worstContrast,
  type Backdrop,
  type Raw,
  type Sharp,
} from "./raster.ts";
import { textStack, type Block } from "./stack.ts";
import { fitText } from "./text.ts";

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
  /**
   * Text or CTA label colour; for the logo its ink (the pixel at the
   * alpha-weighted median luminance, of the mark only when the logo brings its
   * own opaque background); for the plate its fill.
   */
  color?: string;
  role?: LogoRole;
};

/** What lies behind a text layer: its luminance range and how busy it is (R17). */
export type TextBackdrop = Backdrop & {
  /** Detail energy (`detailEnergy`) behind the layer, after the scrim; 0 on a pill. */
  busy: number;
};

export type ComposeResult = {
  png: Buffer;
  sha256: string;
  width: number;
  height: number;
  format: FormatId;
  template: TemplateId;
  variant: VariantId;
  layers: LayerRecord[];
  /**
   * For a pill CTA the backdrop is the pill colour; for a plated logo, the
   * plate; for a logo with its own opaque background, that background.
   */
  backdrops: Partial<Record<TextLayerKind, TextBackdrop>> & {
    logo?: Backdrop;
  };
  scrimOpacity: number;
  logoRole: LogoRole;
  /** The CTA as drawn: a pill falls back to an outline when no label colour is readable on it (R2). */
  ctaStyleApplied: "pill" | "outline" | "none";
  renderer: { sharp: string; vips: string };
};

/** Art whose aspect differs from its region by more than this factor is contained, not cropped. */
const ART_ASPECT_TOLERANCE = 1.35;
/** Share of contained art (along its open sides) that fades into the blurred copy. */
const ART_FEATHER = 0.12;
const SCRIM_BOOST_STEP = 0.12;
const SCRIM_RAISE_STEP = 0.1;
const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
} as const;

/** The candidate with the best worst-case contrast; the first one wins a tie. */
function mostReadable(candidates: string[], backdrop: Backdrop) {
  let best = { color: candidates[0]!, contrast: -1 };
  for (const color of candidates) {
    const contrast = worstContrast(color, backdrop);
    if (contrast > best.contrast) best = { color, contrast };
  }
  return best;
}

/** Text colours: the palette's text colour and a light one (the surface when it is light enough). */
function textColors(palette: BrandPalette) {
  const light =
    relativeLuminance(palette.surfaceColor) > 0.8
      ? palette.surfaceColor
      : "#FFFFFF";
  return [palette.textColor, light];
}

// ---------------------------------------------------------------------------
// Art and products: approved bytes, only scaled
// ---------------------------------------------------------------------------

/**
 * Cover-fits the art into its region around the salient subject; art whose
 * aspect is too far off is contained over a blurred cover copy of itself.
 * Overlay positions are relative to the box's top-left corner.
 */
async function artLayers(sharp: Sharp, art: RasterSource, box: Box) {
  const { width = 0, height = 0 } = await openRaster(
    sharp,
    art.bytes,
  ).metadata();
  const ratio = width / height / (box.w / box.h);
  const record = {
    kind: "art" as const,
    box,
    sourceSha256: art.sha256,
    sourceSize: { width, height },
  };
  if (Math.max(ratio, 1 / ratio) <= ART_ASPECT_TOLERANCE) {
    const input = await openRaster(sharp, art.bytes)
      .resize(box.w, box.h, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .png()
      .toBuffer();
    return {
      overlays: [{ input, left: 0, top: 0 }],
      record: { ...record, scale: Math.max(box.w / width, box.h / height) },
    };
  }
  const backdrop = await openRaster(sharp, art.bytes)
    .resize(box.w, box.h, { fit: "cover" })
    .blur(Math.max(8, 0.04 * Math.max(box.w, box.h)))
    .png()
    .toBuffer();
  const contained = await openRaster(sharp, art.bytes)
    .resize(box.w, box.h, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = contained.info;
  // Feather the open sides into the blurred copy, so no hard seam shows.
  const across = w < box.w;
  const feather = Math.round(ART_FEATHER * (across ? w : h)) / (across ? w : h);
  const mask = svgImage(
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
      { input: backdrop, left: 0, top: 0 },
      {
        input: front,
        left: Math.round((box.w - w) / 2),
        top: Math.round((box.h - h) / 2),
      },
    ],
    record: { ...record, scale: w / width },
  };
}

/**
 * The art exactly as compose draws it into the layout's art box (same cover
 * or contain fit, same code), as a PNG of the box's size. Art checks run on
 * it, with `artZones(layout)` as their reserved zones (R21). Throws
 * `BRAND_ASSET_INTEGRITY_FAILED` for bytes that are not the approved ones.
 */
export async function drawnArt(
  art: RasterSource,
  layout: LayoutSpec,
): Promise<Buffer> {
  const box = layout.art;
  if (!box) throw new CreativeError("INVALID_TEMPLATE_INPUT");
  assertIntact(art);
  const { default: sharp } = await import("sharp");
  try {
    const { overlays } = await artLayers(sharp, art, box);
    return await sharp({
      create: {
        width: box.w,
        height: box.h,
        channels: 4,
        background: "#000000",
      },
    })
      .composite(overlays)
      .png()
      .toBuffer();
  } catch {
    throw new CreativeError("RASTER_RENDER_FAILED");
  }
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
  const { width = 0, height = 0 } = await openRaster(
    sharp,
    product.bytes,
  ).metadata();
  const scaled = await openRaster(sharp, product.bytes)
    .resize(box.w - 2 * pad, box.h - 2 * pad, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const w = scaled.info.width;
  const h = scaled.info.height;
  const x = box.x + Math.round((box.w - w) / 2);
  const y = box.y + Math.round((box.h - h) / 2);
  const card = { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad };
  const blur = Math.round(0.018 * W);
  const frame = svgImage(
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
    return svgImage(
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
  return svgImage(
    W,
    H,
    `<defs><linearGradient id="scrim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.join("")}</linearGradient></defs>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="url(#scrim)"/>`,
  );
}

/**
 * Text colours and backdrops of every block on a canvas; `readable` when all
 * meet QA's contrast requirement, `calm` when no backdrop is busier than QA
 * allows (R17).
 */
function colourStack(
  canvas: Raw,
  blocks: Block[],
  palette: BrandPalette,
  pill: { color: string; label: string } | null,
) {
  const candidates = textColors(palette);
  const backdrops: Partial<Record<TextLayerKind, TextBackdrop>> = {};
  const colors: Partial<Record<TextLayerKind, string>> = {};
  let readable = true;
  let calm = true;
  for (const block of blocks) {
    if (block.kind === "cta" && pill) {
      const l = relativeLuminance(pill.color);
      backdrops.cta = { p10: l, p90: l, busy: 0 };
      colors.cta = pill.label;
      continue;
    }
    const { p10, p90 } = luminanceStats(canvas, block.frame);
    const backdrop = { p10, p90, busy: detailEnergy(canvas, block.frame) };
    const required = requiredTextContrast(block.kind, block.fitted.size);
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
    if (backdrop.busy > CREATIVE_THRESHOLDS.busyText) calm = false;
  }
  return { backdrops, colors, readable, calm };
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
 * layer meets QA's contrast requirement on a backdrop no busier than QA allows
 * (R17), or the layout's maximum is reached.
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
              input: svgImage(
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
      const { x, y } = layout.art;
      background.push(
        ...placed.overlays.map((o) => ({
          ...o,
          left: o.left + x,
          top: o.top + y,
        })),
      );
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
    const blocks = await textStack(sharp, copy, layout, brand, variant);
    const cta = blocks.find((b) => b.kind === "cta");
    let pill: { color: string; label: string } | null = null;
    if (cta && brand.ctaStyle === "pill") {
      const label = mostReadable(textColors(palette), {
        p10: relativeLuminance(palette.primaryColor),
        p90: relativeLuminance(palette.primaryColor),
      });
      if (label.contrast >= requiredTextContrast("cta", cta.fitted.size))
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

    // 4. Scrim: from its start opacity up in steps until the text reads on a
    // calm backdrop (R17), capped at the layout's maximum.
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
      if (
        (colouring.readable && colouring.calm) ||
        !scrim ||
        opacity >= scrim.max
      )
        break;
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
          CREATIVE_THRESHOLDS.largeContrast
            ? palette.accentColor
            : color;
        textOverlays.push({
          input: svgImage(
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
        box: logo.plate.box,
        color: logo.plate.color,
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

import { CreativeError } from "./errors.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "./formats.ts";
import {
  LOGO_PLACEMENTS,
  TEXT_SCALES,
  type FormatId,
  type LogoPlacement,
  type LogoRole,
  type TemplateId,
  type TextScale,
  type VariantId,
} from "./ids.ts";

// Pure data and geometry: this file must stay free of sharp (and of anything
// that imports it) because the schemas package reads `TEMPLATE_VARIANTS`.

/** A rectangle in canvas pixels. */
export type Box = { x: number; y: number; w: number; h: number };
/** A rectangle in fractions (0..1) of the canvas. */
export type RelBox = Box;
export type TextLayerKind = "eyebrow" | "headline" | "subline" | "cta";
type Corner = Exclude<LogoPlacement, "auto">;

/** Everything the composer needs to place one creative; all boxes are canvas pixels. */
export type LayoutSpec = {
  format: CreativeFormat;
  /**
   * What fills the canvas first. `art` means the art is the whole background
   * (the template requires it); `brand` and `brand_gradient` are brand-colour
   * fills under optional art, which goes into the `art` box when supplied.
   */
  background: "art" | "brand" | "brand_gradient";
  /** Where the art goes; may bleed past the safe area. `null` when the template places none. */
  art: Box | null;
  /** Frame for the product screenshot, inside the safe area; `null` when the template carries none. */
  product: Box | null;
  /** The area for the whole text stack, inside the safe area. */
  textBox: Box;
  textAlign: "left" | "center";
  /** Top-to-bottom order of the text layers; layers without copy are skipped. */
  stack: TextLayerKind[];
  /** Allowed font size range in px per layer, after the text scale. */
  sizes: Record<TextLayerKind, { max: number; min: number }>;
  /** Anchor box (inside the safe area) and corner of the logo. */
  logo: { box: Box; corner: Corner };
  /**
   * Gradient under the text, or `null` when the text sits on a plain brand
   * field. `direction` is where the gradient thins out: `up` is solid at the
   * bottom edge of `box` (text at the bottom), `down` solid at the top, `right`
   * solid at the left (text on the left), `left` solid at the right, `full` an
   * even tint. `box` covers the text box and stops short of the product.
   * `base` is the opacity to start from (0 draws nothing until contrast needs
   * it), `max` the cap.
   */
  scrim: {
    box: Box;
    direction: "up" | "down" | "left" | "right" | "full";
    base: number;
    max: number;
  } | null;
  /** Text box, logo box and (when there is one) product box, in that order, as fractions of the canvas. */
  reservedZones: RelBox[];
};

export type LayoutOptions = {
  logoPlacement: LogoPlacement;
  textScale: TextScale;
  /** Only `mark` changes the layout: a mark gets a narrower logo box. */
  logoRole?: LogoRole;
};

/** Variants per template; the first is the default. */
export const TEMPLATE_VARIANTS: Readonly<
  Record<TemplateId, readonly VariantId[]>
> = {
  product_showcase: ["product_right", "product_left", "text_top"],
  feature_highlight: ["text_top", "product_left", "product_right"],
  problem_solution: ["text_top", "text_bottom"],
  lifestyle: ["text_bottom", "text_top", "text_side"],
  tips: ["text_top", "centered"],
  announcement: ["centered", "text_bottom"],
  brand_message: ["centered", "text_bottom"],
};

type Need = "required" | "optional" | "none";
/** Which assets a template needs; `none` means the layout has no place for it. */
export const TEMPLATE_NEEDS: Readonly<
  Record<TemplateId, { art: Need; product: Need }>
> = {
  product_showcase: { art: "optional", product: "required" },
  feature_highlight: { art: "optional", product: "required" },
  problem_solution: { art: "required", product: "optional" },
  lifestyle: { art: "required", product: "none" },
  tips: { art: "optional", product: "none" },
  announcement: { art: "optional", product: "optional" },
  brand_message: { art: "required", product: "none" },
};

const limits = (headline: number, subline: number) => ({
  eyebrow: 32,
  headline,
  subline,
  cta: 24,
});
/** Longest copy per layer, in characters. */
export const TEMPLATE_COPY_LIMITS: Readonly<
  Record<
    TemplateId,
    { eyebrow: number; headline: number; subline: number; cta: number }
  >
> = {
  product_showcase: limits(60, 120),
  feature_highlight: limits(60, 120),
  problem_solution: limits(60, 120),
  lifestyle: limits(60, 120),
  tips: limits(70, 180),
  announcement: limits(60, 120),
  brand_message: limits(70, 120),
};

// ---------------------------------------------------------------------------
// Regions
//
// Every region is [x, y, w, h] in fractions of the safe area. Each frame keeps
// one corner of the safe area free of text and product (a "logo band" along
// the top or bottom edge) so that an automatic logo always finds a place.
// `tall` serves square, feed_portrait and story, `wide` serves landscape.
// ---------------------------------------------------------------------------

type Rect = readonly [x: number, y: number, w: number, h: number];
type Aspect = "tall" | "wide";
/** Art that bleeds off the canvas from one `edge`, starting `cut` (fraction of the safe area) in. */
type ArtRegion =
  "full" | { edge: "top" | "bottom" | "left" | "right"; cut: number };
/** `art` defaults to the full canvas. */
type Region = { text: Rect; product?: Rect; art?: ArtRegion };
type Frame = Record<Aspect, Region>;
/** Side variants only exist for square (`tall`) and landscape (`wide`). */
type RegionTable = Partial<Record<VariantId, Frame>>;
type TemplateSpec = {
  background: LayoutSpec["background"];
  scrim: { base: number; max: number } | null;
  regions: RegionTable;
};

const STACK: readonly TextLayerKind[] = [
  "eyebrow",
  "headline",
  "subline",
  "cta",
];

// Frames shared by several templates.
/** Text above a product; the logo goes to the bottom band. */
const TEXT_OVER_PRODUCT: Frame = {
  tall: { text: [0, 0, 1, 0.44], product: [0, 0.48, 1, 0.4] },
  wide: { text: [0, 0, 0.8, 0.58], product: [0.1, 0.62, 0.8, 0.38] },
};
/** Product above text at the bottom; the logo goes to the top band. */
const PRODUCT_OVER_TEXT: Frame = {
  tall: { text: [0, 0.49, 1, 0.51], product: [0, 0.13, 1, 0.32] },
  wide: { text: [0, 0.31, 0.78, 0.69], product: [0.56, 0, 0.44, 0.26] },
};
const TEXT_AT_BOTTOM: Frame = {
  tall: { text: [0, 0.54, 1, 0.46] },
  wide: { text: [0, 0.32, 0.78, 0.68] },
};
const TEXT_AT_TOP: Frame = {
  tall: { text: [0, 0, 1, 0.42] },
  wide: { text: [0, 0, 0.8, 0.66] },
};
/** Full-height text column beside a product; the logo goes under the product (room for R19's 60 px landscape logo). */
const PRODUCT_AT_RIGHT: Frame = {
  tall: { text: [0, 0, 0.46, 1], product: [0.5, 0, 0.5, 0.88] },
  wide: { text: [0, 0, 0.55, 1], product: [0.62, 0, 0.38, 0.82] },
};
const PRODUCT_AT_LEFT: Frame = {
  tall: { text: [0.54, 0, 0.46, 1], product: [0, 0, 0.5, 0.88] },
  wide: { text: [0.45, 0, 0.55, 1], product: [0, 0, 0.38, 0.82] },
};

const TEMPLATES: Readonly<Record<TemplateId, TemplateSpec>> = {
  // Scene or brand gradient behind a large framed screenshot.
  product_showcase: {
    background: "brand_gradient",
    scrim: { base: 0.15, max: 0.85 },
    regions: {
      product_right: PRODUCT_AT_RIGHT,
      product_left: PRODUCT_AT_LEFT,
      text_top: TEXT_OVER_PRODUCT,
    },
  },
  // Text on the plain brand field (the logo above it); the art sits behind the screenshot only.
  feature_highlight: {
    background: "brand",
    scrim: null,
    regions: {
      text_top: {
        tall: {
          text: [0, 0.12, 1, 0.38],
          product: [0, 0.575, 1, 0.425],
          art: { edge: "bottom", cut: 0.535 },
        },
        wide: {
          text: [0, 0, 0.8, 0.52],
          product: [0.1, 0.595, 0.8, 0.405],
          art: { edge: "bottom", cut: 0.555 },
        },
      },
      product_left: {
        tall: {
          text: [0.57, 0.12, 0.43, 0.88],
          product: [0, 0, 0.48, 1],
          art: { edge: "left", cut: 0.535 },
        },
        wide: {
          text: [0.45, 0.17, 0.55, 0.83],
          product: [0, 0, 0.38, 1],
          art: { edge: "left", cut: 0.425 },
        },
      },
      product_right: {
        tall: {
          text: [0, 0.12, 0.43, 0.88],
          product: [0.52, 0, 0.48, 1],
          art: { edge: "right", cut: 0.465 },
        },
        wide: {
          text: [0, 0.17, 0.55, 0.83],
          product: [0.62, 0, 0.38, 1],
          art: { edge: "right", cut: 0.575 },
        },
      },
    },
  },
  // Full-bleed motif; the product, when there is one, sits on the far side of the text.
  problem_solution: {
    background: "art",
    scrim: { base: 0.5, max: 0.85 },
    regions: {
      // On landscape the text gets the room four layers need (R14); the optional product is a strip below.
      text_top: {
        tall: TEXT_OVER_PRODUCT.tall,
        wide: { text: [0, 0, 0.8, 0.66], product: [0.1, 0.7, 0.8, 0.3] },
      },
      text_bottom: PRODUCT_OVER_TEXT,
    },
  },
  // Full-bleed scene, text on a gradient scrim at one side.
  lifestyle: {
    background: "art",
    scrim: { base: 0.5, max: 0.85 },
    regions: {
      text_bottom: TEXT_AT_BOTTOM,
      text_top: TEXT_AT_TOP,
      text_side: {
        tall: { text: [0, 0, 0.52, 1] },
        wide: { text: [0, 0, 0.54, 1] },
      },
    },
  },
  // Text on the plain brand field with a small art accent at the far edge.
  tips: {
    background: "brand",
    scrim: null,
    regions: {
      text_top: {
        tall: { text: [0, 0.13, 1, 0.57], art: { edge: "bottom", cut: 0.74 } },
        wide: {
          text: [0, 0.15, 0.66, 0.85],
          art: { edge: "right", cut: 0.72 },
        },
      },
      centered: {
        tall: {
          text: [0.04, 0.14, 0.92, 0.56],
          art: { edge: "bottom", cut: 0.76 },
        },
        wide: {
          text: [0.06, 0.15, 0.88, 0.64],
          art: { edge: "bottom", cut: 0.85 },
        },
      },
    },
  },
  // Big headline over a motif with a strong scrim; a product is an optional extra.
  announcement: {
    background: "brand_gradient",
    scrim: { base: 0.55, max: 0.9 },
    regions: {
      centered: {
        tall: {
          text: [0.04, 0.14, 0.92, 0.5],
          product: [0.14, 0.68, 0.72, 0.32],
        },
        wide: {
          text: [0.06, 0.14, 0.88, 0.64],
          product: [0.3, 0.81, 0.4, 0.19],
        },
      },
      text_bottom: PRODUCT_OVER_TEXT,
    },
  },
  // Full-bleed motif with a centred statement.
  brand_message: {
    background: "art",
    scrim: { base: 0.45, max: 0.85 },
    regions: {
      centered: {
        tall: { text: [0.04, 0.22, 0.92, 0.5] },
        wide: { text: [0.06, 0.16, 0.88, 0.68] },
      },
      text_bottom: TEXT_AT_BOTTOM,
    },
  },
};

/** Where each variant's gradient thins out; `centered` is decided by the product (see `scrimDirection`). */
const SCRIM_DIRECTION: Readonly<
  Record<Exclude<VariantId, "centered">, "up" | "down" | "left" | "right">
> = {
  text_top: "down",
  text_bottom: "up",
  text_side: "right",
  product_right: "right",
  product_left: "left",
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const SIDE_VARIANTS: ReadonlySet<VariantId> = new Set([
  "text_side",
  "product_left",
  "product_right",
]);
/** Side-by-side variants need width: only these formats have it. */
const SIDE_FORMATS: ReadonlySet<FormatId> = new Set(["landscape", "square"]);
/** Order in which `auto` tries the corners. */
const CORNERS: readonly Corner[] = [
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
];
/** Clear space around the logo, as a fraction of the canvas width. */
const LOGO_CLEARANCE = 0.025;
/** How far a gradient scrim reaches past the text, as a fraction of the canvas side. */
const SCRIM_REACH = 0.12;

const SIZE_FRACTIONS: Readonly<
  Record<TextLayerKind, { max: number; min: number }>
> = {
  headline: { max: 0.085, min: 0.045 },
  subline: { max: 0.04, min: 0.028 },
  eyebrow: { max: 0.028, min: 0.022 },
  cta: { max: 0.032, min: 0.026 },
};
/** Headline maximum on landscape, where height is the scarce side. */
const LANDSCAPE_HEADLINE_MAX = 0.06;
const TEXT_SCALE_FACTOR: Readonly<Record<TextScale, number>> = {
  s: 0.85,
  m: 1,
  l: 1.15,
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  w: box.w + 2 * by,
  h: box.h + 2 * by,
});

function assertKnown(template: TemplateId, format: FormatId) {
  if (
    !Object.hasOwn(TEMPLATES, template) ||
    !Object.hasOwn(CREATIVE_FORMATS, format)
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
}

/** Variants a template offers on a format, in default-first order; side-by-side ones only where there is width. */
export function variantsFor(
  template: TemplateId,
  format: FormatId,
): VariantId[] {
  assertKnown(template, format);
  return TEMPLATE_VARIANTS[template].filter(
    (variant) => !SIDE_VARIANTS.has(variant) || SIDE_FORMATS.has(format),
  );
}

/** Converts a fraction rect of the safe area to pixels; rounded edges keep neighbours disjoint. */
function toBox(rect: Rect, format: CreativeFormat): Box {
  const { safe } = format;
  const width = format.width - safe.left - safe.right;
  const height = format.height - safe.top - safe.bottom;
  const x0 = Math.round(safe.left + rect[0] * width);
  const y0 = Math.round(safe.top + rect[1] * height);
  const x1 = Math.round(safe.left + (rect[0] + rect[2]) * width);
  const y1 = Math.round(safe.top + (rect[1] + rect[3]) * height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function artBox(art: ArtRegion, format: CreativeFormat): Box {
  const { width: W, height: H, safe } = format;
  if (art === "full") return { x: 0, y: 0, w: W, h: H };
  const x = Math.round(safe.left + art.cut * (W - safe.left - safe.right));
  const y = Math.round(safe.top + art.cut * (H - safe.top - safe.bottom));
  switch (art.edge) {
    case "bottom":
      return { x: 0, y, w: W, h: H - y };
    case "top":
      return { x: 0, y: 0, w: W, h: y };
    case "right":
      return { x, y: 0, w: W - x, h: H };
    case "left":
      return { x: 0, y: 0, w: x, h: H };
  }
}

function logoBoxAt(
  corner: Corner,
  format: CreativeFormat,
  role: LogoRole | undefined,
): Box {
  const { width: W, height: H, safe } = format;
  const w = Math.round((role === "mark" ? 0.1 : 0.14) * W);
  // At least 0.05·W tall, so a square logo stays legible on landscape (R19).
  const h = Math.round(Math.max(0.06 * H, 0.05 * W));
  return {
    x: corner.endsWith("left") ? safe.left : W - safe.right - w,
    y: corner.startsWith("top") ? safe.top : H - safe.bottom - h,
    w,
    h,
  };
}

/** Moves a box out of the logo's band by shortening it from the logo's side; unchanged when clear. */
function clearOfLogo(
  box: Box,
  logo: Box,
  corner: Corner,
  clearance: number,
): Box {
  if (!overlaps(grow(logo, clearance), box)) return box;
  if (corner.startsWith("top")) {
    const y = logo.y + logo.h + clearance;
    return { ...box, y, h: box.y + box.h - y };
  }
  return { ...box, h: logo.y - clearance - box.y };
}

function sizesFor(
  format: CreativeFormat,
  textScale: TextScale,
): LayoutSpec["sizes"] {
  const factor = TEXT_SCALE_FACTOR[textScale];
  const size = (kind: TextLayerKind) => {
    const range = SIZE_FRACTIONS[kind];
    const maxFraction =
      kind === "headline" && format.id === "landscape"
        ? LANDSCAPE_HEADLINE_MAX
        : range.max;
    const min = Math.round(range.min * format.width);
    return {
      max: Math.max(min, Math.round(maxFraction * format.width * factor)),
      min,
    };
  };
  return {
    eyebrow: size("eyebrow"),
    headline: size("headline"),
    subline: size("subline"),
    cta: size("cta"),
  };
}

function scrimFor(
  rule: NonNullable<TemplateSpec["scrim"]>,
  variant: VariantId,
  text: Box,
  product: Box | null,
  format: CreativeFormat,
): NonNullable<LayoutSpec["scrim"]> {
  const { width: W, height: H } = format;
  const direction =
    variant === "centered"
      ? product
        ? "down"
        : "full"
      : SCRIM_DIRECTION[variant];
  let x0 = 0;
  let y0 = 0;
  let x1 = W;
  let y1 = H;
  const reachX = Math.round(SCRIM_REACH * W);
  const reachY = Math.round(SCRIM_REACH * H);
  // Past the text the gradient stops at the product, which it must not tint.
  switch (direction) {
    case "down":
      y1 = Math.min(H, text.y + text.h + reachY);
      if (product && product.y >= text.y + text.h) y1 = Math.min(y1, product.y);
      break;
    case "up":
      y0 = Math.max(0, text.y - reachY);
      if (product && product.y + product.h <= text.y)
        y0 = Math.max(y0, product.y + product.h);
      break;
    case "right":
      x1 = Math.min(W, text.x + text.w + reachX);
      if (product && product.x >= text.x + text.w) x1 = Math.min(x1, product.x);
      break;
    case "left":
      x0 = Math.max(0, text.x - reachX);
      if (product && product.x + product.w <= text.x)
        x0 = Math.max(x0, product.x + product.w);
      break;
    case "full":
      break;
  }
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    direction,
    base: rule.base,
    max: rule.max,
  };
}

/**
 * The reserved zones in the frame of the drawn art (R21): each canvas zone
 * clipped to the art box, as fractions of that box; zones beside the art are
 * left out. Pass a layout without the product zone when no product is drawn
 * (R15).
 */
export function artZones(layout: LayoutSpec): RelBox[] {
  const art = layout.art;
  if (!art) return [];
  const { width: W, height: H } = layout.format;
  return layout.reservedZones.flatMap((zone) => {
    const x0 = Math.max(zone.x * W, art.x);
    const y0 = Math.max(zone.y * H, art.y);
    const x1 = Math.min((zone.x + zone.w) * W, art.x + art.w);
    const y1 = Math.min((zone.y + zone.h) * H, art.y + art.h);
    return x1 > x0 && y1 > y0
      ? [
          {
            x: (x0 - art.x) / art.w,
            y: (y0 - art.y) / art.h,
            w: (x1 - x0) / art.w,
            h: (y1 - y0) / art.h,
          },
        ]
      : [];
  });
}

/**
 * Pixel layout of one template variant on one format. Throws
 * `INVALID_TEMPLATE_VARIANT` for a variant the template or format does not
 * offer and `INVALID_TEMPLATE_INPUT` for unknown ids or options.
 *
 * An explicit logo corner that would touch the text or product shortens that
 * box away from the logo, so boxes never overlap; `auto` takes the first
 * corner that needs no such change.
 */
export function layoutFor(
  template: TemplateId,
  variant: VariantId,
  formatId: FormatId,
  options: LayoutOptions,
): LayoutSpec {
  assertKnown(template, formatId);
  if (
    !LOGO_PLACEMENTS.includes(options.logoPlacement) ||
    !TEXT_SCALES.includes(options.textScale)
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  const spec = TEMPLATES[template];
  const aspect: Aspect = formatId === "landscape" ? "wide" : "tall";
  const region = variantsFor(template, formatId).includes(variant)
    ? spec.regions[variant]?.[aspect]
    : undefined;
  if (!region) throw new CreativeError("INVALID_TEMPLATE_VARIANT");

  const source = CREATIVE_FORMATS[formatId];
  const format: CreativeFormat = { ...source, safe: { ...source.safe } };
  let textBox = toBox(region.text, format);
  let product = region.product ? toBox(region.product, format) : null;
  const clearance = Math.round(LOGO_CLEARANCE * format.width);

  const free = (corner: Corner) => {
    const zone = grow(logoBoxAt(corner, format, options.logoRole), clearance);
    return !overlaps(zone, textBox) && !(product && overlaps(zone, product));
  };
  const corner: Corner =
    options.logoPlacement === "auto"
      ? (CORNERS.find(free) ?? "top_left")
      : options.logoPlacement;
  const logoBox = logoBoxAt(corner, format, options.logoRole);
  textBox = clearOfLogo(textBox, logoBox, corner, clearance);
  if (product) product = clearOfLogo(product, logoBox, corner, clearance);

  const zones = [textBox, logoBox, ...(product ? [product] : [])];
  return {
    format,
    background: spec.background,
    art: artBox(region.art ?? "full", format),
    product,
    textBox,
    textAlign: variant === "centered" ? "center" : "left",
    stack: [...STACK],
    sizes: sizesFor(format, options.textScale),
    logo: { box: logoBox, corner },
    scrim: spec.scrim
      ? scrimFor(spec.scrim, variant, textBox, product, format)
      : null,
    reservedZones: zones.map((box) => ({
      x: box.x / format.width,
      y: box.y / format.height,
      w: box.w / format.width,
      h: box.h / format.height,
    })),
  };
}

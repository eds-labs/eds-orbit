import {
  contrastRatio,
  LINEAR_CHANNEL,
  parseHex,
  relativeLuminance,
} from "./color.ts";

/**
 * The colours of the legacy 16:9 brand banner (`brand_landscape`). Every
 * colour the banner draws comes from here, so a project's banner follows its
 * own brand kit (`bannerPalette`) instead of one fixed look.
 */
export type BannerPalette = {
  // Base gradient behind the art, and the shade on the left behind the text.
  base: string;
  baseEnd: string;
  // Wordmark, headline part 1, subline, button label, divider and footer.
  text: string;
  // Headline part 2 (gradient to `accentEnd`), wordmark accent, glow, outlines.
  accent: string;
  accentEnd: string;
  // Top of the logo card's fill; it fades into `base`.
  cardTop: string;
};

/**
 * The palette the renderer draws when no project palette is given: the
 * banner as it was first built (R78). Callers that know the project pass
 * `bannerPalette(identity)`; this default keeps old fixtures unchanged.
 */
export const DEFAULT_BANNER_PALETTE: Readonly<BannerPalette> = {
  base: "#040B1A",
  baseEnd: "#0B1D3A",
  text: "#FFFFFF",
  accent: "#22D3EE",
  accentEnd: "#0EA5E9",
  cardTop: "#16325A",
};

/** The brand kit colours a banner palette is derived from (profile `visualIdentity`). */
export type BrandColours = {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
};

const HEX = /^#[0-9A-F]{6}$/i;
const hex = (rgb: number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();

/** `a` moved towards `b` by `t` (0..1) in sRGB. */
export function mixColour(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return hex(x.map((v, i) => v + (y[i]! - v) * t));
}

export function bannerPaletteValid(palette: unknown): palette is BannerPalette {
  if (!palette || typeof palette !== "object") return false;
  const keys = Object.keys(DEFAULT_BANNER_PALETTE) as Array<
    keyof BannerPalette
  >;
  return (
    Object.keys(palette).length === keys.length &&
    keys.every((key) => {
      const value = (palette as Record<string, unknown>)[key];
      return typeof value === "string" && HEX.test(value);
    })
  );
}

/** The candidate with the best contrast against `base`, preferring earlier ones that reach `min`. */
function readable(base: string, candidates: string[], min: number) {
  const valid = candidates.filter((c) => HEX.test(c));
  const enough = valid.find((c) => contrastRatio(c, base) >= min);
  if (enough) return enough;
  return [...valid, "#FFFFFF", "#000000"].reduce((best, c) =>
    contrastRatio(c, base) > contrastRatio(best, base) ? c : best,
  );
}

/**
 * A banner palette from the project's brand kit. The background colour is
 * the base (a light brand gets a light banner, a dark brand a dark one).
 * Text uses the brand's text colour when it reads on the base (≥ 4.5:1),
 * else white or black. The accent headline uses the first of accent,
 * primary and secondary colour that reaches 3:1 on the base (large text),
 * else the text colour. Nothing names a real brand.
 */
export function bannerPalette(colours: BrandColours): BannerPalette {
  const base = colours.backgroundColor;
  const dark = relativeLuminance(base) < 0.18;
  const text = readable(base, [colours.textColor], 4.5);
  const accent = readable(
    base,
    [colours.accentColor, colours.primaryColor, colours.secondaryColor],
    3,
  );
  // The gradient's end leans to the secondary colour while it still reads.
  const towards = mixColour(accent, colours.secondaryColor, 0.35);
  const accentEnd = contrastRatio(towards, base) >= 3 ? towards : accent;
  return {
    base,
    baseEnd: mixColour(base, colours.secondaryColor, dark ? 0.25 : 0.12),
    text,
    accent,
    accentEnd,
    cardTop: dark
      ? mixColour(base, colours.surfaceColor, 0.12)
      : colours.surfaceColor,
  };
}

export type BrandToneCheck = {
  verdict: "pass" | "mismatch";
  // The brand's base tone from its background colour.
  brandTone: "light" | "mid" | "dark";
  // Relative luminance of the image's average light (0 black .. 1 white).
  imageLuminance: number;
  // Share of image cells close to a brand colour (information only).
  paletteCoverage: number;
};

// Thresholds of the tone check (relative luminance).
export const BRAND_TONE_THRESHOLDS = {
  lightBrand: 0.4,
  darkBrand: 0.12,
  // A light brand's image darker than this, or a dark brand's lighter than
  // `tooLight`, is in the other tone.
  tooDark: 0.1,
  tooLight: 0.5,
  // Distance in sRGB (0..441) under which a cell counts as a brand colour.
  paletteDistance: 64,
} as const;

/**
 * Whether a generated image keeps the brand's tone (deterministic, free):
 * a light brand (light background colour) must not get a dark image, a dark
 * brand not a light one. Judged on a 32 × 32 area average, so detail and
 * noise do not change the verdict. Palette coverage is reported, not judged:
 * art may use more hues than the brand's six.
 */
export async function brandToneCheck(
  bytes: Buffer,
  colours: BrandColours,
): Promise<BrandToneCheck> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes, { failOn: "error" })
    .removeAlpha()
    .resize(32, 32, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const palette = [
    colours.primaryColor,
    colours.secondaryColor,
    colours.accentColor,
    colours.backgroundColor,
    colours.surfaceColor,
    colours.textColor,
  ]
    .filter((c) => HEX.test(c))
    .map(parseHex);
  let linear = 0;
  let near = 0;
  const cells = info.width * info.height;
  for (let i = 0; i < cells; i++) {
    const r = data[i * info.channels]!;
    const g = data[i * info.channels + 1]!;
    const b = data[i * info.channels + 2]!;
    linear +=
      0.2126 * LINEAR_CHANNEL[r]! +
      0.7152 * LINEAR_CHANNEL[g]! +
      0.0722 * LINEAR_CHANNEL[b]!;
    if (
      palette.some(
        ([pr, pg, pb]) =>
          Math.hypot(r - pr, g - pg, b - pb) <=
          BRAND_TONE_THRESHOLDS.paletteDistance,
      )
    )
      near++;
  }
  const imageLuminance = linear / cells;
  const brandLuminance = relativeLuminance(colours.backgroundColor);
  const brandTone =
    brandLuminance >= BRAND_TONE_THRESHOLDS.lightBrand
      ? "light"
      : brandLuminance <= BRAND_TONE_THRESHOLDS.darkBrand
        ? "dark"
        : "mid";
  const mismatch =
    (brandTone === "light" && imageLuminance < BRAND_TONE_THRESHOLDS.tooDark) ||
    (brandTone === "dark" && imageLuminance > BRAND_TONE_THRESHOLDS.tooLight);
  return {
    verdict: mismatch ? "mismatch" : "pass",
    brandTone,
    imageLuminance: Math.round(imageLuminance * 1000) / 1000,
    paletteCoverage: Math.round((near / cells) * 1000) / 1000,
  };
}

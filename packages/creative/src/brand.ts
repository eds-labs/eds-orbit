import { createHash } from "node:crypto";
import { CreativeError } from "./errors.ts";
import type { LogoRole } from "./ids.ts";

export type BrandFont = "Inter" | "DejaVu Sans" | "Arial" | "system-ui";
export type BrandPalette = {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  headingFont: BrandFont;
  bodyFont: BrandFont;
};
/** Approved raster bytes with the SHA-256 they were approved under. */
export type RasterSource = { bytes: Buffer; sha256: string };
export type CreativeLogo = RasterSource & { role: LogoRole };
/** Everything the layout engine may know about a brand; logos are never altered. */
export type CreativeBrand = {
  brandName: string;
  palette: BrandPalette;
  typography: { headingWeight: 600 | 700 | 800; headingCase: "none" | "upper" };
  logos: CreativeLogo[];
  ctaStyle: "pill" | "outline" | "none";
};

const COLOR_KEYS = [
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "backgroundColor",
  "surfaceColor",
  "textColor",
] as const;
const FONT_KEYS = ["headingFont", "bodyFont"] as const;
const FONTS: readonly BrandFont[] = [
  "Inter",
  "DejaVu Sans",
  "Arial",
  "system-ui",
];

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/**
 * Throws a CreativeError unless every logo matches its approved hash, a
 * primary logo exists and the palette uses 6-digit hex colours and allowed fonts.
 */
export function verifyBrand(brand: CreativeBrand): void {
  for (const logo of brand.logos)
    if (logo.sha256 !== sha256Hex(logo.bytes))
      throw new CreativeError("BRAND_ASSET_INTEGRITY_FAILED");
  if (!brand.logos.some((logo) => logo.role === "primary"))
    throw new CreativeError("PRIMARY_LOGO_REQUIRED");
  for (const key of COLOR_KEYS)
    if (!/^#[0-9A-F]{6}$/i.test(brand.palette[key]))
      throw new CreativeError("INVALID_BRAND_COLOR");
  for (const key of FONT_KEYS)
    if (!FONTS.includes(brand.palette[key]))
      throw new CreativeError("INVALID_BRAND_FONT");
}

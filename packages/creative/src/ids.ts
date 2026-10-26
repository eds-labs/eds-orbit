/** Stable identifiers shared by the layout engine, schemas and prompts. */
export const CREATIVE_FORMAT_IDS = [
  "feed_portrait",
  "square",
  "story",
  "landscape",
] as const;
export const CREATIVE_TEMPLATE_IDS = [
  "product_showcase",
  "feature_highlight",
  "problem_solution",
  "lifestyle",
  "tips",
  "announcement",
  "brand_message",
] as const;
export const CREATIVE_VARIANT_IDS = [
  "text_top",
  "text_bottom",
  "text_side",
  "product_left",
  "product_right",
  "centered",
] as const;
export const LOGO_PLACEMENTS = [
  "auto",
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
] as const;
export const TEXT_SCALES = ["s", "m", "l"] as const;
export const IMAGE_KINDS = ["scene", "product", "graphic", "combined"] as const;
export const LOGO_ROLES = [
  "primary",
  "secondary",
  "onDark",
  "onLight",
  "mark",
] as const;
export type FormatId = (typeof CREATIVE_FORMAT_IDS)[number];
export type TemplateId = (typeof CREATIVE_TEMPLATE_IDS)[number];
export type VariantId = (typeof CREATIVE_VARIANT_IDS)[number];
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];
export type TextScale = (typeof TEXT_SCALES)[number];
export type ImageKind = (typeof IMAGE_KINDS)[number];
export type LogoRole = (typeof LOGO_ROLES)[number];

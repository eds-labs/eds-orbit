import { z } from "zod";
import {
  CREATIVE_TEMPLATE_IDS,
  IMAGE_KINDS,
  layoutFor,
  TEMPLATE_NEEDS,
  variantsFor,
  type FormatId,
  type ImageKind,
  type LayoutSpec,
  type LogoPlacement,
  type RelBox,
  type TemplateId,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import { DomainError } from "../../../shared.ts";
import type { MarketingProfile } from "../brand/marketing-profile.ts";
import type { ResolvedCreativeConfig } from "./brand-kit.ts";

/**
 * The creative brief the strategy specialist proposes per post (spec §7).
 * Goal and audience are not asked for: Orbit takes them from the profile.
 */
export const creativeBrief = z
  .object({
    keyMessage: z.string().trim().min(1).max(200),
    imageKind: z.enum(IMAGE_KINDS),
    // What the picture shows, and where.
    motif: z.string().trim().min(1).max(300),
    setting: z.string().trim().min(1).max(300),
    template: z.enum(CREATIVE_TEMPLATE_IDS),
    mood: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type StrategyCreative = z.infer<typeof creativeBrief>;

/** The proposal completed with the brand kit, the channels' formats and the layout's zones. */
export type ResolvedBrief = {
  goal: string;
  audience: string;
  keyMessage: string;
  imageKind: ImageKind;
  motif: string;
  setting: string;
  mood: string;
  template: TemplateId;
  variant: VariantId;
  formats: FormatId[];
  /** The brand kit's imagery description (kind, mood, typical subjects). */
  styleNotes: string;
  /** Motifs and designs to keep out of the art: the brand kit's avoid list and forbidden designs. */
  avoid: string[];
  /**
   * Text, logo and, when a product is shown, product zones of the first
   * format's layout, as canvas fractions in that order (R15). They describe
   * the layout to the art direction; art checks judge the art in its own
   * frame with `artZones(layout)` per format, not with this list (R21).
   */
  reservedZones: RelBox[];
  fallbackReason?: "TEMPLATE_DISABLED" | "NO_PRODUCT_ASSETS";
};

/** Shortens to `max` characters (not UTF-16 units) and flattens line breaks, so text stays one line. */
export function oneLine(text: string, max: number): string {
  return Array.from(text.replace(/\s+/gu, " ").trim())
    .slice(0, max)
    .join("")
    .trimEnd();
}

const SHOWS_PRODUCT: readonly ImageKind[] = ["product", "combined"];
/** Variants that put the text beside the image or product (R12). */
const SIDE_VARIANTS: readonly VariantId[] = [
  "product_right",
  "product_left",
  "text_side",
];

/**
 * Whether a template can carry an image kind: a scene needs no product
 * frame, a graphic is typography on a brand field (art optional), and a
 * product image needs a template with a product frame.
 */
function fits(template: TemplateId, kind: ImageKind): boolean {
  const needs = TEMPLATE_NEEDS[template];
  if (kind === "scene") return needs.product !== "required";
  if (kind === "graphic")
    return needs.art !== "required" && needs.product !== "required";
  return needs.product !== "none";
}

const hasProductFrame = (template: TemplateId) =>
  TEMPLATE_NEEDS[template].product !== "none";

/**
 * The variant a creative draws on one format: its own when the format offers
 * it, else the template's first variant for that format (R1). A brief keeps
 * one variant for all its formats, so the pipeline asks per format.
 */
export function variantForFormat(
  template: TemplateId,
  format: FormatId,
  variant: VariantId,
): VariantId {
  const offered = variantsFor(template, format);
  return offered.includes(variant) ? variant : offered[0]!;
}

/**
 * The variant of a creative. An explicit or project-default variant stays when
 * a format of the creative can draw it (the pipeline adapts the others, R1).
 * Without one, landscape gets the template's first side variant (R12, R16),
 * else the template's first variant for the first format.
 */
function chooseVariant(
  template: TemplateId,
  formats: FormatId[],
  preferred: VariantId | undefined,
): VariantId {
  if (
    preferred &&
    formats.some((format) => variantsFor(template, format).includes(preferred))
  )
    return preferred;
  if (!preferred && formats.includes("landscape")) {
    const side = variantsFor(template, "landscape").find((variant) =>
      SIDE_VARIANTS.includes(variant),
    );
    if (side) return side;
  }
  return variantsFor(template, formats[0]!)[0]!;
}

/**
 * The layout of the brief's first format (the primary one: the art is made
 * once for it and the other formats crop the same art), with the brief's
 * variant adapted to that format. The art direction reads its placement from
 * this layout.
 */
export function briefLayout(
  brief: Pick<ResolvedBrief, "template" | "variant" | "formats">,
  logoPlacement: LogoPlacement,
): LayoutSpec {
  const format = brief.formats[0]!;
  return layoutFor(
    brief.template,
    variantForFormat(brief.template, format, brief.variant),
    format,
    { logoPlacement, textScale: "m" },
  );
}

/** The brand kit's imagery as one description. */
function imageryNotes(imagery: MarketingProfile["visualIdentity"]["imagery"]) {
  if (!imagery) return "";
  return oneLine(
    [
      `${imagery.kind} imagery`,
      imagery.mood,
      imagery.subjects && `typical subjects: ${imagery.subjects}`,
    ]
      .filter(Boolean)
      .join("; "),
    600,
  );
}

/** Who asks: a person in the Creative Studio, or an automated path (assignment, package, default). */
export type BriefOrigin = "manual" | "automated";

/**
 * Completes the strategy's proposal (or, without one, the content's title) into
 * the brief the studio works from. Deterministic: the brand kit decides the
 * style, the disabled templates, the variant and the formats.
 *
 * Automated requests adapt silently:
 * - A disabled template is replaced by the first enabled one that fits the image
 *   kind (`TEMPLATE_DISABLED`); a product image without product assets, or a
 *   template that needs a product without one, becomes a `scene` with the
 *   `lifestyle` template (`NO_PRODUCT_ASSETS`).
 * - A template without a product frame shows a scene, a template that needs a
 *   product shows the product.
 * - An explicit `variant` that no format offers becomes the template's first
 *   valid variant (R1), like the project's default variant.
 *
 * A manual request's explicit choices are never replaced (R30, R31):
 * - An explicit `template` ignores the project's `enabled` switch, which
 *   configures automation. One that needs a product while none is approved is
 *   refused (`PRODUCT_ASSET_REQUIRED`, 409); with an optional product frame
 *   the picture is a scene (`NO_PRODUCT_ASSETS`).
 * - An explicit `variant` that none of the formats offers is refused
 *   (`CREATIVE_VARIANT_NOT_AVAILABLE`, 409).
 * A template the person did not choose (the proposal's) and the project's
 * default variant follow the automated rules.
 */
export function resolveCreativeBrief(input: {
  proposal: StrategyCreative | null;
  content: { title: string; coreMessage?: string };
  profile: MarketingProfile;
  config: ResolvedCreativeConfig;
  hasProducts: boolean;
  channelFormats: FormatId[];
  origin: BriefOrigin;
  template?: TemplateId;
  variant?: VariantId;
}): ResolvedBrief {
  const { proposal, content, profile, config } = input;
  const formats = [...new Set(input.channelFormats)];
  if (!formats.length) throw new DomainError("CREATIVE_FORMAT_REQUIRED", 409);
  const manual = input.origin === "manual";
  // A person's explicit template is theirs to get.
  const chosen = manual && input.template !== undefined;
  const imagery = profile.visualIdentity.imagery;

  let imageKind: ImageKind = proposal?.imageKind ?? "scene";
  let template: TemplateId =
    input.template ?? proposal?.template ?? "lifestyle";
  let fallbackReason: ResolvedBrief["fallbackReason"];

  // The template decides whether a product can be shown.
  const productNeed = TEMPLATE_NEEDS[template].product;
  if (chosen && productNeed === "required" && !input.hasProducts)
    throw new DomainError("PRODUCT_ASSET_REQUIRED", 409);
  if (productNeed === "required" && !SHOWS_PRODUCT.includes(imageKind))
    imageKind = "product";
  if (SHOWS_PRODUCT.includes(imageKind) && !input.hasProducts) {
    imageKind = "scene";
    if (!chosen) template = "lifestyle";
    fallbackReason = "NO_PRODUCT_ASSETS";
  }
  if (!chosen && !config.enabledTemplates.includes(template)) {
    // The kind first, then a plain scene: owners who disabled the templates of
    // a kind still get a creative rather than an error.
    for (const kind of new Set<ImageKind>([imageKind, "scene"])) {
      const replacement = config.enabledTemplates.find((id) => fits(id, kind));
      if (replacement) {
        template = replacement;
        imageKind = kind;
        fallbackReason ??= "TEMPLATE_DISABLED";
        break;
      }
    }
    if (!config.enabledTemplates.includes(template))
      throw new DomainError("NO_CREATIVE_TEMPLATE_ENABLED", 409);
  }
  // A layout without a product frame cannot show one.
  if (SHOWS_PRODUCT.includes(imageKind) && !hasProductFrame(template))
    imageKind = "scene";

  if (
    manual &&
    input.variant &&
    !formats.some((format) =>
      variantsFor(template, format).includes(input.variant!),
    )
  )
    throw new DomainError("CREATIVE_VARIANT_NOT_AVAILABLE", 409);
  const variant = chooseVariant(
    template,
    formats,
    input.variant ?? config.defaultVariants[template],
  );
  const layout = briefLayout(
    { template, variant, formats },
    config.logoPlacement,
  );
  return {
    goal: oneLine(profile.positioning, 300),
    audience: oneLine(profile.audience, 300),
    keyMessage: oneLine(
      proposal?.keyMessage ?? content.coreMessage ?? content.title,
      200,
    ),
    imageKind,
    motif: oneLine(proposal?.motif ?? content.title, 300),
    setting: oneLine(proposal?.setting ?? "", 300),
    mood: oneLine(proposal?.mood ?? imagery?.mood ?? "", 300),
    template,
    variant,
    formats,
    styleNotes: imageryNotes(imagery),
    avoid: [
      ...new Set([
        ...(imagery?.avoid ?? []),
        ...(profile.visualIdentity.forbiddenDesigns ?? []),
      ]),
    ],
    // [text, logo, product?]: the product zone only counts when a product is drawn (R15).
    reservedZones: layout.reservedZones.slice(
      0,
      SHOWS_PRODUCT.includes(imageKind) ? 3 : 2,
    ),
    ...(fallbackReason && { fallbackReason }),
  };
}

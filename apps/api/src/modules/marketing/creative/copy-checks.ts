import { z } from "zod";
import {
  TEMPLATE_COPY_LIMITS,
  type CreativeCopy,
  type TemplateId,
} from "../../../../../../packages/creative/src/index.ts";
import type { CopyLimits } from "../../../../../../packages/ai/src/index.ts";
import { bodyLinkProblems } from "../agents/agent-review.ts";
import {
  copyOffenses,
  ctaLabel,
  statesProhibitedLanguage,
  statesUnsupportedClaim,
  unsafeText,
} from "../agents/banner.ts";
import { creativeStudioEnabled } from "./flag.ts";

// Copy craft and creative copy (spec §10). With the Creative Studio on, a
// social draft is written around one core message (`copyCraft`), and a
// mission with a creative template also gets the short copy on its image
// (`creativeCopy`). Both are reviewed content: the deterministic checks below
// run next to the body's, with the banner copy's rules (R78) for the image.

export const CREATIVE_TEXT_MISSING = "CREATIVE_TEXT_MISSING";
export const CREATIVE_UNSUPPORTED_CLAIM = "CREATIVE_UNSUPPORTED_CLAIM";
export const CREATIVE_PROHIBITED_LANGUAGE = "CREATIVE_PROHIBITED_LANGUAGE";
// Invisible characters or letters of another script (homoglyphs) in the copy.
export const CREATIVE_TEXT_UNSAFE = "CREATIVE_TEXT_UNSAFE";
// An explicit link on the image: the post's link belongs in the body.
export const CREATIVE_LINK_NOT_ALLOWED = "CREATIVE_LINK_NOT_ALLOWED";
export const CORE_MESSAGE_MISSING = "CORE_MESSAGE_MISSING";
export const FACT_TOO_LONG_FOR_SOCIAL = "FACT_TOO_LONG_FOR_SOCIAL";
/** The longest fact claim a social post may carry under copy craft, in characters. */
export const SOCIAL_FACT_MAX = 220;

/** Copy craft problems one deterministic revision may fix (round 1 only). */
export const COPY_CRAFT_REVISABLE = new Set([
  CORE_MESSAGE_MISSING,
  FACT_TOO_LONG_FOR_SOCIAL,
]);
/** Image copy problems one deterministic revision may fix (round 1 only). */
export const CREATIVE_REVISABLE = new Set([
  CREATIVE_UNSUPPORTED_CLAIM,
  CREATIVE_PROHIBITED_LANGUAGE,
  CREATIVE_TEXT_MISSING,
]);

/** A creative's image copy as the copywriter writes it: every layer, an empty one is absent. */
export type CreativeCopyText = {
  eyebrow: string;
  headline: string;
  subline: string;
  cta: string;
};

/**
 * The image copy as a content stores it (`creativeCopy`, R37): the headline
 * and only the other layers that are not empty, the shape the creative
 * pipeline reads.
 */
export function storedCreativeCopy(copy: CreativeCopyText): CreativeCopy {
  return {
    ...(copy.eyebrow ? { eyebrow: copy.eyebrow } : {}),
    headline: copy.headline,
    ...(copy.subline ? { subline: copy.subline } : {}),
    ...(copy.cta ? { cta: copy.cta } : {}),
  };
}

const storedCopy = z
  .object({
    eyebrow: z.string().optional(),
    headline: z.string(),
    subline: z.string().optional(),
    cta: z.string().optional(),
  })
  .strict();

/** The image copy as stored on a content (`creativeCopy`), or null when it is missing or malformed. */
export function parsedCreativeCopy(value: unknown): CreativeCopy | null {
  const parsed = storedCopy.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Stored image copy with every layer, an absent one empty (for the checks). */
function everyLayer(value: unknown): CreativeCopyText | null {
  const copy = parsedCreativeCopy(value);
  return copy
    ? {
        eyebrow: copy.eyebrow ?? "",
        headline: copy.headline,
        subline: copy.subline ?? "",
        cta: copy.cta ?? "",
      }
    : null;
}

/**
 * The creative template a mission's draft writes image copy for, or null:
 * a known template on the mission (`creativeTemplate`) while the Creative
 * Studio is on (CS-D6: off, no prompt changes).
 */
export function creativeTemplateOf(
  mission: Record<string, any> | null,
): TemplateId | null {
  const template = mission?.creativeTemplate;
  return typeof template === "string" &&
    Object.hasOwn(TEMPLATE_COPY_LIMITS, template) &&
    creativeStudioEnabled()
    ? (template as TemplateId)
    : null;
}

/**
 * The image's CTA for a mission's CTA (its `targetAction`): the CTA without
 * closing punctuation when it fits the template's `max`, else empty (no CTA
 * on the image). The image thus never names another call to action than its
 * post.
 */
export function creativeCta(cta: unknown, max: number) {
  const label = ctaLabel(cta);
  return label.length <= max ? label : "";
}

// Control characters and line or paragraph separators: the template draws
// every layer on its own and refuses them.
const UNDRAWABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LAYERS = ["eyebrow", "headline", "subline", "cta"] as const;

/** All layers as one text (for unsafe characters and links). */
const allCopy = (copy: CreativeCopyText) =>
  [copy.eyebrow, copy.headline, copy.subline, copy.cta].join("\n");

/**
 * The copy the claim and wording checks read (NFKC): without the CTA when
 * it is the mission's approved CTA, which is campaign copy and no claim.
 */
const checkedCopy = (copy: CreativeCopyText, cta: unknown, max: number) =>
  (copy.cta && copy.cta === creativeCta(cta, max)
    ? [copy.eyebrow, copy.headline, copy.subline].join("\n")
    : allCopy(copy)
  ).normalize("NFKC");

/**
 * Deterministic problems of a creative's image copy: missing or malformed
 * copy, a layer over the template's `limits` or one the template cannot draw
 * (`CREATIVE_TEXT_MISSING`), invisible or non-Latin characters
 * (`CREATIVE_TEXT_UNSAFE`), figures, number words, prices, fact placeholders
 * and status wording (`CREATIVE_UNSUPPORTED_CLAIM`), promises and the
 * profile's prohibited wording (`CREATIVE_PROHIBITED_LANGUAGE`), all with the
 * banner copy's rules, and links: an explicit link
 * (`CREATIVE_LINK_NOT_ALLOWED`) or a bare host that may also be a name
 * (`LINK_UNVERIFIED`, left for the owner as in the body, R49). A CTA that is
 * the mission's `opts.cta` is campaign copy and not checked for claims or
 * wording.
 */
export function creativeCopyProblems(
  copy: unknown,
  limits: CopyLimits,
  opts: { cta: unknown },
) {
  const text = everyLayer(copy);
  if (
    !text ||
    !text.headline.trim() ||
    LAYERS.some(
      (field) =>
        text[field].length > limits[field] || UNDRAWABLE.test(text[field]),
    )
  )
    return [CREATIVE_TEXT_MISSING];
  if (unsafeText(allCopy(text))) return [CREATIVE_TEXT_UNSAFE];
  const problems: string[] = [];
  const checked = checkedCopy(text, opts.cta, limits.cta);
  if (statesUnsupportedClaim(checked))
    problems.push(CREATIVE_UNSUPPORTED_CLAIM);
  if (statesProhibitedLanguage(checked))
    problems.push(CREATIVE_PROHIBITED_LANGUAGE);
  for (const link of bodyLinkProblems(allCopy(text), []))
    problems.push(
      link === "LINK_NOT_ALLOWED" ? CREATIVE_LINK_NOT_ALLOWED : link,
    );
  return problems;
}

/**
 * The copywriter's revision instruction for image copy: write the missing
 * copy within the template's limits, or remove the words an image cannot
 * carry, naming them. Nothing new.
 */
export function creativeCopyInstruction(
  value: unknown,
  problems: string[],
  limits: CopyLimits,
  cta: unknown,
) {
  const text = everyLayer(value);
  const parts: string[] = [];
  if (problems.includes(CREATIVE_TEXT_MISSING)) {
    const sizes = text
      ? ` (now ${text.headline.length}, ${text.eyebrow.length} and ${text.subline.length} characters)`
      : "";
    // The CTA is the mission's, set by Orbit: not the copywriter's to write.
    parts.push(
      `write it as plain single lines within the limits: a headline of at most ${limits.headline} characters, an eyebrow of at most ${limits.eyebrow} and a subline of at most ${limits.subline}, each of them may be empty except the headline${sizes}`,
    );
  }
  if (
    problems.includes(CREATIVE_UNSUPPORTED_CLAIM) ||
    problems.includes(CREATIVE_PROHIBITED_LANGUAGE)
  ) {
    const words = text
      ? copyOffenses(checkedCopy(text, cta, limits.cta))
          .map((word) => `"${word}"`)
          .join(", ")
      : "";
    parts.push(
      `remove ${words || "the claim"}: the image states no figure, number word, percentage, status such as live or launch, promise, return or advice (the body carries the facts)`,
    );
  }
  return `Fix the creative copy: ${parts.join("; ")}. Edit previousCreative only for this, keep its meaning otherwise, and add no new claim, figure or link.`;
}

/** The fact claims of a social draft longer than a social post may carry (`SOCIAL_FACT_MAX`). */
function longSocialFacts(content: Record<string, any>) {
  if (content.type !== "social" || !Array.isArray(content.claims)) return [];
  return (content.claims as Array<Record<string, unknown>>)
    .filter((claim) => claim?.kind === "fact")
    .map((claim) => String(claim.text ?? ""))
    .filter((text) => text.length > SOCIAL_FACT_MAX);
}

/**
 * Deterministic problems of a draft written with copy craft (only when
 * `content.copyCraft === true`): no core message (`CORE_MESSAGE_MISSING`), or
 * a fact claim in a social body longer than `SOCIAL_FACT_MAX` characters, a
 * knowledge-base description rather than a fact a post can carry
 * (`FACT_TOO_LONG_FOR_SOCIAL`). Both are revised once (`COPY_CRAFT_REVISABLE`).
 */
export function copyCraftProblems(content: Record<string, any>) {
  if (content.copyCraft !== true) return [];
  const problems: string[] = [];
  if (typeof content.coreMessage !== "string" || !content.coreMessage.trim())
    problems.push(CORE_MESSAGE_MISSING);
  if (longSocialFacts(content).length) problems.push(FACT_TOO_LONG_FOR_SOCIAL);
  return problems;
}

/**
 * The copywriter's revision instruction for copy craft problems: return the
 * core message, or replace each long fact (quoted by its start) with a
 * shorter one or none.
 */
export function copyCraftInstruction(
  content: Record<string, any>,
  problems: string[],
) {
  const parts: string[] = [];
  if (problems.includes(CORE_MESSAGE_MISSING))
    parts.push(
      "return coreMessage: the post's one core message as one sentence of at most 160 characters, not copied from the body",
    );
  if (problems.includes(FACT_TOO_LONG_FOR_SOCIAL)) {
    const facts = longSocialFacts(content)
      .map(
        (text) =>
          `"${text.slice(0, 60).trimEnd()}…" (${text.length} characters)`,
      )
      .join(", ");
    parts.push(
      `replace ${facts || "the long fact"}: a description this long does not fit a social post; remove its fact placeholder and use a supplied fact with a short value instead, or none`,
    );
  }
  return `Fix the post: ${parts.join("; ")}. Keep the post's message, its hook and the intendedPrimaryCta, and add no new claim, figure or link.`;
}

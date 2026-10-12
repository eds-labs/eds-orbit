import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import {
  BANNER_TEXT_LIMITS,
  BANNER_TEXT_MAX,
  bannerTextOverflow,
  type BannerText,
} from "../../../../../packages/creative/src/index.ts";
import { data, DomainError, hash } from "../../shared.ts";
import {
  currentMarketingProfile,
  PROHIBITED_LANGUAGE,
} from "../marketing-profile.ts";

/**
 * Assignment banners in the brand style (R78). An assignment with `banner`
 * gets one 16:9 banner per slot instead of a free image: the run's visual
 * step generates one background (art only: no text, no logos, no persons)
 * from the banner style, and Orbit composes each slot's banner over it with
 * the fixed `brand_landscape` template of packages/creative: the approved
 * logo, the wordmark, the copywriter's banner text and the footer domain of
 * the post's official link. The banner text is reviewed content: the
 * deterministic checks below run on it next to the body's, and the review
 * model sees it with the draft.
 */
export const assignmentBanner = z
  .object({
    template: z.enum(["brand_landscape"]),
    // The owner's own style notes for the background; absent = the default style.
    style: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type AssignmentBanner = z.infer<typeof assignmentBanner>;

/** The banner copy the copywriter writes per post (stored on the content as `banner`). */
export const bannerText = z
  .object({
    headline1: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    headline2: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    subline: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    button: z.string().trim().min(1).max(BANNER_TEXT_MAX),
  })
  .strict();

export { BANNER_TEXT_LIMITS };

/**
 * The default background style: Mario's banners on @uLiquid_desk. Only the
 * art; the headline, logo, button and domain are composed by Orbit.
 */
export const DEFAULT_BANNER_STYLE = [
  "Wide 16:9 background art for a fintech product banner.",
  "Deep dark navy background (#040B1A to #0B1D3A) with subtle cyan (#22D3EE) light waves flowing across the lower half and a soft cyan glow on the right.",
  "Right half: a cluster of three or four frosted glass cards (translucent dark navy glass, thin glowing cyan edges, rounded corners), each holding one simple cyan line icon (for example a chart monitor, a sparkle, a robot head, a paper plane), connected by thin glowing cyan lines to an empty space in the centre of the right half where a separate logo card is placed later.",
  "Left half: calm and dark, nearly empty, so large headline text can be placed over it later.",
  "Clean, premium, minimal, high contrast; no text, no letters, no numbers, no labels, no logos, no brand marks, no people.",
].join(" ");

/** The visual step's prompt for the run's banner background. */
export function bannerBackgroundPrompt(banner: AssignmentBanner) {
  return [
    DEFAULT_BANNER_STYLE,
    ...(banner.style ? [`Owner's style notes: ${banner.style}`] : []),
  ].join("\n");
}

export const BANNER_LOGO_REQUIRED = "BANNER_LOGO_REQUIRED";
export const BANNER_TEXT_MISSING = "BANNER_TEXT_MISSING";
export const BANNER_TEXT_OVERFLOW = "BANNER_TEXT_OVERFLOW";
export const BANNER_UNSUPPORTED_CLAIM = "BANNER_UNSUPPORTED_CLAIM";
export const BANNER_PROHIBITED_LANGUAGE = "BANNER_PROHIBITED_LANGUAGE";
export const BANNER_LINK_NOT_OFFICIAL = "BANNER_LINK_NOT_OFFICIAL";
export const BANNER_IMAGE_MISSING = "BANNER_IMAGE_MISSING";

/**
 * The marketing profile's approved logo for a banner: the profile's
 * `visualIdentity.logoAssetId`, an approved logo asset (never a generated
 * one). Throws `BANNER_LOGO_REQUIRED` without one.
 */
export async function approvedBannerLogo(tx: DbTx, scope: Scope) {
  const profileRow = await currentMarketingProfile(tx, scope);
  const profile = profileRow
    ? marketingProfile.safeParse(profileRow.data)
    : null;
  const logoId = profile?.success
    ? profile.data.visualIdentity.logoAssetId
    : undefined;
  if (!profile?.success || !logoId)
    throw new DomainError(BANNER_LOGO_REQUIRED, 409);
  const row = await tx.entity.findFirst({
    where: {
      id: logoId,
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  const d = data(row);
  if (
    !row ||
    d.usageApproved !== true ||
    d.assetStatus !== "approved" ||
    !["logo", "original_logo"].includes(String(d.type)) ||
    (d.type === "logo" &&
      !["image/png", "image/jpeg", "image/webp"].includes(String(d.mime)))
  )
    throw new DomainError(BANNER_LOGO_REQUIRED, 409);
  return {
    row,
    profileVersion: profileRow!.version,
    productName: profile.data.productName,
    officialLinks: profile.data.officialLinks,
  };
}

/** The domain a banner names: the host of the post's official link, without `www.`. */
export function footerDomain(url: unknown) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/** All banner fields as one text (for link checks). */
export const bannerCopy = (text: BannerText) =>
  [text.headline1, text.headline2, text.subline, text.button].join("\n");

/** The banner text as stored, or null when it is missing or malformed. */
export function parsedBanner(value: unknown): BannerText | null {
  const parsed = bannerText.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Identity of the banner copy and what the template adds to it. */
export const bannerTextHash = (
  text: BannerText,
  brandName: string,
  footer: string,
) => hash({ text, brandName, footer });

// A figure, price, fact placeholder or status on a banner is a claim the
// claims ledger cannot back there (the body carries the facts).
const FIGURE = /\p{Nd}|\{\{\s*fact:/iu;
const STATUS =
  /\b(?:live|launch(?:ed|es)?|released|coming soon|available now|now available|sold out|presale)\b/iu;
const PROMISE =
  /\b(?:profits?|profitable|guarantee[ds]?|risk[- ]free|passive income|returns?|financial advice|investment advice)\b/iu;

/**
 * Deterministic problems of a draft's banner text (R78): missing or
 * malformed text, copy that does not fit the template (revised like a
 * format problem), and claims a banner cannot carry: figures, prices, fact
 * placeholders and status wording (`BANNER_UNSUPPORTED_CLAIM`), profit,
 * return or risk promises and the profile's prohibited wording
 * (`BANNER_PROHIBITED_LANGUAGE`). Links are checked by the caller with the
 * policy's origins, like the body's.
 */
export function bannerTextProblems(
  value: unknown,
  layout: { brandName: string; footer: string },
) {
  const text = parsedBanner(value);
  if (!text) return [BANNER_TEXT_MISSING];
  const problems: string[] = [];
  const copy = bannerCopy(text);
  let overflow: boolean;
  try {
    overflow = bannerTextOverflow(text, layout.brandName, layout.footer);
  } catch {
    // Copy the template refuses outright (control characters) counts as missing.
    return [BANNER_TEXT_MISSING];
  }
  if (FIGURE.test(copy) || STATUS.test(copy))
    problems.push(BANNER_UNSUPPORTED_CLAIM);
  if (PROMISE.test(copy) || PROHIBITED_LANGUAGE.some((rule) => rule.test(copy)))
    problems.push(BANNER_PROHIBITED_LANGUAGE);
  if (overflow) problems.push(BANNER_TEXT_OVERFLOW);
  return problems;
}

/** The copywriter's revision instruction for a banner that does not fit: shorten, nothing new. */
export function bannerInstruction(value: unknown) {
  const text = parsedBanner(value);
  const sizes = text
    ? ` (now ${text.headline1.length}, ${text.headline2.length}, ${text.subline.length} and ${text.button.length} characters)`
    : "";
  return `Shorten the banner text so it fits the banner: headline1 at most ${BANNER_TEXT_LIMITS.headline1} characters, headline2 at most ${BANNER_TEXT_LIMITS.headline2}, subline at most ${BANNER_TEXT_LIMITS.subline} and button at most ${BANNER_TEXT_LIMITS.button}${sizes}, with no word longer than 11 characters in a headline. Keep its meaning, and add no new claim, figure or link.`;
}

/** The banner template a mission was written for, or null without a banner. */
export const bannerTemplateOf = (mission: Record<string, any> | null) =>
  mission?.bannerTemplate === "brand_landscape"
    ? ("brand_landscape" as const)
    : null;

/** The official link of a post as its banner shows it, or null when the link is not official. */
export function officialFooter(
  targetUrl: unknown,
  officialLinks: Array<{ url: string }>,
  allowedOrigins: string[],
) {
  if (typeof targetUrl !== "string") return null;
  if (!officialLinks.some((link) => link.url === targetUrl)) return null;
  try {
    if (!allowedOrigins.includes(new URL(targetUrl).origin)) return null;
  } catch {
    return null;
  }
  return footerDomain(targetUrl);
}

import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import {
  BANNER_TEXT_LIMITS,
  BANNER_TEXT_MAX,
  bannerButtonFits,
  bannerChromeOverflow,
  bannerTextOverflow,
  type BannerText,
} from "../../../../../../packages/creative/src/index.ts";
import { data, DomainError } from "../../../shared.ts";
import {
  currentMarketingProfile,
  PROHIBITED_LANGUAGE,
} from "../brand/marketing-profile.ts";

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

/**
 * The banner copy the copywriter writes per post (stored on the content as
 * `banner`). Its button is the mission CTA, set by Orbit (`withCtaButton`);
 * empty when the CTA does not fit, and the banner then has no button.
 */
export const bannerText = z
  .object({
    headline1: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    headline2: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    subline: z.string().trim().min(1).max(BANNER_TEXT_MAX),
    button: z.string().trim().max(BANNER_TEXT_MAX),
  })
  .strict();

/**
 * The banner button for a mission's CTA (its `targetAction`): the CTA
 * without closing punctuation when it fits the template, else empty (no
 * button). A banner thus never names another call to action than its post.
 */
export function ctaButton(cta: unknown) {
  const label = ctaLabel(cta);
  return bannerButtonFits(label) ? label : "";
}

/** A CTA as a label on an image: without closing punctuation; empty without a CTA. */
export function ctaLabel(cta: unknown) {
  return typeof cta === "string" ? cta.replace(/[\s\p{P}]+$/u, "").trim() : "";
}

/** Banner copy with its button set to the mission CTA (`ctaButton`). */
export function withCtaButton<T extends { button: string }>(
  text: T,
  cta: unknown,
): T {
  return { ...text, button: ctaButton(cta) };
}

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
// The post's official link is outside the policy's allowed origins.
export const BANNER_LINK_NOT_ALLOWED = "BANNER_LINK_NOT_ALLOWED";
export const BANNER_IMAGE_MISSING = "BANNER_IMAGE_MISSING";
// The wordmark or the footer domain does not fit: the profile's, not the copy's.
export const BANNER_BRAND_OVERFLOW = "BANNER_BRAND_OVERFLOW";
// Invisible characters or letters of another script (homoglyphs) in the copy.
export const BANNER_TEXT_UNSAFE = "BANNER_TEXT_UNSAFE";
// Composing this draft's banner failed (render error); recorded on the draft.
export const BANNER_RENDER_FAILED = "BANNER_RENDER_FAILED";
// The draft's own channel cannot carry the image (media or caption limit).
export const BANNER_MEDIA_REFUSED = "BANNER_MEDIA_REFUSED";
/** Banner problems one deterministic revision of the copy may fix (round 1 only). */
export const BANNER_REVISABLE = new Set([
  BANNER_TEXT_OVERFLOW,
  BANNER_UNSUPPORTED_CLAIM,
  BANNER_PROHIBITED_LANGUAGE,
]);

/** What a composed banner shows besides the copy: the product name and the logo's identity. */
export type BannerBrand = {
  productName: string;
  logoId: string;
  // The logo's bytes (stored SHA-256): a new version with the same bytes is the same logo.
  logoSha256: string;
};

/**
 * The marketing profile's approved logo for a banner: the profile's
 * `visualIdentity.logoAssetId`, an approved uploaded raster logo (type
 * `logo` with its SHA-256; never generated, and never the bundled EDS mark
 * of `original_logo`). Throws `BANNER_LOGO_REQUIRED` without one.
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
    d.type !== "logo" ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(d.mime)) ||
    !/^[0-9a-f]{64}$/iu.test(String(d.sha256 ?? ""))
  )
    throw new DomainError(BANNER_LOGO_REQUIRED, 409);
  return {
    row,
    profileVersion: profileRow!.version,
    productName: profile.data.productName,
    officialLinks: profile.data.officialLinks,
    brand: {
      productName: profile.data.productName,
      logoId: row.id,
      logoSha256: String(d.sha256).toLowerCase(),
    } satisfies BannerBrand,
  };
}

/**
 * Refuses a banner the profile cannot carry (R78): no approved logo
 * (`BANNER_LOGO_REQUIRED`), no official link the policy allows
 * (`BANNER_LINK_NOT_ALLOWED`), or a product name or official link domain that
 * does not fit the template (`BANNER_BRAND_OVERFLOW`); the copywriter cannot
 * fix either. The domains checked are the format's link, else every official
 * link the policy allows (any may become the post's link).
 */
export async function assertBannerReady(
  tx: DbTx,
  scope: Scope,
  cta: string | undefined,
  allowedOrigins: string[],
) {
  const logo = await approvedBannerLogo(tx, scope);
  const links = cta
    ? [cta]
    : logo.officialLinks
        .map((link) => link.url)
        .filter((url) => {
          try {
            return allowedOrigins.includes(new URL(url).origin);
          } catch {
            return false;
          }
        });
  // No official link the policy allows: nothing the button and footer may name.
  if (!links.length) throw new DomainError(BANNER_LINK_NOT_ALLOWED, 409);
  if (
    links.some((url) =>
      bannerChromeOverflow(logo.productName, footerDomain(url) ?? ""),
    )
  )
    throw new DomainError(BANNER_BRAND_OVERFLOW, 409);
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

// A figure, price, fact placeholder or status on a banner is a claim the
// claims ledger cannot back there (the body carries the facts). Checked on
// the NFKC form, so full-width digits and the like count too.
const FIGURE =
  /\p{N}+|[%‰]|\{\{\s*fact:[^}]*\}?\}?|\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|percent|per cent|dozens?|half|double|triple|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|zwölf|zwanzig|dreißig|hundert|tausend|million(?:en)?|milliarden?|prozent|doppelt|halb)\b/giu;
const STATUS =
  /\b(?:live|launch(?:ed|es)?|released|coming soon|available now|now available|sold out|presale)\b/giu;
const PROMISE =
  /\b(?:profits?|profitable|guarantee[ds]?|risk[- ]free|passive income|returns?|financial advice|investment advice)\b/giu;
// Invisible format characters (zero-width space, joiner, soft hyphen, BOM, bidi marks).
const INVISIBLE = /\p{Cf}/u;

/** Whether `rule` matches `copy` (case-insensitively, as the copy checks read it). */
const hits = (rule: RegExp, copy: string) =>
  new RegExp(rule.source, "iu").test(copy);

/**
 * Whether image copy (NFKC) states a figure, number word, percentage, price,
 * fact placeholder or status: a claim the image cannot back. The rules of
 * banner copy (R78), shared with a creative's image copy.
 */
export const statesUnsupportedClaim = (copy: string) =>
  hits(FIGURE, copy) || hits(STATUS, copy);

/** Whether image copy (NFKC) promises profit, returns or no risk, or uses the profile's prohibited wording. */
export const statesProhibitedLanguage = (copy: string) =>
  hits(PROMISE, copy) || PROHIBITED_LANGUAGE.some((rule) => hits(rule, copy));

/**
 * The copy the claim and wording checks read: without the button when it
 * is the mission's approved CTA, which is campaign copy and no claim (as in
 * checkClaims).
 */
const checkedCopy = (text: BannerText, cta?: unknown) =>
  (text.button && text.button === ctaButton(cta)
    ? [text.headline1, text.headline2, text.subline].join("\n")
    : bannerCopy(text)
  ).normalize("NFKC");

/**
 * Copy that could hide a claim from the checks: invisible format
 * characters, or letters outside the Latin script (Cyrillic or Greek look-
 * alikes); the copy is written in English or German.
 */
function unsafeCopy(text: BannerText) {
  return unsafeText(bannerCopy(text));
}

/** Image copy with invisible format characters or letters outside the Latin script (`unsafeCopy`). */
export function unsafeText(raw: string) {
  if (INVISIBLE.test(raw)) return true;
  return [...raw.normalize("NFKC").matchAll(/\p{L}/gu)].some(
    ([letter]) => !/\p{Script=Latin}/u.test(letter!),
  );
}

/** The words of a banner's copy that a banner cannot carry, for the revision instruction. */
export function bannerOffenses(value: unknown, cta?: unknown) {
  const text = parsedBanner(value);
  if (!text) return [];
  return copyOffenses(checkedCopy(text, cta));
}

/** The words of image copy (NFKC) that an image cannot carry: figures, status, promises and prohibited wording. */
export function copyOffenses(copy: string) {
  const found = [FIGURE, STATUS, PROMISE, ...PROHIBITED_LANGUAGE].flatMap(
    (rule) =>
      [
        ...copy.matchAll(
          new RegExp(
            rule.source,
            rule.flags.includes("g") ? rule.flags : `${rule.flags}g`,
          ),
        ),
      ].map((match) => match[0]),
  );
  return [...new Set(found)];
}

/**
 * Deterministic problems of a draft's banner text (R78): missing or
 * malformed text, invisible or non-Latin characters
 * (`BANNER_TEXT_UNSAFE`), a product name or domain that cannot fit
 * (`BANNER_BRAND_OVERFLOW`), copy that does not fit the template
 * (`BANNER_TEXT_OVERFLOW`), figures, number words, prices, fact placeholders
 * and status wording (`BANNER_UNSUPPORTED_CLAIM`), profit, return or risk
 * promises and the profile's prohibited wording
 * (`BANNER_PROHIBITED_LANGUAGE`). The last three are revised once
 * (`BANNER_REVISABLE`). A button that is the mission's `cta` is campaign
 * copy and not checked for claims or wording. Links are checked by the
 * caller with the policy's origins, like the body's.
 */
export function bannerTextProblems(
  value: unknown,
  layout: { brandName: string; footer: string; cta?: unknown },
) {
  const text = parsedBanner(value);
  if (!text) return [BANNER_TEXT_MISSING];
  if (unsafeCopy(text)) return [BANNER_TEXT_UNSAFE];
  const problems: string[] = [];
  const chrome = bannerChromeOverflow(layout.brandName, layout.footer);
  if (chrome) problems.push(BANNER_BRAND_OVERFLOW);
  let overflow: boolean;
  try {
    // Copy is measured against a neutral wordmark and domain when those are the problem.
    overflow = chrome
      ? bannerTextOverflow(text)
      : bannerTextOverflow(text, layout.brandName, layout.footer);
  } catch {
    // Copy the template refuses outright (control characters) counts as missing.
    return [BANNER_TEXT_MISSING];
  }
  const copy = checkedCopy(text, layout.cta);
  if (statesUnsupportedClaim(copy)) problems.push(BANNER_UNSUPPORTED_CLAIM);
  if (statesProhibitedLanguage(copy)) problems.push(BANNER_PROHIBITED_LANGUAGE);
  if (overflow) problems.push(BANNER_TEXT_OVERFLOW);
  return problems;
}

/**
 * The copywriter's revision instruction for banner copy (R78): shorten it,
 * and remove the words a banner cannot carry, naming them. Nothing new.
 */
export function bannerInstruction(
  value: unknown,
  problems: string[],
  cta?: unknown,
) {
  const text = parsedBanner(value);
  const parts: string[] = [];
  if (problems.includes(BANNER_TEXT_OVERFLOW)) {
    const sizes = text
      ? ` (now ${text.headline1.length}, ${text.headline2.length} and ${text.subline.length} characters)`
      : "";
    // The button is the mission CTA, set by Orbit: not the copywriter's to shorten.
    parts.push(
      `shorten it to fit: headline1 at most ${BANNER_TEXT_LIMITS.headline1} characters, headline2 at most ${BANNER_TEXT_LIMITS.headline2} and subline at most ${BANNER_TEXT_LIMITS.subline}${sizes}, with no headline word longer than 11 characters`,
    );
  }
  if (
    problems.includes(BANNER_UNSUPPORTED_CLAIM) ||
    problems.includes(BANNER_PROHIBITED_LANGUAGE)
  ) {
    const words = bannerOffenses(value, cta)
      .map((word) => `"${word}"`)
      .join(", ");
    parts.push(
      `remove ${words || "the claim"}: a banner states no figure, number word, percentage, status such as live or launch, promise, return or advice (the body carries the facts)`,
    );
  }
  return `Fix the banner copy: ${parts.join("; ")}. Edit previousBanner only for this, keep its meaning otherwise, and add no new claim, figure or link.`;
}

/** The banner template a mission was written for, or null without a banner. */
export const bannerTemplateOf = (mission: Record<string, any> | null) =>
  mission?.bannerTemplate === "brand_landscape"
    ? ("brand_landscape" as const)
    : null;

/**
 * Why a post's link cannot be named on its banner, or null: not one of the
 * profile's official links (`BANNER_LINK_NOT_OFFICIAL`), or official but
 * outside the policy's allowed origins (`BANNER_LINK_NOT_ALLOWED`).
 */
export function bannerLinkProblem(
  targetUrl: unknown,
  officialLinks: Array<{ url: string }>,
  allowedOrigins: string[],
) {
  if (
    typeof targetUrl !== "string" ||
    !officialLinks.some((link) => link.url === targetUrl)
  )
    return BANNER_LINK_NOT_OFFICIAL;
  return officialFooter(targetUrl, officialLinks, allowedOrigins)
    ? null
    : BANNER_LINK_NOT_ALLOWED;
}

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

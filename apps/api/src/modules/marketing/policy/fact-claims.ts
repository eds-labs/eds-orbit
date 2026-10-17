import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";

/**
 * Product words a fact sentence may contain without adding a claim, for a
 * marketing profile without its own `brandTerms` (WP3.4): uLiquid's, which
 * were built into the matcher before.
 */
export const LEGACY_BRAND_TERMS: readonly string[] = [
  "uliquid",
  "uliq",
  "desk",
];

/** The profile's brand terms, else the legacy list. */
export function brandTermsOf(profile: unknown): readonly string[] {
  const terms = (profile as { brandTerms?: unknown } | null)?.brandTerms;
  return Array.isArray(terms) && terms.length
    ? terms.map((term) => String(term).toLocaleLowerCase())
    : LEGACY_BRAND_TERMS;
}

/** The project's brand terms, read from its marketing profile. */
export async function loadBrandTerms(tx: DbTx, scope: Scope) {
  const profile = await tx.projectMarketingProfile.findFirst({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    select: { data: true },
  });
  return brandTermsOf(profile?.data ?? null);
}

// The presale status pattern from before WP3.4, kept verbatim for profiles
// without brandTerms so their checks cannot change.
const LEGACY_PRESALE_LIVE =
  /\b(?:presale\s+(?:is\s+)?(?:(?:now|currently|officially)\s+)?live|(?:(?:now|currently|officially)\s+)?live\s+(?:(?:uliq|uliquid)(?:\s+desk)?\s+)?presale|presale[.\s]+status:\s*live)\b/gi;

/**
 * A "presale is live" statement: the legacy pattern without profile terms;
 * with them, up to two product words may stand between "live" and "presale".
 */
export function presaleLivePattern(profileTerms?: readonly string[]): RegExp {
  if (!profileTerms?.length) return new RegExp(LEGACY_PRESALE_LIVE);
  const terms = profileTerms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(
    String.raw`\b(?:presale\s+(?:is\s+)?(?:(?:now|currently|officially)\s+)?live|(?:(?:now|currently|officially)\s+)?live\s+(?:(?:${terms})\s+){0,2}presale|presale[.\s]+status:\s*live)\b`,
    "gi",
  );
}

// Words that turn a clause into its opposite ("isn't" splits into "isn" and "t").
const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "without",
  "isn",
  "aren",
  "doesn",
  "don",
  "t",
]);
/** Accept a literal fact rendering or a bounded natural sentence with its value and subject. */
export function factClaimMatches(
  text: string,
  fact: Record<string, any>,
  brandTerms: readonly string[] = LEGACY_BRAND_TERMS,
): boolean {
  const value = String(fact.value?.amount ?? fact.value ?? "").trim();
  const key = String(fact.key ?? "").trim();
  if (!value || !key) return false;
  const suffix = fact.currency
    ? ` ${fact.currency}`
    : fact.unit
      ? ` ${fact.unit}`
      : "";
  if (text === `${key}: ${value}` || text === `${key}: ${value}${suffix}`)
    return true;
  // A verbatim quote of a multi-word verified value is supported as written.
  const normalized = (s: string) =>
    s.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (/\s/.test(value) && normalized(text) === normalized(value)) return true;

  const keyTokens = key.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
  const subjectTokens = keyTokens.filter(
    (token) =>
      token.length >= 3 && !["status", "value", "fact"].includes(token),
  );
  const claimTokens = new Set(
    text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u),
  );
  if (
    !subjectTokens.length ||
    !subjectTokens.some((token) => claimTokens.has(token))
  )
    return false;
  const allowed = new Set([
    ...keyTokens,
    ...value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u),
    ...String(fact.currency ?? "")
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u),
    ...String(fact.unit ?? "")
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u),
    "the",
    "a",
    "an",
    "is",
    "are",
    "now",
    "currently",
    "officially",
    // The product's own name (the profile's brandTerms).
    ...brandTerms,
    // Words that join the subject and the value without adding a claim;
    // "s" is the possessive ("Desk's").
    "s",
    "of",
    "for",
    "to",
    "in",
    "on",
    "with",
    "by",
    "and",
    "its",
    "their",
    "your",
  ]);
  // A negation that belongs to the subject ("no_profit_guarantee") is not one.
  const negated = [...claimTokens].some(
    (token) => NEGATIONS.has(token) && !keyTokens.includes(token),
  );
  // A true or false fact is stated as a plain clause: false needs a
  // negation, true must not have one, and the bare word is not required.
  const polarity = value.toLocaleLowerCase();
  if (polarity === "true" || polarity === "false") {
    if (
      [...claimTokens].some(
        (token) => token && !allowed.has(token) && !NEGATIONS.has(token),
      )
    )
      return false;
    return polarity === "false" ? negated : !negated;
  }
  if ([...claimTokens].some((token) => token && !allowed.has(token)))
    return false;
  // Hyphens, underscores and spaces inside the value are interchangeable.
  const pattern = value
    .split(/[-_\s]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[-_\\s]+");
  if (
    !new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(
      text,
    )
  )
    return false;
  if (
    fact.currency &&
    !claimTokens.has(String(fact.currency).toLocaleLowerCase()) &&
    !(fact.currency === "EUR" && text.includes("€")) &&
    !(fact.currency === "USD" && text.includes("$"))
  )
    return false;
  if (fact.unit && !claimTokens.has(String(fact.unit).toLocaleLowerCase()))
    return false;
  return true;
}

/**
 * The copywriter's revision instruction for fact claims that do not match
 * their facts (`FACT_VALUE_MISMATCH`): each claim with its fact's key and
 * value, and how to write it so the matcher above accepts it.
 */
export function factMismatchInstruction(
  mismatches: ReadonlyArray<{ claim: string; key: string; value: string }>,
) {
  const listed = mismatches
    .map(({ claim, key, value }) => `"${claim}" (fact ${key} = ${value})`)
    .join("; ");
  return `Fix the fact claims that do not match their verified facts: ${listed}. Write each of them again as its fact placeholder; for a true or false fact, as one plain clause with words from the fact key and no word that is not in the fact key (with not or no when the value is false), and record exactly that clause as the claim. Keep the rest of the post and add no new claim, figure or link.`;
}

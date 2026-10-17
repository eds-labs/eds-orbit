import { PROHIBITED_LANGUAGE } from "../brand/marketing-profile.ts";

/** The conflict reported for a value with the profile's prohibited wording. */
export const PROHIBITED_FACT_LANGUAGE = "PROHIBITED_LANGUAGE";

// A guardrail that starts like this forbids what follows it.
const BAN =
  /^(?:no|never|avoid|don't|do not|must not|keine?|nicht|niemals)\s+(.+)$/iu;
// Words of a ban that say how something is forbidden, not what: they are
// left out, so "No webhook promotion" forbids "webhook" and "No unsupported
// claims" forbids no subject of its own.
const GENERIC = new Set([
  "a",
  "about",
  "advertise",
  "advertising",
  "an",
  "any",
  "as",
  "claim",
  "content",
  "feature",
  "for",
  "functionality",
  "in",
  "integration",
  "like",
  "mention",
  "mentioning",
  "of",
  "on",
  "post",
  "promo",
  "promote",
  "promoting",
  "promotion",
  "reference",
  "statement",
  "such",
  "support",
  "the",
  "to",
  "unsupported",
  "unverified",
  "use",
  "using",
  "with",
  "word",
  "wording",
  // German
  "aussage",
  "bewerben",
  "der",
  "die",
  "das",
  "erwähnen",
  "erwähnung",
  "für",
  "über",
  "von",
  "werbung",
]);

/** Lower-case words without a plural "s" ("webhooks" and "webhook" are one word). */
const words = (text: string) =>
  (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) =>
    word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word,
  );

/**
 * The subjects a guardrail forbids: for a ban ("No webhook promotion", "Do
 * not promote webhooks or API keys"), each alternative after the ban word
 * as its non-generic words; nothing for any other rule.
 */
function forbiddenSubjects(guardrail: string) {
  const ban = guardrail
    .trim()
    .replace(/[.!;:]+$/u, "")
    .match(BAN);
  if (!ban) return [];
  return ban[1]!
    .split(/,|\/|\bor\b|\band\b|\boder\b|\bund\b/iu)
    .map((part) => words(part).filter((word) => !GENERIC.has(word)))
    .filter((subject) => subject.length);
}

/**
 * Why a fact's value may not be offered for a post, or null: the guardrail
 * whose forbidden subject it names (every word of one subject), else
 * `PROHIBITED_FACT_LANGUAGE` for the profit, risk and urgency wording no
 * post may carry.
 */
export function factGuardrailConflict(
  value: string,
  guardrails: readonly string[],
) {
  const valueWords = new Set(words(value));
  for (const guardrail of guardrails)
    if (
      forbiddenSubjects(guardrail).some((subject) =>
        subject.every((word) => valueWords.has(word)),
      )
    )
      return guardrail;
  return PROHIBITED_LANGUAGE.some((pattern) => pattern.test(value))
    ? PROHIBITED_FACT_LANGUAGE
    : null;
}

/** The rows whose value has no guardrail conflict, in their order. */
export function withinGuardrails<T>(
  rows: readonly T[],
  guardrails: readonly string[],
  valueOf: (row: T) => string,
) {
  return rows.filter(
    (row) => factGuardrailConflict(valueOf(row), guardrails) === null,
  );
}

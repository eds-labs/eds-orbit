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
    "uliquid",
    "uliq",
    "desk",
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

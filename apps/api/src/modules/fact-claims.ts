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
  ]);
  if ([...claimTokens].some((token) => token && !allowed.has(token)))
    return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(
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

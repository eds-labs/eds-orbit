/**
 * The profile's brandTerms from the editor field (WP3.4): one lower-case
 * word per line; empty leaves the field out, so the server keeps the
 * built-in uLiquid words.
 */
export function brandTermsField(raw: string): { brandTerms?: string[] } {
  const terms = [
    ...new Set(
      raw
        .split("\n")
        .map((term) => term.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
  return terms.length ? { brandTerms: terms } : {};
}

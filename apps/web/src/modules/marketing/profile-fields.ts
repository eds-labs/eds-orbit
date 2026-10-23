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

export type OfficialLinkCandidate = {
  /** The form field's name. */
  key: string;
  label: string;
  url: string;
  factId: string;
  checked: boolean;
};
type FactLike = { id: string; data: Record<string, unknown> };

const factUrl = (fact: FactLike) => {
  const v = fact.data.value as unknown;
  return String(
    (v && typeof v === "object" && "amount" in v
      ? (v as { amount: unknown }).amount
      : v) ?? "",
  );
};

/**
 * The official target links the profile may choose (plans/project-
 * configuration-i18n.md): every project profile link whose exact address a
 * public, verified fact states, plus the profile's current links that are
 * not (or no longer) project links, so saving never drops one silently.
 * `unverified` are the project links without such a fact.
 */
export function officialLinkCandidates(
  projectLinks: ReadonlyArray<{ label: string; url: string }>,
  current: ReadonlyArray<{ label: string; url: string; factId: string }>,
  facts: readonly FactLike[],
): {
  candidates: OfficialLinkCandidate[];
  unverified: Array<{ label: string; url: string }>;
} {
  const usable = facts.filter(
    (f) => f.data.status === "verified" && f.data.publicUse !== false,
  );
  const candidates: OfficialLinkCandidate[] = [];
  const unverified: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();
  for (const link of projectLinks) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const chosen = current.find((c) => c.url === link.url);
    const fact =
      (chosen && usable.find((f) => f.id === chosen.factId)) ??
      usable.find((f) => factUrl(f) === link.url);
    if (!fact) {
      unverified.push(link);
      continue;
    }
    candidates.push({
      key: `official:${candidates.length}`,
      label: chosen?.label ?? link.label,
      url: link.url,
      factId: fact.id,
      checked: Boolean(chosen),
    });
  }
  for (const link of current) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    candidates.push({
      key: `official:${candidates.length}`,
      label: link.label,
      url: link.url,
      factId: link.factId,
      checked: true,
    });
  }
  return { candidates, unverified };
}

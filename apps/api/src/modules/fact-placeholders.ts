/**
 * The model writes a fact claim as {{fact:<factId>}} and Orbit inserts the
 * exact verified value, so a fact can no longer be paraphrased. Only facts of
 * the draft's own evidence pack resolve; an unknown placeholder stays in the
 * body and claim review reports FACT_PLACEHOLDER_UNRESOLVED.
 */
export const FACT_PLACEHOLDER = /\{\{\s*fact:([A-Za-z0-9-]{1,64})\s*\}\}/g;

type Fact = { id: string; value: unknown };
type Claim = {
  text: string;
  factId?: string;
  chunkId?: string;
  kind: "fact" | "quote" | "style";
};

function insert(text: string, facts: Map<string, string>) {
  return text.replace(FACT_PLACEHOLDER, (match, id: string, offset: number) => {
    const value = facts.get(id);
    if (value === undefined) return match;
    // Avoid doubled sentence punctuation when the model also ended the sentence.
    const next = text[offset + match.length];
    return /[.!?]$/.test(value) && next && /[.!?]/.test(next)
      ? value.slice(0, -1)
      : value;
  });
}

export function resolveFactPlaceholders<
  T extends { body: string; claims: Claim[] },
>(output: T, evidenceFacts: Fact[]): T {
  const facts = new Map(
    evidenceFacts
      .filter((fact) => typeof fact.value === "string" && fact.value.trim())
      .map((fact) => [fact.id, String(fact.value).trim()]),
  );
  const claims = output.claims.map((claim) => {
    const placeholder = [...claim.text.matchAll(FACT_PLACEHOLDER)];
    if (!placeholder.length) return claim;
    const id = placeholder[0]![1]!;
    const value = facts.get(id);
    if (value === undefined) return claim;
    return {
      ...claim,
      kind: "fact" as const,
      factId: claim.factId ?? id,
      text: value,
    };
  });
  return { ...output, body: insert(output.body, facts), claims };
}

export function hasFactPlaceholder(body: string) {
  return new RegExp(FACT_PLACEHOLDER.source).test(body);
}

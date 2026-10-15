/** Share of distinct words that two drafts have in common (Jaccard index). */
export function draftSimilarity(a: string, b: string) {
  const words = (text: string) =>
    new Set(
      text
        .toLocaleLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
  const left = words(a),
    right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Batch drafts at or above this similarity are treated as duplicates. */
export const DUPLICATE_DRAFT_SIMILARITY = 0.8;

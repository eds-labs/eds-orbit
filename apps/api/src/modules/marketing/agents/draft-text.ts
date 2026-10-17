/**
 * Text of a draft that addresses a reviewer or editor instead of the reader:
 * notes ("Note to reviewer", "TODO:"), bracketed or angled directions
 * ("[insert screenshot]", "<add link here>"), elisions ("[...]") and talk
 * about the draft itself ("this draft", "revision instructions"). A post
 * with such text is not finished; the review lets the copywriter revise it
 * once (like a format problem, R77) and rejects a revision that still has it.
 */
export const DRAFT_INSTRUCTION_TEXT = "DRAFT_INSTRUCTION_TEXT";

const DIRECTIVE =
  "insert|add|link|todo|tbd|tk|placeholder|note|image|cta|optional|replace|remove|edit|check|confirm|verify|source|citation|reviewer|editor";
const PATTERNS = [
  // A note for the reviewer, to the end of its line.
  /\bnotes?\s+(?:to|for)\s+(?:the\s+)?(?:reviewers?|editors?|approvers?|team|orbit)\b[^\n]*/giu,
  // A line opened by a working label: "Note:", "TODO:", "Reviewer:".
  /^[ \t]*(?:note|nb|todo|tbd|fixme|placeholder|internal|reviewer|editor)s?\s*:[^\n]*/gimu,
  // A parenthetical note: "(Note: keep this short)".
  /\(\s*(?:note|nb|todo|tbd|reviewer|editor)\b[^)\n]*\)/giu,
  // A bracketed direction or elision: "[insert screenshot]", "[...]", "[…]".
  new RegExp(String.raw`\[\s*(?:\.{3}|…|(?:${DIRECTIVE})\b)[^\]\n]*\]`, "giu"),
  // An angled direction: "<add link here>".
  new RegExp(String.raw`<\s*(?:${DIRECTIVE})\b[^>\n]*>`, "giu"),
  // Talk about the draft and its review instead of the product.
  /\b(?:this|the)\s+draft\b/giu,
  /\brevision\s+instructions?\b/giu,
  /\bper\s+(?:the\s+)?brief\b/giu,
];

/** The passages of a body addressed to a reviewer, each once (a passage inside another counts as that one). */
export function instructionTextOffenses(body: unknown) {
  const text = String(body ?? "");
  const found = [
    ...new Set(
      PATTERNS.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((match) => match[0].trim()),
      ),
    ),
  ];
  return found.filter(
    (offense) =>
      !found.some((other) => other !== offense && other.includes(offense)),
  );
}

/** `DRAFT_INSTRUCTION_TEXT` when the body has text addressed to a reviewer. */
export const instructionTextProblems = (body: unknown) =>
  instructionTextOffenses(body).length ? [DRAFT_INSTRUCTION_TEXT] : [];

/** The copywriter's revision instruction: remove those passages, naming them. */
export function instructionTextInstruction(body: unknown) {
  const passages = instructionTextOffenses(body)
    .map((offense) => `"${offense}"`)
    .join(", ");
  return `Remove the text addressed to a reviewer or editor instead of the reader: ${passages}. The body is the finished post exactly as readers see it, with no notes, bracketed directions, elisions or placeholders. Keep everything else and add no new claim, figure or link.`;
}

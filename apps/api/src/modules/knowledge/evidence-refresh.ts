import type { KnowledgeFile } from "../../../../../packages/schemas/src/knowledge-workspace.ts";

type Citation = { startLine: number; endLine: number; quote: string };

function context(lines: string[], start: number, end: number) {
  while (start > 0 && lines[start - 1]?.trim()) start--;
  while (end < lines.length && lines[end]?.trim()) end++;
  const headings: string[] = [];
  let fence = "";
  for (const line of lines.slice(0, start)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const [, delimiter, suffix] = marker;
      if (!fence) fence = delimiter!;
      else if (
        delimiter![0] === fence[0] &&
        delimiter!.length >= fence.length &&
        !suffix!.trim()
      )
        fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (!heading) continue;
    const level = heading[1]!.length;
    headings.length = Math.min(headings.length, level - 1);
    headings[level - 1] = line;
  }
  return {
    paragraph: lines.slice(start, end).join("\n"),
    headings: headings.join("\n"),
    inCodeBlock: Boolean(fence),
  };
}

/** Only a unique exact quote in unchanged prose and its heading hierarchy may carry forward. */
export function relocateEvidence(
  old: KnowledgeFile,
  next: KnowledgeFile,
  citation: Citation,
) {
  if (
    old.path !== next.path ||
    !citation.quote.trim() ||
    !Number.isInteger(citation.startLine) ||
    !Number.isInteger(citation.endLine)
  )
    return null;
  const before = old.text.split("\n");
  const after = next.text.split("\n");
  const count = citation.endLine - citation.startLine + 1;
  const quote = citation.quote.split("\n");
  if (citation.startLine < 1 || count !== quote.length) return null;
  const original = uniqueQuoteLine(before, quote);
  const match = uniqueQuoteLine(after, quote);
  if (original !== citation.startLine - 1 || match < 0) return null;
  const previous = context(before, citation.startLine - 1, citation.endLine);
  const current = context(after, match, match + count);
  // Tables, lists and code can depend on structure outside a text paragraph.
  if (
    previous.inCodeBlock ||
    current.inCodeBlock ||
    previous.paragraph
      .split("\n")
      .some((line) =>
        /(?:^ {4}|^\t|[|]|^\s*(?:[<>#~`]|[-=]{3,}\s*$|[-*+]\s|\d+\.\s))/.test(line)
      )
  )
    return null;
  if (
    previous.paragraph !== current.paragraph ||
    previous.headings !== current.headings
  )
    return null;
  return { startLine: match + 1, endLine: match + count };
}

function uniqueQuoteLine(lines: string[], quote: string[]) {
  let match = -1;
  for (let i = 0; i <= lines.length - quote.length; i++) {
    if (!quote.every((line, j) => lines[i + j] === line)) continue;
    if (match !== -1) return -1;
    match = i;
  }
  return match;
}

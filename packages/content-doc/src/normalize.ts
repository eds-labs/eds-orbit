import {
  LIMITS,
  MARKS,
  isLineBreak,
  type Block,
  type Inline,
  type ListBlock,
  type Mark,
  type NestedBlock,
  type OrbitDoc,
  type ParagraphBlock,
  type TextRun,
} from "./types.ts";

const MARK_ORDER = new Map<Mark, number>(MARKS.map((mark, index) => [mark, index]));

const sameFormat = (a: TextRun, b: TextRun): boolean =>
  (a.marks ?? []).join() === (b.marks ?? []).join() && a.link?.href === b.link?.href;

/** Canonical inline runs: no empty text, marks deduplicated in canonical order, equal neighbours merged. */
export function canonicalInline(items: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of items) {
    if (isLineBreak(item)) {
      out.push({ type: "break" });
      continue;
    }
    if (item.text.length === 0) continue;
    const run: TextRun = { text: item.text };
    const marks = [...new Set(item.marks ?? [])].sort(
      (a, b) => (MARK_ORDER.get(a) ?? 99) - (MARK_ORDER.get(b) ?? 99),
    );
    if (marks.length) run.marks = marks;
    if (item.link) run.link = { href: item.link.href };
    const previous = out.at(-1);
    if (previous && !isLineBreak(previous) && sameFormat(previous, run)) previous.text += run.text;
    else out.push(run);
  }
  // A trailing or leading line break carries no content.
  while (out.length && isLineBreak(out[0]!)) out.shift();
  while (out.length && isLineBreak(out.at(-1)!)) out.pop();
  return out;
}

const canonicalNested = (blocks: readonly NestedBlock[]): NestedBlock[] =>
  blocks.map((block) => canonicalBlock(block)).filter((block): block is NestedBlock => block !== null);

function canonicalBlock(block: NestedBlock): NestedBlock | null;
function canonicalBlock(block: Block): Block | null;
function canonicalBlock(block: Block): Block | null {
  switch (block.type) {
    case "heading":
    case "paragraph": {
      const content = canonicalInline(block.content);
      return content.length ? { ...block, content } : null;
    }
    case "list": {
      const items = block.items.map(canonicalNested).filter((item) => item.length > 0);
      return items.length ? { type: "list", ordered: block.ordered, items } : null;
    }
    case "quote":
    case "callout": {
      const blocks = canonicalNested(block.blocks);
      if (!blocks.length) return null;
      return block.type === "quote" ? { type: "quote", blocks } : { type: "callout", tone: block.tone, blocks };
    }
    case "code":
      return block.text.length ? { type: "code", language: block.language, text: block.text } : null;
    case "image": {
      const caption = block.caption?.trim();
      return caption ? { type: "image", assetId: block.assetId, caption } : { type: "image", assetId: block.assetId };
    }
    case "divider":
      return { type: "divider" };
  }
}

/**
 * Canonical form used before saving and hashing: empty paragraphs, lists,
 * quotes and code blocks are dropped, inline runs merged and marks ordered.
 * Two documents that render the same have the same canonical JSON.
 */
export function canonicalize(doc: OrbitDoc): OrbitDoc {
  return {
    schema: doc.schema,
    version: doc.version,
    blocks: doc.blocks.map((block) => canonicalBlock(block)).filter((block): block is Block => block !== null),
  };
}

const paragraphsOf = (list: ListBlock): ParagraphBlock[] =>
  list.items.flatMap((item) => item.flatMap((child) => (child.type === "list" ? paragraphsOf(child) : [child])));

/** All items of a list as paragraph-only items, nested items following their parent. */
const flatItems = (list: ListBlock): NestedBlock[][] =>
  list.items.flatMap((item) => {
    const own = item.filter((child): child is ParagraphBlock => child.type === "paragraph");
    const nested = item.flatMap((child) => (child.type === "list" ? flatItems(child) : []));
    return own.length ? [own, ...nested] : nested;
  });

export interface FitResult {
  doc: OrbitDoc;
  /** Number of lists that were flattened to fit the depth limit. */
  flattened: number;
}

/**
 * Flattens lists nested deeper than {@link LIMITS.depth} allows, so pasted
 * content never yields a document the server refuses: an overflowing nested
 * list becomes sibling items of its parent list; a list that cannot be a list
 * at all becomes paragraphs.
 */
export function fitNesting(doc: OrbitDoc, maxDepth: number = LIMITS.depth): FitResult {
  let flattened = 0;

  const fitList = (list: ListBlock, depth: number): ListBlock => {
    const items: NestedBlock[][] = [];
    for (const item of list.items) {
      const kept: NestedBlock[] = [];
      const hoisted: NestedBlock[][] = [];
      for (const child of item) {
        if (child.type === "paragraph") kept.push(child);
        else if (depth + 2 > maxDepth) {
          flattened += 1;
          hoisted.push(...flatItems(child));
        } else kept.push(fitList(child, depth + 1));
      }
      if (kept.length) items.push(kept);
      items.push(...hoisted);
    }
    return { type: "list", ordered: list.ordered, items };
  };

  const fitChildren = (blocks: readonly NestedBlock[], depth: number): NestedBlock[] =>
    blocks.flatMap((block): NestedBlock[] => {
      if (block.type === "paragraph") return [block];
      if (depth + 1 > maxDepth) {
        flattened += 1;
        return paragraphsOf(block);
      }
      return [fitList(block, depth)];
    });

  const blocks = doc.blocks.map((block): Block => {
    if (block.type === "list") return fitList(block, 1);
    if (block.type === "quote") return { type: "quote", blocks: fitChildren(block.blocks, 2) };
    if (block.type === "callout") return { type: "callout", tone: block.tone, blocks: fitChildren(block.blocks, 2) };
    return block;
  });
  return { doc: { schema: doc.schema, version: doc.version, blocks }, flattened };
}

/**
 * Deterministic JSON for hashing: object keys sorted, no whitespace. The API
 * hashes this string (SHA-256) for revision and approval binding.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

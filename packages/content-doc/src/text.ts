import { isLineBreak, type Block, type Inline, type OrbitDoc } from "./types.ts";

const inlineText = (items: readonly Inline[]): string =>
  items.map((item) => (isLineBreak(item) ? "\n" : item.text)).join("");

const blockText = (block: Block): string => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.content);
    case "list":
      return block.items.map((item) => item.map(blockText).join("\n")).join("\n");
    case "quote":
    case "callout":
      return block.blocks.map(blockText).join("\n");
    case "code":
      return block.text;
    case "image":
      return block.caption ?? "";
    case "divider":
      return "";
  }
};

/** Plain text of the document, blocks separated by blank lines (search, excerpts, feeds). */
export function plainText(doc: OrbitDoc): string {
  return doc.blocks.map(blockText).filter(Boolean).join("\n\n");
}

export function wordCount(doc: OrbitDoc): number {
  return plainText(doc).match(/\S+/g)?.length ?? 0;
}

/** Reading time in whole minutes, at least 1 for a non-empty document. */
export function readingTimeMinutes(doc: OrbitDoc, wordsPerMinute = 200): number {
  const words = wordCount(doc);
  return words === 0 ? 0 : Math.max(1, Math.round(words / wordsPerMinute));
}

/**
 * URL slug: lower case ASCII, umlauts and ß transliterated, other characters
 * collapsed to single hyphens. Used for heading anchors; entry slugs use the
 * same rule.
 */
export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength).replace(/-+$/g, "");
}

export interface TocEntry {
  level: 2 | 3 | 4;
  text: string;
  /** Unique within the document; the renderer uses it as the heading id. */
  anchor: string;
}

/** Table of contents over the headings, with unique anchors (`a`, `a-2`, …). */
export function tableOfContents(doc: OrbitDoc): TocEntry[] {
  const used = new Map<string, number>();
  return doc.blocks.flatMap((block): TocEntry[] => {
    if (block.type !== "heading") return [];
    const text = inlineText(block.content).replace(/\s+/g, " ").trim();
    const base = slugify(text) || "section";
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return [{ level: block.level, text, anchor: count === 1 ? base : `${base}-${count}` }];
  });
}

/** First characters of the body text, cut at a word boundary (meta description fallback). */
export function excerpt(doc: OrbitDoc, maxLength = 160): string {
  const paragraphs = doc.blocks
    .filter((block) => block.type === "paragraph")
    .map((block) => inlineText(block.content).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  if (paragraphs.length <= maxLength) return paragraphs;
  const cut = paragraphs.slice(0, maxLength - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > maxLength / 2 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

const walk = (blocks: readonly Block[], visit: (block: Block) => void): void => {
  for (const block of blocks) {
    visit(block);
    if (block.type === "list") for (const item of block.items) walk(item, visit);
    if (block.type === "quote" || block.type === "callout") walk(block.blocks, visit);
  }
};

/** Asset ids the document references, in order of first use (publish preflight: alt texts, labels). */
export function referencedAssetIds(doc: OrbitDoc): string[] {
  const ids = new Set<string>();
  walk(doc.blocks, (block) => {
    if (block.type === "image") ids.add(block.assetId);
  });
  return [...ids];
}

/** Every link target in the document, deduplicated (internal-link and broken-link checks). */
export function linkTargets(doc: OrbitDoc): string[] {
  const hrefs = new Set<string>();
  walk(doc.blocks, (block) => {
    if (block.type !== "heading" && block.type !== "paragraph") return;
    for (const item of block.content) if (!isLineBreak(item) && item.link) hrefs.add(item.link.href);
  });
  return [...hrefs];
}

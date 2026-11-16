/**
 * orbit-doc-v1: the closed, versioned block format for rich text in the
 * Content module (ADR 0029, docs/plans/CONTENT_HUB_CH0_2_TIPTAP_SPIKE.md).
 * A stored document carries no markup and no free attributes; every node and
 * mark is listed here.
 */

export const ORBIT_DOC_SCHEMA = "orbit-doc" as const;
export const ORBIT_DOC_VERSION = 1 as const;

/** Inline marks, in their canonical order. */
export const MARKS = ["bold", "italic", "code"] as const;
export type Mark = (typeof MARKS)[number];

export const CALLOUT_TONES = ["info", "tip", "warning"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export const HEADING_LEVELS = [2, 3, 4] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export interface TextRun {
  text: string;
  marks?: Mark[];
  link?: { href: string };
}

export interface LineBreak {
  type: "break";
}

export type Inline = TextRun | LineBreak;

export interface HeadingBlock {
  type: "heading";
  level: HeadingLevel;
  content: Inline[];
}

export interface ParagraphBlock {
  type: "paragraph";
  content: Inline[];
}

/** Blocks a list item, quote or callout may hold. */
export type NestedBlock = ParagraphBlock | ListBlock;

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: NestedBlock[][];
}

export interface QuoteBlock {
  type: "quote";
  blocks: NestedBlock[];
}

export interface CalloutBlock {
  type: "callout";
  tone: CalloutTone;
  blocks: NestedBlock[];
}

export interface CodeBlock {
  type: "code";
  language: string | null;
  text: string;
}

/** References a Content asset; alt text lives on the asset, per locale. */
export interface ImageBlock {
  type: "image";
  assetId: string;
  caption?: string;
}

export interface DividerBlock {
  type: "divider";
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CalloutBlock
  | CodeBlock
  | ImageBlock
  | DividerBlock;

export interface OrbitDoc {
  schema: typeof ORBIT_DOC_SCHEMA;
  version: typeof ORBIT_DOC_VERSION;
  blocks: Block[];
}

/** Size limits; the editor and the server use the same values. */
export const LIMITS = {
  blocks: 2000,
  /** Top-level blocks are depth 1; list items, quote and callout children add one. */
  depth: 4,
  /** Characters of inline text, code and captions together. */
  text: 200_000,
  href: 2048,
  caption: 300,
  code: 20_000,
  codeLanguage: 20,
} as const;

export const emptyDoc = (): OrbitDoc => ({
  schema: ORBIT_DOC_SCHEMA,
  version: ORBIT_DOC_VERSION,
  blocks: [],
});

export const isLineBreak = (inline: Inline): inline is LineBreak =>
  (inline as LineBreak).type === "break";

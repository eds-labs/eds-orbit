import { linkAllowed } from "./links.ts";
import { canonicalize, fitNesting } from "./normalize.ts";
import {
  CALLOUT_TONES,
  LIMITS,
  ORBIT_DOC_SCHEMA,
  ORBIT_DOC_VERSION,
  isLineBreak,
  type Block,
  type CalloutTone,
  type HeadingLevel,
  type Inline,
  type Mark,
  type NestedBlock,
  type OrbitDoc,
} from "./types.ts";

/**
 * TipTap/ProseMirror JSON, structurally (no TipTap dependency here). The web
 * editor configures the matching extension set: StarterKit (headings 2–4,
 * lists, blockquote, code block, horizontal rule, bold, italic, code, link,
 * hard break) plus the custom nodes `orbitImage` and `callout`.
 */
export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

/** What {@link fromTiptap} changed or removed so the editor can tell the author. */
export type TiptapChangeCode =
  | "node_removed"
  | "mark_removed"
  | "link_removed"
  | "heading_level_adjusted"
  | "heading_in_nested_block"
  | "block_unwrapped"
  | "image_without_asset"
  | "callout_tone_reset"
  | "code_language_removed"
  | "nesting_flattened";

export interface TiptapChange {
  code: TiptapChangeCode;
  /** TipTap node or mark type the change applies to, when there is one. */
  type?: string;
}

const MARK_MAP: Record<string, Mark> = { bold: "bold", italic: "italic", code: "code" };
const TONES = new Set<string>(CALLOUT_TONES);
const CODE_LANGUAGE = /^[a-z0-9][a-z0-9+#.-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Maps editor JSON to orbit-doc-v1. Never passes anything through: unknown
 * nodes and marks are dropped and reported, disallowed links become plain
 * text, headings outside 2–4 are clamped and over-deep lists flattened. The
 * result is canonical; callers still validate it (size limits).
 */
export function fromTiptap(json: TiptapNode): { doc: OrbitDoc; changes: TiptapChange[] } {
  const changes: TiptapChange[] = [];
  const note = (code: TiptapChangeCode, type?: string) => {
    if (!changes.some((change) => change.code === code && change.type === type)) {
      changes.push(type ? { code, type } : { code });
    }
  };

  const inline = (nodes: readonly TiptapNode[] = []): Inline[] => {
    const out: Inline[] = [];
    for (const node of nodes) {
      if (node.type === "hardBreak") {
        out.push({ type: "break" });
        continue;
      }
      if (node.type !== "text") {
        // Inline atoms such as mentions or emoji carry no orbit-doc meaning.
        note("node_removed", node.type);
        continue;
      }
      const value = text(node.text);
      if (!value) continue;
      const run: { text: string; marks?: Mark[]; link?: { href: string } } = { text: value };
      const marks: Mark[] = [];
      for (const mark of node.marks ?? []) {
        const mapped = MARK_MAP[mark.type];
        if (mapped) marks.push(mapped);
        else if (mark.type === "link") {
          const href = mark.attrs?.href;
          if (linkAllowed(href)) run.link = { href };
          else note("link_removed");
        } else note("mark_removed", mark.type);
      }
      if (marks.length) run.marks = marks;
      out.push(run);
    }
    return out;
  };

  const codeAsParagraph = (node: TiptapNode): NestedBlock[] => {
    const lines = (node.content ?? []).map((child) => text(child.text)).join("").split("\n");
    const content: Inline[] = [];
    lines.forEach((line, index) => {
      if (index > 0) content.push({ type: "break" });
      if (line) content.push({ text: line, marks: ["code"] });
    });
    return [{ type: "paragraph", content }];
  };

  /** Children of a list item, quote or callout: only paragraphs and lists. */
  const nested = (nodes: readonly TiptapNode[] = []): NestedBlock[] =>
    nodes.flatMap((node): NestedBlock[] => {
      switch (node.type) {
        case "paragraph":
          return [{ type: "paragraph", content: inline(node.content) }];
        case "heading":
          note("heading_in_nested_block");
          return [{ type: "paragraph", content: inline(node.content) }];
        case "bulletList":
        case "orderedList":
          return [list(node)];
        case "blockquote":
        case "callout":
          note("block_unwrapped", node.type);
          return nested(node.content);
        case "codeBlock":
          note("block_unwrapped", node.type);
          return codeAsParagraph(node);
        default:
          note("node_removed", node.type);
          return [];
      }
    });

  const list = (node: TiptapNode): NestedBlock => ({
    type: "list",
    ordered: node.type === "orderedList",
    items: (node.content ?? []).map((item) => {
      if (item.type !== "listItem" && item.type !== "taskItem") note("node_removed", item.type);
      return nested(item.content);
    }),
  });

  const block = (node: TiptapNode): Block[] => {
    switch (node.type) {
      case "heading": {
        const raw = Number(node.attrs?.level ?? 2);
        const level = (Math.min(4, Math.max(2, Number.isFinite(raw) ? Math.trunc(raw) : 2)) as HeadingLevel);
        if (level !== raw) note("heading_level_adjusted");
        return [{ type: "heading", level, content: inline(node.content) }];
      }
      case "paragraph":
        return [{ type: "paragraph", content: inline(node.content) }];
      case "bulletList":
      case "orderedList":
        return [list(node)];
      case "blockquote":
        return [{ type: "quote", blocks: nested(node.content) }];
      case "callout": {
        const tone = node.attrs?.tone;
        if (!TONES.has(tone as string)) note("callout_tone_reset");
        return [
          {
            type: "callout",
            tone: (TONES.has(tone as string) ? tone : "info") as CalloutTone,
            blocks: nested(node.content),
          },
        ];
      }
      case "codeBlock": {
        const raw = node.attrs?.language;
        let language: string | null = null;
        if (typeof raw === "string" && raw.length > 0) {
          const lower = raw.toLowerCase();
          if (lower.length <= LIMITS.codeLanguage && CODE_LANGUAGE.test(lower)) language = lower;
          else note("code_language_removed");
        }
        return [{ type: "code", language, text: (node.content ?? []).map((child) => text(child.text)).join("") }];
      }
      case "orbitImage": {
        const assetId = node.attrs?.assetId;
        if (typeof assetId !== "string" || !UUID.test(assetId)) {
          note("image_without_asset");
          return [];
        }
        const caption = text(node.attrs?.caption).slice(0, LIMITS.caption);
        return [caption ? { type: "image", assetId, caption } : { type: "image", assetId }];
      }
      case "horizontalRule":
        return [{ type: "divider" }];
      default:
        note("node_removed", node.type);
        // Keep the text of unknown containers (e.g. a pasted table) as paragraphs.
        return node.content ? nested(node.content).filter((child) => child.type === "paragraph") : [];
    }
  };

  const mapped: OrbitDoc = {
    schema: ORBIT_DOC_SCHEMA,
    version: ORBIT_DOC_VERSION,
    blocks: (json.content ?? []).flatMap(block),
  };
  const fitted = fitNesting(canonicalize(mapped));
  if (fitted.flattened > 0) note("nesting_flattened");
  return { doc: canonicalize(fitted.doc), changes };
}

/** Maps a valid orbit-doc-v1 document to editor JSON. */
export function toTiptap(doc: OrbitDoc): TiptapNode {
  const inline = (items: readonly Inline[]): TiptapNode[] =>
    items.map((item) => {
      if (isLineBreak(item)) return { type: "hardBreak" };
      const marks: TiptapMark[] = (item.marks ?? []).map((mark) => ({ type: mark }));
      if (item.link) marks.push({ type: "link", attrs: { href: item.link.href } });
      return marks.length ? { type: "text", text: item.text, marks } : { type: "text", text: item.text };
    });
  const block = (node: Block): TiptapNode => {
    switch (node.type) {
      case "heading":
        return { type: "heading", attrs: { level: node.level }, content: inline(node.content) };
      case "paragraph":
        return { type: "paragraph", content: inline(node.content) };
      case "list":
        return {
          type: node.ordered ? "orderedList" : "bulletList",
          content: node.items.map((item) => ({ type: "listItem", content: item.map(block) })),
        };
      case "quote":
        return { type: "blockquote", content: node.blocks.map(block) };
      case "callout":
        return { type: "callout", attrs: { tone: node.tone }, content: node.blocks.map(block) };
      case "code":
        return {
          type: "codeBlock",
          attrs: { language: node.language },
          content: node.text ? [{ type: "text", text: node.text }] : [],
        };
      case "image":
        return { type: "orbitImage", attrs: { assetId: node.assetId, caption: node.caption ?? null } };
      case "divider":
        return { type: "horizontalRule" };
    }
  };
  return { type: "doc", content: doc.blocks.map(block) };
}

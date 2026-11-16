import { describe, expect, it } from "vitest";
import { ASSET_ID, SAMPLE } from "./fixtures.test-support.ts";
import { renderHtml } from "./render.ts";
import { fromTiptap, toTiptap, type TiptapNode } from "./tiptap.ts";
import type { Block, Inline, NestedBlock, OrbitDoc } from "./types.ts";
import { validateOrbitDoc } from "./validate.ts";

const tiptapDoc = (content: TiptapNode[]): TiptapNode => ({ type: "doc", content });
const p = (text: string, marks?: TiptapNode["marks"]): TiptapNode => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

describe("TipTap mapping", () => {
  it("roundtrips the full sample without loss", () => {
    const { doc, changes } = fromTiptap(toTiptap(SAMPLE));
    expect(changes).toEqual([]);
    expect(doc).toEqual(SAMPLE);
  });

  it("drops what orbit-doc does not know and reports it", () => {
    const { doc, changes } = fromTiptap(
      tiptapDoc([
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Titel" }] },
        { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "Klein" }] },
        p("fett", [{ type: "bold" }, { type: "underline" }, { type: "strike" }]),
        p("js", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        p("ok", [{ type: "link", attrs: { href: "https://ok.example" } }]),
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("A")] }] }] },
        { type: "orbitImage", attrs: { assetId: "https://evil.example/x.png" } },
        { type: "callout", attrs: { tone: "danger" }, content: [p("Hinweis")] },
        { type: "codeBlock", attrs: { language: "<script>" }, content: [{ type: "text", text: "x" }] },
      ]),
    );
    expect(validateOrbitDoc(doc).valid).toBe(true);
    expect(doc.blocks).toEqual<Block[]>([
      { type: "heading", level: 2, content: [{ text: "Titel" }] },
      { type: "heading", level: 4, content: [{ text: "Klein" }] },
      { type: "paragraph", content: [{ text: "fett", marks: ["bold"] }] },
      { type: "paragraph", content: [{ text: "js" }] },
      { type: "paragraph", content: [{ text: "ok", link: { href: "https://ok.example" } }] },
      { type: "callout", tone: "info", blocks: [{ type: "paragraph", content: [{ text: "Hinweis" }] }] },
      { type: "code", language: null, text: "x" },
    ]);
    expect(changes.map((change) => change.code + (change.type ? `:${change.type}` : ""))).toEqual(
      expect.arrayContaining([
        "heading_level_adjusted",
        "mark_removed:underline",
        "mark_removed:strike",
        "link_removed",
        "node_removed:table",
        "image_without_asset",
        "callout_tone_reset",
        "code_language_removed",
      ]),
    );
  });

  it("coerces nested content to paragraphs and lists", () => {
    const { doc, changes } = fromTiptap(
      tiptapDoc([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H" }] },
                { type: "blockquote", content: [p("Q")] },
                { type: "codeBlock", content: [{ type: "text", text: "a\nb" }] },
                { type: "horizontalRule" },
              ],
            },
          ],
        },
      ]),
    );
    expect(validateOrbitDoc(doc).valid).toBe(true);
    expect((doc.blocks[0] as { items: NestedBlock[][] }).items[0]).toEqual([
      { type: "paragraph", content: [{ text: "H" }] },
      { type: "paragraph", content: [{ text: "Q" }] },
      {
        type: "paragraph",
        content: [{ text: "a", marks: ["code"] }, { type: "break" }, { text: "b", marks: ["code"] }],
      },
    ]);
    expect(changes.map((change) => change.code)).toEqual(
      expect.arrayContaining(["heading_in_nested_block", "block_unwrapped", "node_removed"]),
    );
  });

  it("flattens pasted lists nested deeper than the limit", () => {
    const nest = (levels: number): TiptapNode => ({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [p(`l${levels}`), ...(levels > 1 ? [nest(levels - 1)] : [])],
        },
      ],
    });
    const { doc, changes } = fromTiptap(tiptapDoc([nest(6)]));
    expect(validateOrbitDoc(doc).valid).toBe(true);
    expect(changes.map((change) => change.code)).toContain("nesting_flattened");
  });

  it("drops empty paragraphs on save", () => {
    const { doc } = fromTiptap(tiptapDoc([{ type: "paragraph" }, p("x"), { type: "paragraph", content: [] }]));
    expect(doc.blocks).toEqual([{ type: "paragraph", content: [{ text: "x" }] }]);
  });
});

// Property tests with a seeded generator: random valid documents roundtrip
// unchanged and render without markup from content.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const NASTY = ['<script>alert(1)</script>', '"onload="x', "&amp;", "Größe", "a\tb", "x"];

function randomDoc(random: () => number): OrbitDoc {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const inline = (): Inline[] =>
    Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index): Inline => {
      if (index > 0 && random() < 0.1) return { type: "break" };
      const run: Inline = { text: pick(NASTY) + index };
      const marks = (["bold", "italic", "code"] as const).filter(() => random() < 0.3);
      if (marks.length) run.marks = [...marks];
      if (random() < 0.2) run.link = { href: pick(["/a/", "https://b.example/c", "mailto:d@e.example", "#f"]) };
      return run;
    });
  const nested = (depth: number): NestedBlock =>
    depth < 3 && random() < 0.3
      ? { type: "list", ordered: random() < 0.5, items: [[{ type: "paragraph", content: inline() }, nested(depth + 1)]] }
      : { type: "paragraph", content: inline() };
  const block = (): Block => {
    switch (pick(["heading", "paragraph", "list", "quote", "callout", "code", "image", "divider"] as const)) {
      case "heading":
        return { type: "heading", level: pick([2, 3, 4] as const), content: inline() };
      case "paragraph":
        return { type: "paragraph", content: inline() };
      case "list":
        return { type: "list", ordered: random() < 0.5, items: [[nested(2)], [nested(2)]] };
      case "quote":
        return { type: "quote", blocks: [nested(2)] };
      case "callout":
        return { type: "callout", tone: pick(["info", "tip", "warning"] as const), blocks: [nested(2)] };
      case "code":
        return { type: "code", language: pick([null, "ts", "c++"]), text: pick(NASTY) };
      case "image":
        return random() < 0.5 ? { type: "image", assetId: ASSET_ID, caption: pick(NASTY) } : { type: "image", assetId: ASSET_ID };
      case "divider":
        return { type: "divider" };
    }
  };
  return { schema: "orbit-doc", version: 1, blocks: Array.from({ length: 1 + Math.floor(random() * 8) }, block) };
}

describe("properties", () => {
  it("random valid documents roundtrip, validate and render safely", () => {
    const random = rng(20261116);
    for (let run = 0; run < 300; run += 1) {
      const original = fromTiptap(toTiptap(randomDoc(random))).doc; // canonical form
      expect(validateOrbitDoc(original).problems).toEqual([]);
      const again = fromTiptap(toTiptap(original));
      expect(again.changes).toEqual([]);
      expect(again.doc).toEqual(original);
      const html = renderHtml(original, {
        resolveAsset: () => ({ src: "/m.webp", width: 1, height: 1, alt: '"><script>' }),
      });
      expect(html).not.toMatch(/<script|"\s*on\w+=/i);
    }
  });
});

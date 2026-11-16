import type { OrbitDoc } from "./types.ts";

export const ASSET_ID = "3f0c9a51-6b1e-4c43-9a1f-2d8e5b7c1a90";

/** Covers every block and mark of orbit-doc-v1, a nested list and German umlauts. */
export const SAMPLE: OrbitDoc = {
  schema: "orbit-doc",
  version: 1,
  blocks: [
    { type: "heading", level: 2, content: [{ text: "Familienkalender teilen" }] },
    {
      type: "paragraph",
      content: [
        { text: "Mit " },
        { text: "FamilyPlan", marks: ["bold"] },
        { text: " geht es " },
        { text: "schnell", marks: ["bold", "italic"] },
        { type: "break" },
        { text: "Mehr im " },
        { text: "Hilfe-Center", link: { href: "/hilfe/" } },
        { text: " und bei " },
        { text: "Apple", link: { href: "https://support.apple.com/de-de" } },
      ],
    },
    {
      type: "list",
      ordered: false,
      items: [
        [{ type: "paragraph", content: [{ text: "Eins" }] }],
        [
          { type: "paragraph", content: [{ text: "Zwei" }] },
          { type: "list", ordered: true, items: [[{ type: "paragraph", content: [{ text: "Zwei.a" }] }]] },
        ],
      ],
    },
    { type: "quote", blocks: [{ type: "paragraph", content: [{ text: "Zitat" }] }] },
    {
      type: "callout",
      tone: "tip",
      blocks: [{ type: "paragraph", content: [{ text: "Tipp: ", marks: ["bold"] }, { text: "nutze Farben" }] }],
    },
    { type: "code", language: "ts", text: "const a = '<b>';" },
    { type: "image", assetId: ASSET_ID, caption: "Kalenderansicht" },
    { type: "divider" },
    { type: "heading", level: 3, content: [{ text: "Größe & Übersicht" }] },
    { type: "paragraph", content: [{ text: "Inline " }, { text: "code()", marks: ["code"] }] },
  ],
};

export const doc = (blocks: unknown[]): unknown => ({ schema: "orbit-doc", version: 1, blocks });

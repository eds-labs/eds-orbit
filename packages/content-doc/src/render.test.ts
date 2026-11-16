import { describe, expect, it } from "vitest";
import { ASSET_ID, SAMPLE } from "./fixtures.test-support.ts";
import { canonicalJson, canonicalize, fitNesting } from "./normalize.ts";
import { renderHtml } from "./render.ts";
import {
  excerpt,
  linkTargets,
  plainText,
  readingTimeMinutes,
  referencedAssetIds,
  slugify,
  tableOfContents,
  wordCount,
} from "./text.ts";
import type { OrbitDoc } from "./types.ts";
import { validateOrbitDoc } from "./validate.ts";

const asDoc = (blocks: OrbitDoc["blocks"]): OrbitDoc => ({ schema: "orbit-doc", version: 1, blocks });
const asset = { src: "/api/v1/cms/media/x/960.webp", width: 960, height: 540, alt: "Kalender" };

describe("renderHtml", () => {
  it("renders the sample with heading ids, rel on external links and resolved images", () => {
    const html = renderHtml(SAMPLE, { resolveAsset: () => asset, siteOrigins: ["https://familyplan.cloud"] });
    expect(html).toContain('<h2 id="familienkalender-teilen">');
    expect(html).toContain('<h3 id="groesse-uebersicht">');
    expect(html).toContain('<a href="/hilfe/">Hilfe-Center</a>');
    expect(html).toContain('<a href="https://support.apple.com/de-de" rel="noopener noreferrer">Apple</a>');
    expect(html).toContain("<strong><em>schnell</em></strong>");
    expect(html).toContain('width="960" height="540" alt="Kalender"');
    expect(html).toContain('<pre><code class="language-ts">const a = &#39;&lt;b&gt;&#39;;</code></pre>');
    expect(html).toContain('<aside class="callout callout-tip" data-tone="tip">');
  });

  it("leaves out images without an asset and refuses unsafe sources", () => {
    const image = asDoc([{ type: "image", assetId: ASSET_ID }]);
    expect(renderHtml(image)).toBe("");
    expect(renderHtml(image, { resolveAsset: () => ({ ...asset, src: "javascript:alert(1)" }) })).toBe("");
    expect(renderHtml(image, { resolveAsset: () => ({ ...asset, src: "//evil/x.png" }) })).toBe("");
    const withSrcset = renderHtml(image, {
      resolveAsset: () => ({ ...asset, srcset: '/a.webp 480w, /b.webp" onerror="x 960w' }),
    });
    expect(withSrcset).not.toContain("srcset");
  });

  it("escapes every text, attribute and code value (XSS corpus)", () => {
    const corpus = [
      '<img src=x onerror=alert(1)>"\'&',
      "</p><script>alert(1)</script>",
      "<svg/onload=alert(1)>",
      "{{constructor.constructor('x')()}}",
      "<!-- --><iframe src=//evil>",
    ];
    for (const payload of corpus) {
      const html = renderHtml(
        asDoc([
          { type: "heading", level: 2, content: [{ text: payload }] },
          { type: "paragraph", content: [{ text: payload, link: { href: 'https://a.example/"onmouseover="x' } }] },
          { type: "code", language: null, text: `</code>${payload}` },
          { type: "image", assetId: ASSET_ID, caption: payload },
        ]),
        { resolveAsset: () => ({ ...asset, alt: payload }) },
      );
      expect(html).not.toMatch(/<(script|img src=x|svg|iframe)/i);
      expect(html).not.toMatch(/"\s*on\w+=/i);
      expect(html.match(/<img /g)?.length).toBe(1);
    }
  });

  it("drops links that fail the link rule even in an unvalidated document", () => {
    const html = renderHtml(asDoc([{ type: "paragraph", content: [{ text: "x", link: { href: "javascript:alert(1)" } }] }]));
    expect(html).toBe("<p>x</p>");
  });
});

describe("text helpers", () => {
  it("plain text, word count and reading time", () => {
    const text = plainText(SAMPLE);
    expect(text).toContain("Zwei.a");
    expect(text).toContain("Kalenderansicht");
    expect(wordCount(SAMPLE)).toBeGreaterThan(20);
    expect(readingTimeMinutes(SAMPLE)).toBe(1);
    expect(readingTimeMinutes(asDoc([]))).toBe(0);
  });

  it("table of contents anchors are unique and transliterated", () => {
    const toc = tableOfContents(
      asDoc([
        { type: "heading", level: 2, content: [{ text: "FAQ" }] },
        { type: "heading", level: 3, content: [{ text: "FAQ" }] },
        { type: "heading", level: 2, content: [{ text: "!!!" }] },
      ]),
    );
    expect(toc.map((entry) => entry.anchor)).toEqual(["faq", "faq-2", "section"]);
    expect(slugify("Größe & Übersicht: Café")).toBe("groesse-uebersicht-cafe");
    expect(slugify("a".repeat(100) + " b", 10)).toBe("aaaaaaaaaa");
  });

  it("excerpt cuts at a word boundary", () => {
    const long = asDoc([{ type: "paragraph", content: [{ text: "Wort ".repeat(60) }] }]);
    const result = excerpt(long, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("Wort…")).toBe(true);
  });

  it("collects asset ids and link targets", () => {
    expect(referencedAssetIds(SAMPLE)).toEqual([ASSET_ID]);
    expect(linkTargets(SAMPLE)).toEqual(["/hilfe/", "https://support.apple.com/de-de"]);
  });
});

describe("canonical form", () => {
  it("merges runs, orders marks and drops empty blocks", () => {
    const messy = asDoc([
      { type: "paragraph", content: [] },
      {
        type: "paragraph",
        content: [{ text: "a", marks: ["italic", "bold"] }, { text: "b", marks: ["bold", "italic"] }, { type: "break" }],
      },
      { type: "quote", blocks: [{ type: "paragraph", content: [] }] },
      { type: "code", language: null, text: "" },
    ]);
    expect(canonicalize(messy).blocks).toEqual([
      { type: "paragraph", content: [{ text: "ab", marks: ["bold", "italic"] }] },
    ]);
    expect(canonicalize(SAMPLE)).toEqual(SAMPLE);
  });

  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }], c: undefined })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });

  it("fitNesting flattens over-deep lists into valid documents", () => {
    const nest = (levels: number): OrbitDoc["blocks"][number] =>
      levels === 0
        ? { type: "paragraph", content: [{ text: "leaf" }] }
        : {
            type: "list",
            ordered: false,
            items: [[{ type: "paragraph", content: [{ text: `l${levels}` }] }, nest(levels - 1) as never]],
          };
    const deep = asDoc([nest(6), { type: "quote", blocks: [nest(5) as never] }]);
    expect(validateOrbitDoc(deep).valid).toBe(false);
    const { doc, flattened } = fitNesting(deep);
    expect(flattened).toBeGreaterThan(0);
    expect(validateOrbitDoc(doc).valid).toBe(true);
    // No text is lost.
    expect(plainText(doc).match(/l\d|leaf/g)?.sort()).toEqual(plainText(deep).match(/l\d|leaf/g)?.sort());
    expect(fitNesting(SAMPLE)).toEqual({ doc: SAMPLE, flattened: 0 });
  });
});

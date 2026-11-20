import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import {
  canonicalize,
  fromTiptap,
  toTiptap,
  type OrbitDoc,
} from "../../../../../../packages/content-doc/src/index.ts";
import { SAMPLE } from "../../../../../../packages/content-doc/src/fixtures.test-support.ts";
import { containerDepth, editorExtensions } from "./schema";
import { normalizePastedHtml } from "./paste";
import { lengthState, seoChecks } from "./seo";
import { cleanSeo, draftPatch } from "./entry-editor";
import { sitePath } from "./panels";
import { previewFile } from "../api";

const schema = getSchema(editorExtensions());
const doc = (blocks: OrbitDoc["blocks"]): OrbitDoc => ({
  schema: "orbit-doc",
  version: 1,
  blocks,
});

describe("content editor schema (CH1.14b)", () => {
  it("holds exactly orbit-doc's nodes and marks", () => {
    expect(Object.keys(schema.marks).sort()).toEqual([
      "bold",
      "code",
      "italic",
      "link",
    ]);
    for (const node of [
      "callout",
      "orbitImage",
      "heading",
      "codeBlock",
      "horizontalRule",
      "hardBreak",
    ])
      expect(schema.nodes[node]).toBeDefined();
    expect(schema.nodes.image).toBeUndefined();
    expect(schema.nodes.table).toBeUndefined();
  });

  it("round-trips every block through the editor schema without loss", () => {
    const json = PMNode.fromJSON(schema, toTiptap(SAMPLE)).toJSON();
    const back = fromTiptap(json);
    expect(back.changes).toEqual([]);
    expect(back.doc).toEqual(canonicalize(SAMPLE));
  });

  it("stops indenting at orbit-doc's nesting limit", () => {
    // A list in a list in a list: the innermost paragraph sits in three containers.
    const deep = doc([
      {
        type: "list",
        ordered: false,
        items: [
          [
            {
              type: "list",
              ordered: false,
              items: [
                [
                  {
                    type: "list",
                    ordered: false,
                    items: [[{ type: "paragraph", content: [{ text: "x" }] }]],
                  },
                ],
              ],
            },
          ],
        ],
      },
    ]);
    const node = PMNode.fromJSON(schema, toTiptap(deep));
    let pos = -1;
    node.descendants((child, at) => {
      if (child.isText) pos = at;
    });
    expect(containerDepth(node.resolve(pos))).toBe(3);
    const top = PMNode.fromJSON(
      schema,
      toTiptap(doc([{ type: "paragraph", content: [{ text: "y" }] }])),
    );
    expect(containerDepth(top.resolve(1))).toBe(0);
  });
});

describe("pasted HTML", () => {
  it("moves headings into levels 2–4 and keeps table text as rows", () => {
    const { html } = normalizePastedHtml(
      '<h1 class="x">A</h1><h5>B</h5><h6>C</h6><table><tbody><tr><td>1</td><td>2</td></tr><tr><th>3</th></tr></tbody></table>',
    );
    expect(html).toBe(
      '<h2 class="x">A</h2><h4>B</h4><h4>C</h4><p>1 · 2</p><p>3</p>',
    );
  });

  it("counts foreign images and links that are not allowed", () => {
    const { notice } = normalizePastedHtml(
      '<p><img src="https://x.test/a.png"><a href="javascript:alert(1)">a</a><a href=\'http://x.test\'>b</a>' +
        '<a href="https://ok.test">c</a><a href="/intern">d</a></p><figure data-orbit-image data-asset-id="1"><img src="/api/x"></figure>',
    );
    expect(notice).toEqual({ images: 1, links: 2 });
  });
});

describe("SEO hints", () => {
  const body = doc([
    {
      type: "paragraph",
      content: [
        { text: "Der Familienkalender hilft " },
        { text: "hier", link: { href: "/hilfe/" } },
      ],
    },
    { type: "heading", level: 2, content: [{ text: "A" }] },
    { type: "heading", level: 4, content: [{ text: "B" }] },
  ]);

  it("rates lengths against the recommended range", () => {
    expect(lengthState("", { min: 3, max: 5 })).toBe("empty");
    expect(lengthState("ab", { min: 3, max: 5 })).toBe("short");
    expect(lengthState(" abcd ", { min: 3, max: 5 })).toBe("good");
    expect(lengthState("abcdef", { min: 3, max: 5 })).toBe("long");
  });

  it("checks keyword placement, heading levels, internal links and noindex", () => {
    const checks = Object.fromEntries(
      seoChecks({
        title: "Familienkalender: so teilt die Familie Termine",
        excerpt: "",
        seo: {
          focusKeyword: "familienkalender",
          robots: { index: false, follow: true },
        },
        doc: body,
      }).map((c) => [c.code, c.ok]),
    );
    expect(checks).toEqual({
      title_length: true,
      meta_missing: false,
      keyword_not_in_title: true,
      keyword_not_in_meta: false,
      keyword_not_in_intro: true,
      headings_skip: false,
      no_internal_links: true,
      noindex: false,
    });
    expect(
      seoChecks({ title: "x", excerpt: "y", seo: {}, doc: doc([]) }).map(
        (c) => c.code,
      ),
    ).toEqual([
      "title_length",
      "meta_length",
      "keyword_missing",
      "no_headings",
      "no_internal_links",
    ]);
  });
});

describe("draft saving", () => {
  it("sends only fields the server accepts", () => {
    expect(draftPatch("slug", "Neu Hier")).toBeNull();
    expect(draftPatch("slug", "neu-hier")).toEqual({ slug: "neu-hier" });
    expect(draftPatch("title", "  Titel ")).toEqual({ title: "Titel" });
    expect(draftPatch("termIds", ["a"])).toEqual({ termIds: ["a"] });
    // A canonical address still being typed waits until it is a full https URL.
    expect(
      draftPatch("seo", { canonicalOverride: "www.example.com" }),
    ).toBeNull();
    expect(draftPatch("seo", { canonicalOverride: "https://" })).toBeNull();
    expect(
      draftPatch("seo", { canonicalOverride: "https://example.com/a" }),
    ).toEqual({
      seo: { canonicalOverride: "https://example.com/a" },
    });
    expect(
      cleanSeo({
        seoTitle: " T ",
        metaDescription: " ",
        keywords: [],
        robots: { index: true, follow: false },
      }),
    ).toEqual({ seoTitle: "T", robots: { index: true, follow: false } });
  });

  it("builds a site path and picks a small preview rendition", () => {
    const site = {
      id: "s",
      name: "S",
      baseUrl: "https://s.test",
      locales: ["de", "en"],
      defaultLocale: "de",
      verification: "configured" as const,
      routes: { article: { en: "/en/blog/{slug}" } },
      trailingSlash: true,
      archived: false,
      version: 1,
    };
    expect(sitePath(site, "article", "en", "a-b")).toBe("/en/blog/a-b/");
    expect(
      sitePath({ ...site, trailingSlash: false }, "article", "de", "x"),
    ).toBe("/blog/x");
    expect(
      previewFile({
        renditions: [
          { name: "original", mime: "image/png", width: 300, height: 200 },
          { name: "og", mime: "image/webp", width: 1200, height: 630 },
        ],
      }),
    ).toBe("original.png");
    expect(
      previewFile({
        renditions: [
          { name: "original", mime: "image/jpeg", width: 3000, height: 2000 },
          { name: "w480", mime: "image/webp", width: 480, height: 320 },
        ],
      }),
    ).toBe("w480.webp");
  });
});

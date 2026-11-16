import { describe, expect, it } from "vitest";
import { ASSET_ID, SAMPLE, doc } from "./fixtures.test-support.ts";
import { linkAllowed } from "./links.ts";
import { LIMITS } from "./types.ts";
import { assertOrbitDoc, OrbitDocError, validateOrbitDoc } from "./validate.ts";

const codes = (value: unknown) => validateOrbitDoc(value).problems.map((problem) => problem.code);
const para = (inline: unknown[]) => ({ type: "paragraph", content: inline });

describe("validateOrbitDoc", () => {
  it("accepts the full sample and an empty document", () => {
    expect(validateOrbitDoc(SAMPLE)).toEqual({ valid: true, problems: [] });
    expect(validateOrbitDoc(doc([])).valid).toBe(true);
  });

  it("rejects values that are not orbit-doc v1", () => {
    for (const value of [null, "x", [], { schema: "orbit-doc", version: 2, blocks: [] }, { blocks: [] }]) {
      expect(codes(value)).toEqual(["not_orbit_doc"]);
    }
    expect(codes({ schema: "orbit-doc", version: 1, blocks: [], html: "<b>" })).toEqual(["unknown_key"]);
  });

  it.each([
    ["javascript: link", [para([{ text: "x", link: { href: "javascript:alert(1)" } }])], "link_not_allowed"],
    ["protocol-relative link", [para([{ text: "x", link: { href: "//evil.example" } }])], "link_not_allowed"],
    ["http: link", [para([{ text: "x", link: { href: "http://example.com" } }])], "link_not_allowed"],
    ["extra link key", [para([{ text: "x", link: { href: "/a", target: "_blank" } }])], "link_not_allowed"],
    ["h1", [{ type: "heading", level: 1, content: [{ text: "x" }] }], "heading_level"],
    ["raw html block", [{ type: "html", html: "<script>" }], "unknown_block"],
    ["unknown mark", [para([{ text: "x", marks: ["underline"] }])], "mark_not_allowed"],
    ["duplicate mark", [para([{ text: "x", marks: ["bold", "bold"] }])], "mark_not_allowed"],
    ["empty text run", [para([{ text: "" }])], "inline_invalid"],
    ["free attribute on a block", [{ type: "paragraph", content: [{ text: "x" }], style: "color:red" }], "unknown_key"],
    ["free attribute on a run", [para([{ text: "x", class: "y" }])], "unknown_key"],
    ["image with url instead of asset", [{ type: "image", assetId: "https://evil/x.png" }], "image_invalid"],
    ["heading inside a list", [{ type: "list", ordered: false, items: [[{ type: "heading", level: 2, content: [{ text: "x" }] }]] }], "block_not_allowed_here"],
    ["empty list", [{ type: "list", ordered: false, items: [] }], "list_invalid"],
    ["empty quote", [{ type: "quote", blocks: [] }], "children_missing"],
    ["unknown tone", [{ type: "callout", tone: "danger", blocks: [para([{ text: "x" }])] }], "callout_tone"],
    ["language with markup", [{ type: "code", language: "<x>", text: "" }], "code_invalid"],
    ["missing code language key", [{ type: "code", text: "a" }], "code_invalid"],
    ["caption too long", [{ type: "image", assetId: ASSET_ID, caption: "x".repeat(LIMITS.caption + 1) }], "image_invalid"],
  ])("rejects %s", (_name, blocks, code) => {
    expect(codes(doc(blocks))).toContain(code);
  });

  it("enforces the nesting depth", () => {
    const nest = (levels: number): unknown =>
      levels === 0
        ? para([{ text: "leaf" }])
        : { type: "list", ordered: false, items: [[para([{ text: `l${levels}` }]), nest(levels - 1)]] };
    // Three list levels fit (items at depth 4); a fourth does not.
    expect(validateOrbitDoc(doc([nest(3)])).valid).toBe(true);
    expect(codes(doc([nest(4)]))).toContain("too_deep");
  });

  it("enforces block count and text length", () => {
    const many = Array.from({ length: LIMITS.blocks + 1 }, () => ({ type: "divider" }));
    expect(codes(doc(many))).toContain("too_many_blocks");
    const long = Array.from({ length: 3 }, () => para([{ text: "x".repeat(LIMITS.text / 2) }]));
    expect(codes(doc(long))).toContain("text_too_long");
  });

  it("caps the number of reported problems", () => {
    const bad = Array.from({ length: 500 }, () => ({ type: "html" }));
    expect(validateOrbitDoc(doc(bad)).problems.length).toBeLessThanOrEqual(50);
  });

  it("assertOrbitDoc throws a coded error", () => {
    expect(() => assertOrbitDoc(doc([{ type: "html" }]))).toThrow(OrbitDocError);
    expect(assertOrbitDoc(SAMPLE)).toBe(SAMPLE);
  });
});

describe("linkAllowed", () => {
  it.each([
    "https://example.com/a?b=c#d",
    "mailto:hallo@example.com",
    "/blog/artikel/",
    "#abschnitt",
  ])("allows %s", (href) => expect(linkAllowed(href)).toBe(true));

  it.each([
    "",
    "#",
    "http://example.com",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>",
    "//evil.example",
    "/\\evil.example",
    "https://user:pass@example.com",
    "https://exa mple.com",
    "https://example.com/\n",
    "vbscript:x",
    `https://example.com/${"a".repeat(LIMITS.href)}`,
    "relative/path",
  ])("refuses %j", (href) => expect(linkAllowed(href)).toBe(false));
});

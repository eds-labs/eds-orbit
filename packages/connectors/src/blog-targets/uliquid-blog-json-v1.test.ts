import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE_ID,
  ProfileError,
  parseArticleBody,
  slugify,
  readTime,
  toPostJson,
  validatePost,
  checkOrbitRules,
  linkAllowlist,
  postFileBytes,
  type ArticleMeta,
  type BlogPostJson,
} from "./uliquid-blog-json-v1.ts";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const FIXTURES = [
  "market-intelligence-context-not-signal.json",
  "ai-assisted-trading-keeps-decisions-with-the-user.json",
];
const read = (file: string) =>
  JSON.parse(readFileSync(join(dir, file), "utf8"));

const validPost = (): any => ({
  slug: "example-post",
  title: "An Example Post Title",
  seoTitle: "An Example Post",
  description: "A short description of the example post.",
  category: "Market intelligence",
  publishedAt: "2026-10-12",
  updatedAt: "2026-10-12",
  readTime: "5 min read",
  author: "Mario Euchner",
  authorTitle: "Founder & Product Lead",
  keywords: ["example keyword"],
  excerpt: "A short excerpt.",
  sections: [
    {
      heading: "First section",
      paragraphs: ["First paragraph."],
      list: ["One point."],
    },
  ],
  relatedLinks: [{ label: "Explore the platform", href: "/platform/" }],
});
const rejects = (mutate: (p: any) => void) => {
  const post = validPost();
  mutate(post);
  return validatePost(post, "example-post").join("\n");
};

// Builds `words` words spread over `sections` sections (heading words included).
const bodyOf = (words: number, sections = 5) => {
  const per = Math.floor(words / sections);
  const out: string[] = [];
  for (let s = 0; s < sections; s++) {
    const own = s === sections - 1 ? words - per * (sections - 1) : per;
    const text = Array.from({ length: own - 2 }, (_, i) => `w${i}`).join(" ");
    out.push(`## Heading ${s}\n\n${text}`);
  }
  return out.join("\n\n");
};
const META: ArticleMeta = {
  seoTitle: "Market Context",
  description: "A description.",
  excerpt: "An excerpt.",
  category: "Market intelligence",
  keywords: ["market context"],
  relatedLinks: [
    { label: "Platform", href: "/platform/" },
    { label: "Pricing", href: "/pricing/" },
  ],
};
const LINK = (href: string) => ({ label: "Link", href });
const postWith = (words: number, sections: number): BlogPostJson =>
  toPostJson({
    title: "Market Context",
    body: bodyOf(words, sections),
    article: META,
    date: "2026-10-12",
  });

describe("uliquid-blog-json-v1", () => {
  it("has a stable profile id", () =>
    expect(PROFILE_ID).toBe("uliquid-blog-json-v1"));

  it("website posts pass the profile unchanged", () => {
    for (const file of FIXTURES)
      expect(validatePost(read(file), basename(file, ".json"))).toEqual([]);
  });

  it("accepts a complete post", () => {
    expect(validatePost(validPost(), "example-post")).toEqual([]);
  });

  it("website rejection cases are rejected with the same field", () => {
    const cases: [(p: any) => void, RegExp][] = [
      [
        (p) => {
          delete p.title;
        },
        /title: is required/,
      ],
      [
        (p) => {
          p.slug = "Example_Post";
        },
        /slug: must be lowercase kebab-case/,
      ],
      [
        (p) => {
          p.slug = "other-post";
        },
        /must match the file name "example-post\.json"/,
      ],
      [
        (p) => {
          p.publishedAt = "2026-02-30";
        },
        /publishedAt: is not a valid calendar date/,
      ],
      [
        (p) => {
          p.updatedAt = "2026-10-01";
        },
        /updatedAt: must not be earlier than publishedAt/,
      ],
      [
        (p) => {
          p.readTime = "about 5 minutes";
        },
        /readTime: must look like/,
      ],
      [
        (p) => {
          p.seoTitle = "x".repeat(71);
        },
        /seoTitle: must be at most 70 characters/,
      ],
      [
        (p) => {
          p.sections = [];
        },
        /sections: must contain at least one section/,
      ],
      [
        (p) => {
          p.sections[0].paragraphs = [""];
        },
        /sections\[0\]\.paragraphs\[0\]: must be a non-empty string/,
      ],
      [
        (p) => {
          p.relatedLinks[0].href = "https://example.com/";
        },
        /relatedLinks\[0\]\.href: must be an internal path/,
      ],
      [
        (p) => {
          p.relatedLinks[0].href = "/platform";
        },
        /relatedLinks\[0\]\.href: must be an internal path/,
      ],
      [
        (p) => {
          p.draft = true;
        },
        /post: unknown field "draft"/,
      ],
      [
        (p) => {
          p.sections[0].paragraphs[0] = "Enjoy guaranteed returns.";
        },
        /forbidden claim/,
      ],
    ];
    expect(cases).toHaveLength(13);
    for (const [mutate, expected] of cases)
      expect(rejects(mutate)).toMatch(expected);
  });

  it("prefixes errors with the field", () => {
    expect(
      rejects((p) => {
        delete p.title;
      }),
    ).toMatch(/^title: is required/m);
    expect(
      rejects((p) => {
        p.relatedLinks[0].href = "/platform";
      }),
    ).toMatch(/^relatedLinks\[0\]\.href:/m);
    expect(validatePost("nope")).toEqual(["post: must be a JSON object"]);
  });

  it("parses restricted markdown", () => {
    expect(
      parseArticleBody("## A\n\nOne.\n\nTwo.\n\n- x\n- y\n\n## B\n\nThree."),
    ).toEqual([
      { heading: "A", paragraphs: ["One.", "Two."], list: ["x", "y"] },
      { heading: "B", paragraphs: ["Three."] },
    ]);
  });

  it("CRLF, trailing spaces and extra blank lines parse like clean LF", () => {
    expect(parseArticleBody("## A  \r\n\r\n\r\nOne.  \r\n\r\n- x\r\n")).toEqual(
      parseArticleBody("## A\n\nOne.\n\n- x"),
    );
  });

  it.each([
    ["# Title\n\nx", "h1"],
    ["## A\n\n### B", "h3"],
    ["## A\n\nSee [docs](https://x.y).", "link"],
    ["## A\n\n**bold**", "emphasis"],
    ["## A\n\n![i](a.png)", "image"],
    ["## A\n\n<b>x</b>", "html"],
    ["## A\n\n- x\n\nAfter list.", "text after list"],
    ["Intro without heading.\n\n## A\n\nx", "text before first heading"],
    ["## A\n\n```\ncode\n```", "code"],
    ["## A\n\n| a | b |", "table"],
    ["", "empty"],
  ])("rejects %j (%s)", (body) => {
    expect(() => parseArticleBody(body)).toThrow(
      expect.objectContaining({ code: "BLOG_BODY_FORMAT" }),
    );
    expect(() => parseArticleBody(body)).toThrow(ProfileError);
  });

  it("slugify", () => {
    expect(slugify("uLiquid's AI: 2026 Guide!")).toBe("uliquids-ai-2026-guide");
    expect(slugify("Über Märkte & Risiko")).toBe("uber-markte-risiko");
    expect(slugify("A".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(slugify("word ".repeat(40)).length).toBeLessThanOrEqual(80);
    expect(slugify("word ".repeat(40)).endsWith("-")).toBe(false);
    expect(() => slugify("!!!")).toThrow(
      expect.objectContaining({ code: "BLOG_SLUG_INVALID" }),
    );
  });

  it("readTime rounds up at 220 words per minute", () => {
    const s = (n: number) => [
      {
        heading: "H",
        paragraphs: [
          Array(n - 1)
            .fill("w")
            .join(" "),
        ],
      },
    ];
    expect(readTime(s(220))).toBe("1 min read");
    expect(readTime(s(221))).toBe("2 min read");
    expect(readTime(s(1320))).toBe("6 min read");
  });

  it("toPostJson fills derived fields", () => {
    const post = toPostJson({
      title: "Market Context",
      body: bodyOf(1320),
      article: META,
      date: "2026-10-12",
    });
    expect(post).toMatchObject({
      slug: "market-context",
      readTime: "6 min read",
      author: "Mario Euchner",
      authorTitle: "Founder & Product Lead",
      publishedAt: "2026-10-12",
      updatedAt: "2026-10-12",
    });
    expect(Object.keys(post)).toEqual(Object.keys(validPost()));
    expect(validatePost(post, "market-context")).toEqual([]);
    const bytes = postFileBytes(post);
    expect(bytes.endsWith("}\n")).toBe(true);
    expect(bytes).toBe(JSON.stringify(post, null, 2) + "\n");
  });

  it("orbit rules", () => {
    const allow = linkAllowlist(["market-intelligence-context-not-signal"]);
    expect(allow).toContain("/blog/market-intelligence-context-not-signal/");
    expect(allow).toContain("/platform/");
    const POST = postWith(1320, 5);
    expect(checkOrbitRules(POST, allow)).toEqual([]);
    expect(
      checkOrbitRules({ ...POST, relatedLinks: [LINK("/platform/")] }, allow),
    ).toContain("relatedLinks: needs 2 to 4 entries");
    expect(
      checkOrbitRules(
        { ...POST, relatedLinks: [LINK("/platform/"), LINK("/careers/")] },
        allow,
      ),
    ).toContain('relatedLinks[1].href: "/careers/" is not in the allowlist');
    expect(checkOrbitRules(postWith(1320, 4), allow)).toContain(
      "sections: needs 5 to 8 sections",
    );
    expect(checkOrbitRules(postWith(900, 5), allow)).toContain(
      "body: needs 1000 to 2200 words (has 900)",
    );
    expect(checkOrbitRules(postWith(2300, 5), allow)).toContain(
      "body: needs 1000 to 2200 words (has 2300)",
    );
  });
});

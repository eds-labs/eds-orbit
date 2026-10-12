import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogPreviewCard, releaseBlock } from "./blog-preview";
import type { BlogPreview } from "./assignments";

const blogPreview = (changes: Partial<BlogPreview> = {}): BlogPreview => ({
  post: {
    slug: "liquidity-basics",
    title: "Liquidity basics for desks",
    seoTitle: "Liquidity basics | uLiquid",
    description: "How a desk reads liquidity before it trades.",
    category: "Guides",
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-12",
    readTime: "7 min read",
    author: "Mario Euchner",
    authorTitle: "Founder & Product Lead",
    keywords: ["liquidity", "desk"],
    excerpt: "A short guide.",
    sections: [
      {
        heading: "Why liquidity matters",
        paragraphs: ["Depth decides the price you get."],
      },
      {
        heading: "What to check",
        paragraphs: ["Three things first."],
        list: ["Spread", "Depth", "Volume"],
      },
    ],
    relatedLinks: [
      { label: "Beta access", href: "/beta/" },
      { label: "Getting started", href: "/blog/getting-started/" },
    ],
  },
  problems: [],
  liveUrl: "https://uliquid.vip/blog/liquidity-basics/",
  slugTaken: false,
  ...changes,
});

const render = (preview: BlogPreview, de = true) =>
  renderToStaticMarkup(<BlogPreviewCard preview={preview} de={de} />);

describe("BlogPreviewCard (R81)", () => {
  it("shows title, meta line, description, every section, the list and the related links", () => {
    const html = render(blogPreview());
    expect(html).toContain("Liquidity basics for desks");
    expect(html).toContain("Guides");
    expect(html).toContain("7 min read");
    expect(html).toContain("Mario Euchner");
    expect(html).toContain("How a desk reads liquidity before it trades.");
    expect(html).toContain("Why liquidity matters");
    expect(html).toContain("What to check");
    expect(html).toContain("Depth decides the price you get.");
    expect(html).toContain("<li>Spread</li>");
    expect(html).toContain("Beta access");
    expect(html).toContain('href="https://uliquid.vip/beta/"');
    expect(html).toContain("Getting started");
    expect(html).toContain("https://uliquid.vip/blog/liquidity-basics/");
    expect(html).toContain("Ziel-URL");
  });

  it("lists the problems", () => {
    const html = render(
      blogPreview({
        problems: ["sections: too few", "BLOG_TARGET_UNREACHABLE"],
      }),
      false,
    );
    expect(html).toContain("sections: too few");
    expect(html).toContain("BLOG_TARGET_UNREACHABLE");
    expect(html).toContain("Target URL");
  });
});

describe("releaseBlock", () => {
  it("names the first problem, then a taken slug, else nothing", () => {
    expect(releaseBlock(blogPreview(), true)).toBeNull();
    expect(
      releaseBlock(blogPreview({ problems: ["title: too long", "x"] }), true),
    ).toBe("title: too long");
    expect(releaseBlock(blogPreview({ slugTaken: true }), true)).toBe(
      "Slug existiert bereits",
    );
    expect(releaseBlock(blogPreview({ slugTaken: true }), false)).toBe(
      "Slug already exists",
    );
  });
});

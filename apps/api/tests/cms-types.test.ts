import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, contentType, enabledContentType, parseFields } from "../src/modules/cms/types/registry.ts";
import { seoSchema } from "../src/modules/cms/types/seo.ts";
import { absoluteUrl, entryPath, siteRoutes } from "../src/modules/cms/types/routes.ts";
import { jsonLdScriptContent, structuredData } from "../src/modules/cms/types/json-ld.ts";

describe("content type registry (CH1.7)", () => {
  it("has article active and the later types defined but off", () => {
    expect(CONTENT_TYPES.map((def) => [def.key, def.enabled])).toEqual([
      ["article", true],
      ["faq", false],
      ["help_doc", false],
      ["changelog", false],
      ["product", false],
    ]);
    expect(enabledContentType("article").structuredData).toBe("BlogPosting");
    expect(() => enabledContentType("faq")).toThrow("CMS_TYPE_UNAVAILABLE");
    expect(() => enabledContentType("page")).toThrow("CMS_TYPE_UNAVAILABLE");
    expect(contentType("changelog")?.defaultRoute).toBe("/changelog/{slug}/");
  });

  it("fills article defaults and validates its fields", () => {
    expect(parseFields("article", undefined)).toEqual({ faqs: [], checklist: [], relatedLinks: [], cta: null });
    const fields = parseFields("article", {
      faqs: [{ question: "Kostet es etwas?", answer: "Nein." }],
      relatedLinks: [{ label: "Hilfe", href: "/hilfe/" }],
      cta: { label: "Jetzt testen", href: "https://familyplan.cloud/app" },
    });
    expect(fields.faqs).toHaveLength(1);
    for (const bad of [
      { relatedLinks: [{ label: "x", href: "javascript:alert(1)" }] },
      { cta: { label: "x", href: "http://insecure.example" } },
      { faqs: Array.from({ length: 21 }, () => ({ question: "q", answer: "a" })) },
      { extra: true },
    ]) {
      expect(() => parseFields("article", bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseFields("unknown", {})).toThrow("CMS_TYPE_UNKNOWN");
  });
});

describe("SEO fields", () => {
  it("accepts complete values and refuses oversized or unsafe ones", () => {
    expect(
      seoSchema.parse({
        seoTitle: "Familienkalender teilen",
        metaDescription: "So teilst du den Kalender.",
        canonicalOverride: "https://familyplan.cloud/blog/kalender/",
        robots: { index: true, follow: true },
        keywords: ["familienkalender"],
      }).robots,
    ).toEqual({ index: true, follow: true });
    for (const bad of [
      { seoTitle: "x".repeat(71) },
      { metaDescription: "x".repeat(171) },
      { canonicalOverride: "http://example.com/" },
      { canonicalOverride: "https://user:pw@example.com/" },
      { keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) },
      { seoTitle: "" },
      { other: 1 },
    ]) {
      expect(() => seoSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("site routes", () => {
  const routes = siteRoutes.parse({ article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } });

  it("builds entry paths with the site's trailing slash rule", () => {
    expect(entryPath(routes, "article", "de", "kalender-teilen", true)).toBe("/blog/kalender-teilen/");
    expect(entryPath(routes, "article", "en", "share-calendar", false)).toBe("/en/blog/share-calendar");
    // A locale or type without its own pattern uses the type's default route.
    expect(entryPath(routes, "article", "fr", "x", true)).toBe("/blog/x/");
    expect(entryPath({}, "help_doc", "de", "x", true)).toBe("/help/x/");
    expect(() => entryPath({}, "page", "de", "x", true)).toThrow("CMS_ROUTE_UNKNOWN");
    expect(absoluteUrl("https://familyplan.cloud", "/blog/x/")).toBe("https://familyplan.cloud/blog/x/");
  });

  it("refuses patterns without exactly one {slug} or with foreign characters", () => {
    for (const bad of ["/blog/", "blog/{slug}", "/blog/{slug}/{slug}/", "/Blog/{slug}/", "//{slug}", "/blog/{id}/", "/a?b={slug}"]) {
      expect(() => siteRoutes.parse({ article: { de: bad } }), bad).toThrow();
    }
  });
});

describe("structured data", () => {
  const base = {
    url: "https://familyplan.cloud/blog/kalender/",
    locale: "de",
    title: "Familienkalender teilen",
    description: "So geht es.",
    datePublished: new Date("2026-11-16T08:00:00Z"),
    dateModified: new Date("2026-11-17T08:00:00Z"),
    image: { url: "https://orbit.example/api/v1/cms/media/a/1200.webp", width: 1200, height: 630 },
    authors: [{ name: "Mario", sameAs: ["https://www.linkedin.com/in/x"] }],
    publisher: { name: "FamilyPlan", url: "https://familyplan.cloud" },
  };

  it("builds BlogPosting, FAQPage and BreadcrumbList", () => {
    const data = structuredData({
      ...base,
      kind: "BlogPosting",
      faqs: [{ question: "Kostet es etwas?", answer: "Nein." }],
      breadcrumbs: [{ name: "Blog", url: "https://familyplan.cloud/blog/" }],
    });
    expect(data.map((item) => item["@type"])).toEqual(["BlogPosting", "FAQPage", "BreadcrumbList"]);
    expect(data[0]).toMatchObject({
      headline: "Familienkalender teilen",
      inLanguage: "de",
      datePublished: "2026-11-16T08:00:00.000Z",
      author: [{ "@type": "Person", name: "Mario" }],
      image: [{ width: 1200, height: 630 }],
    });
    expect((data[2]!.itemListElement as unknown[]).length).toBe(2);
    expect(structuredData({ ...base, kind: "BlogPosting", title: "x".repeat(200) })[0]!.headline).toHaveLength(110);
  });

  it("escapes JSON-LD so content cannot close the script element", () => {
    const json = jsonLdScriptContent({ name: "</script><script>alert(1)</script>&" });
    expect(json).not.toMatch(/[<>&]/);
    expect(JSON.parse(json)).toEqual({ name: "</script><script>alert(1)</script>&" });
  });
});

import { describe, expect, it } from "vitest";
import {
  KnowledgeError,
  validatePublicUrl,
  type FetchPolicy,
} from "../../../../../packages/knowledge/src/index.ts";
import {
  discoverSite,
  MAX_SITE_PAGES,
  readSitePage,
  sitePolicy,
} from "./site-sync.ts";

const ROOT = "https://docs.example.com/";
const options = { languages: ["en", "de"], fallbackLanguage: "de" };
const xml = (body: string, tag = "urlset") =>
  `<?xml version="1.0"?><${tag}>${body}</${tag}>`;
const urlset = (...urls: string[]) =>
  xml(urls.map((u) => `<url><loc>${u}</loc></url>`).join(""));
const index = (...urls: string[]) =>
  xml(
    urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join(""),
    "sitemapindex",
  );
const doc = (body: string, mimeType = "application/xml") => ({
  bytes: Buffer.from(body),
  mimeType,
});
const notFound = () => new KnowledgeError("SOURCE_NOT_FOUND");

function sitemaps(files: Record<string, string>, failing: string[] = []) {
  const requested: string[] = [];
  const fetchDiscovery = async (url: string) => {
    requested.push(url);
    if (failing.includes(url)) throw new KnowledgeError("SOURCE_FETCH_FAILED");
    const body = files[url];
    if (body === undefined) throw notFound();
    return doc(body);
  };
  return { fetchDiscovery, requested };
}

describe("discoverSite", () => {
  it("expands a sitemap index one level and no deeper", async () => {
    const { fetchDiscovery, requested } = sitemaps({
      [`${ROOT}sitemap.xml`]: index(`${ROOT}sitemap-pages.xml`),
      [`${ROOT}sitemap-pages.xml`]: urlset(`${ROOT}a`, `${ROOT}b`),
    });
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(site.discovery).toBe("sitemap");
    expect(site.pages.map((p) => p.url)).toEqual([`${ROOT}a`, `${ROOT}b`]);
    expect(site.complete).toBe(true);

    const nested = sitemaps({
      [`${ROOT}sitemap.xml`]: index(`${ROOT}one.xml`),
      [`${ROOT}one.xml`]: index(`${ROOT}two.xml`),
      [`${ROOT}two.xml`]: urlset(`${ROOT}deep`),
    });
    const flat = await discoverSite(ROOT, options, {
      fetchDiscovery: nested.fetchDiscovery,
    });
    expect(flat.discovery).toBe("single");
    expect(nested.requested).not.toContain(`${ROOT}two.xml`);
    expect(requested).toHaveLength(2);
  });

  it("reads at most 10 child sitemaps", async () => {
    const children = Array.from({ length: 12 }, (_, i) => `${ROOT}s${i}.xml`);
    const files: Record<string, string> = {
      [`${ROOT}sitemap.xml`]: index(...children),
    };
    children.forEach((c, i) => (files[c] = urlset(`${ROOT}p${i}`)));
    const { fetchDiscovery, requested } = sitemaps(files);
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(site.pages).toHaveLength(10);
    expect(requested.filter((u) => /\/s\d+\.xml$/.test(u))).toHaveLength(10);
  });

  it("drops URLs outside the root", async () => {
    const root = "https://docs.example.com/docs/";
    const { fetchDiscovery, requested } = sitemaps({
      "https://docs.example.com/sitemap.xml": urlset(
        `${root}a`,
        "https://docs.example.com/blog/x",
        "https://docs.example.com/docsx/y",
        "https://docs.example.com/sitemap.xml",
        "https://other.example.com/docs/z",
      ),
    });
    const site = await discoverSite(root, options, { fetchDiscovery });
    expect(site.pages.map((p) => p.url)).toEqual([`${root}a`]);
    // The root sitemap is tried first, then the origin one.
    expect(requested).toEqual([
      `${root}sitemap.xml`,
      "https://docs.example.com/sitemap.xml",
    ]);
  });

  it("lists the root once with and without a trailing slash", async () => {
    const { fetchDiscovery } = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset(
        "https://docs.example.com",
        "https://docs.example.com/",
        `${ROOT}a`,
      ),
    });
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(site.pages.map((p) => p.url)).toEqual([ROOT, `${ROOT}a`]);
  });

  it("caps at 200 and reports capped", async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${ROOT}p${i}`);
    const { fetchDiscovery } = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset(...urls, ...urls.slice(0, 10)),
    });
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(MAX_SITE_PAGES).toBe(200);
    expect(site.pages).toHaveLength(200);
    expect(site.capped).toBe(true);

    const exact = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset(...urls.slice(0, 200)),
    });
    const full = await discoverSite(ROOT, options, {
      fetchDiscovery: exact.fetchDiscovery,
    });
    expect(full.pages).toHaveLength(200);
    expect(full.capped).toBe(false);
  });

  it("falls back to the single root page without a sitemap", async () => {
    const { fetchDiscovery } = sitemaps({});
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(site).toEqual({
      rootUrl: ROOT,
      discovery: "single",
      pages: [{ url: ROOT, language: "de" }],
      capped: false,
      complete: true,
    });
    const empty = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset("https://elsewhere.example.com/a"),
    });
    const unusable = await discoverSite(ROOT, options, {
      fetchDiscovery: empty.fetchDiscovery,
    });
    expect(unusable.discovery).toBe("single");
    expect(unusable.pages.map((p) => p.url)).toEqual([ROOT]);
  });

  it("reports an incomplete discovery when a child sitemap cannot be read", async () => {
    const files = {
      [`${ROOT}sitemap.xml`]: index(`${ROOT}de.xml`, `${ROOT}en.xml`),
      [`${ROOT}de.xml`]: urlset(`${ROOT}de/a`),
    };
    const failing = sitemaps(files, [`${ROOT}en.xml`]);
    const site = await discoverSite(ROOT, options, {
      fetchDiscovery: failing.fetchDiscovery,
    });
    expect(site.discovery).toBe("sitemap");
    expect(site.pages.map((p) => p.url)).toEqual([`${ROOT}de/a`]);
    expect(site.complete).toBe(false);

    // An index that names a child which is gone has not been read in full either.
    const gone = await discoverSite(ROOT, options, {
      fetchDiscovery: sitemaps(files).fetchDiscovery,
    });
    expect(gone.complete).toBe(false);

    const none = await discoverSite(ROOT, options, {
      fetchDiscovery: sitemaps(
        { [`${ROOT}sitemap.xml`]: index(`${ROOT}en.xml`) },
        [`${ROOT}en.xml`],
      ).fetchDiscovery,
    });
    expect(none).toMatchObject({ discovery: "single", complete: false });
  });

  it("reports an incomplete discovery when a sitemap errored before the fallback", async () => {
    const root = "https://docs.example.com/help/";
    const files = {
      "https://docs.example.com/sitemap.xml": urlset(`${root}a`),
    };
    const after = (failing: string[]) =>
      discoverSite(root, options, {
        fetchDiscovery: sitemaps(files, failing).fetchDiscovery,
      });
    expect(await after([`${root}sitemap.xml`])).toMatchObject({
      discovery: "sitemap",
      complete: false,
    });
    // Not found is a clear answer: the origin's sitemap is then the whole list.
    expect(await after([])).toMatchObject({
      discovery: "sitemap",
      complete: true,
    });
  });

  it("treats a non-XML answer at a sitemap address as no sitemap", async () => {
    const root = "https://docs.example.com/help/";
    const requested: string[] = [];
    const site = await discoverSite(root, options, {
      fetchDiscovery: async (url) => {
        requested.push(url);
        throw new KnowledgeError("UNSUPPORTED_MIME");
      },
    });
    expect(requested).toEqual([
      `${root}sitemap.xml`,
      "https://docs.example.com/sitemap.xml",
    ]);
    expect(site).toMatchObject({ discovery: "single", complete: true });
  });

  it("reads /en/ pages as English when en is a content language", async () => {
    const { fetchDiscovery } = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset(`${ROOT}en/start`, `${ROOT}de/start`),
    });
    const site = await discoverSite(ROOT, options, { fetchDiscovery });
    expect(site.pages.map((p) => p.language)).toEqual(["en", "de"]);
  });

  it("uses the fallback language otherwise", async () => {
    const { fetchDiscovery } = sitemaps({
      [`${ROOT}sitemap.xml`]: urlset(`${ROOT}fr/start`, `${ROOT}guide/en`),
    });
    const site = await discoverSite(
      ROOT,
      { languages: ["en"], fallbackLanguage: "es" },
      { fetchDiscovery },
    );
    expect(site.pages.map((p) => p.language)).toEqual(["es", "es"]);
  });
});

describe("readSitePage", () => {
  const url = `${ROOT}guide/start`;
  const policy = sitePolicy(ROOT);
  const pages = (
    files: Record<string, { body: string; mimeType: string } | Error>,
  ) => {
    const requested: string[] = [];
    const fetchPage = async (u: string) => {
      requested.push(u);
      const file = files[u];
      if (!file) throw notFound();
      if (file instanceof Error) throw file;
      return { bytes: Buffer.from(file.body), mimeType: file.mimeType };
    };
    return { fetchPage, requested };
  };
  const html = (body: string) => ({ body, mimeType: "text/html" });

  it("prefers Markdown and drops a first-line llms.txt blockquote", async () => {
    const { fetchPage, requested } = pages({
      [`${url}.md`]: {
        body: "> ## Documentation Index\n> Fetch [llms.txt](https://docs.example.com/llms.txt) first.\n\n# Getting started\n\nHello.",
        mimeType: "text/markdown",
      },
    });
    const page = await readSitePage(url, policy, { fetchPage });
    expect(page).toEqual({
      title: "Getting started",
      text: "# Getting started\n\nHello.",
      mimeType: "text/markdown",
    });
    expect(requested).toEqual([`${url}.md`]);

    const other = pages({
      [`${url}.md`]: {
        body: "> A quote.\n\n# Title\n\nBody",
        mimeType: "text/markdown",
      },
    });
    const kept = await readSitePage(url, policy, {
      fetchPage: other.fetchPage,
    });
    expect(kept.text).toContain("> A quote.");
  });

  it("falls back to HTML on 404", async () => {
    const { fetchPage, requested } = pages({
      [url]: html("<html><body><h1>Start</h1><p>Hello world</p></body></html>"),
    });
    const page = await readSitePage(url, policy, { fetchPage });
    expect(requested).toEqual([`${url}.md`, url]);
    expect(page.mimeType).toBe("text/html");
    expect(page.text).toContain("Hello world");
  });

  it.each([
    "# Page Not Found\n\nThe page you are looking for doesn't exist.",
    "> Fetch [llms.txt](https://docs.example.com/llms.txt).\n\n# page not found\n\nGone.",
    "# Seite nicht gefunden\n\nDiese Seite gibt es nicht.",
    "# 404\n\nNope.",
  ])("treats a not-found Markdown page as unusable: %j", async (body) => {
    const { fetchPage, requested } = pages({
      [`${url}.md`]: { body, mimeType: "text/markdown" },
      [url]: html("<html><body><h1>English</h1><p>Welcome</p></body></html>"),
    });
    const page = await readSitePage(url, policy, { fetchPage });
    expect(requested).toEqual([`${url}.md`, url]);
    expect(page).toMatchObject({ title: "English", mimeType: "text/html" });
  });

  it("keeps a Markdown page that only mentions being not found", async () => {
    const { fetchPage } = pages({
      [`${url}.md`]: {
        body: "# Fixing 404 errors\n\nPage Not Found is a common message.",
        mimeType: "text/markdown",
      },
    });
    const page = await readSitePage(url, policy, { fetchPage });
    expect(page.mimeType).toBe("text/markdown");
  });

  it("falls back to HTML when the Markdown body is empty or not Markdown", async () => {
    for (const md of [
      {
        body: "> See llms.txt at /llms.txt\n\n  \n",
        mimeType: "text/markdown",
      },
      { body: "# Wrong type", mimeType: "text/html" },
      new Error("socket hang up"),
    ]) {
      const { fetchPage } = pages({
        [`${url}.md`]: md,
        [url]: html("<html><body><p>From HTML</p></body></html>"),
      });
      const page = await readSitePage(url, policy, { fetchPage });
      expect(page.mimeType).toBe("text/html");
      expect(page.text).toContain("From HTML");
    }
  });

  it("propagates an error fetching the HTML itself", async () => {
    const { fetchPage } = pages({
      [url]: new KnowledgeError("SOURCE_FETCH_FAILED"),
    });
    await expect(
      readSitePage(url, policy, { fetchPage }),
    ).rejects.toMatchObject({
      code: "SOURCE_FETCH_FAILED",
    });
  });

  it("takes the title from the first heading, else <title>, else the path", async () => {
    const heading = pages({
      [url]: html(
        "<html><head><title>Tab</title></head><body><h2>Heading</h2><p>x</p></body></html>",
      ),
    });
    expect(
      (await readSitePage(url, policy, { fetchPage: heading.fetchPage })).title,
    ).toBe("Heading");
    const titled = pages({
      [url]: html(
        "<html><head><title>Tab &amp; more</title></head><body><p>text</p></body></html>",
      ),
    });
    expect(
      (await readSitePage(url, policy, { fetchPage: titled.fetchPage })).title,
    ).toBe("Tab & more");
    const bare = pages({
      [url]: html("<html><body><p>text</p></body></html>"),
    });
    expect(
      (await readSitePage(url, policy, { fetchPage: bare.fetchPage })).title,
    ).toBe("/guide/start");
  });

  it("only requests a .md path the policy permits", async () => {
    const docs = "https://docs.example.com/docs";
    const { fetchPage, requested } = pages({
      [docs]: html("<html><body><p>Root page</p></body></html>"),
    });
    const guarded = async (u: string, p: FetchPolicy) => {
      validatePublicUrl(u, p);
      return fetchPage(u);
    };
    const page = await readSitePage(docs, sitePolicy(`${docs}/`), {
      fetchPage: guarded,
    });
    expect(page.text).toContain("Root page");
    expect(requested).toEqual([docs]);
  });
});

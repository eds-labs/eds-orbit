import {
  extractDocument,
  fetchApprovedDocument,
  fetchDiscoveryDocument,
  discoverPublicPages,
  MIME,
  type FetchPolicy,
} from "../../../../../packages/knowledge/src/index.ts";

export const MAX_SITE_PAGES = 200;
const MAX_CHILD_SITEMAPS = 10;

export type SitePage = { url: string; language: string };
export type SiteDiscovery = {
  rootUrl: string;
  discovery: "sitemap" | "single";
  pages: SitePage[];
  capped: boolean;
  /** False when a sitemap could not be read, so a page may be absent only by that. */
  complete: boolean;
};

type Fetched = { bytes: Buffer; mimeType: string };
type FetchDocument = (url: string, policy: FetchPolicy) => Promise<Fetched>;
type DiscoverDeps = {
  fetchDiscovery?: FetchDocument;
  fetchPage?: FetchDocument;
};

/** The root path without a trailing slash, so `/docs` and `/docs/` mean the same prefix. */
function rootPath(root: URL) {
  return root.pathname === "/" ? "/" : root.pathname.replace(/\/+$/, "");
}

/** Pages may only come from the source's origin and root path. */
export function sitePolicy(rootUrl: string): FetchPolicy {
  const root = new URL(rootUrl);
  return {
    allowedOrigins: [root.origin],
    allowedPaths: [rootPath(root)],
    maxBytes: 1_000_000,
  };
}

/** Sitemaps may additionally be read from `<origin>/sitemap.xml`; that never admits pages. */
function discoveryPolicy(rootUrl: string): FetchPolicy {
  const policy = sitePolicy(rootUrl);
  return {
    ...policy,
    allowedPaths: [...policy.allowedPaths, "/sitemap.xml"],
  };
}

function pageLanguage(
  url: string,
  root: URL,
  languages: string[],
  fallbackLanguage: string,
) {
  const base = rootPath(root) === "/" ? "" : rootPath(root);
  const rest = new URL(url).pathname.slice(base.length).replace(/^\/+/, "");
  const segment = rest.split("/")[0]?.toLowerCase() ?? "";
  return languages.find((l) => l.toLowerCase() === segment) ?? fallbackLanguage;
}

function isRoot(url: string, root: URL) {
  const u = new URL(url);
  return (
    u.origin === root.origin &&
    u.search === root.search &&
    u.pathname.replace(/\/+$/, "") === root.pathname.replace(/\/+$/, "")
  );
}

async function readSitemapUrls(
  sitemapUrl: string,
  rootUrl: string,
  fetchDiscovery: FetchDocument,
): Promise<{ urls: string[]; complete: boolean }> {
  const pagePolicy = sitePolicy(rootUrl);
  const discovery = discoveryPolicy(rootUrl);
  const read = async (url: string) =>
    (await fetchDiscovery(url, discovery)).bytes.toString("utf8");
  const xml = await read(sitemapUrl);
  if (!/<sitemapindex[\s>]/i.test(xml))
    return {
      urls: discoverPublicPages(xml, pagePolicy, MAX_SITE_PAGES * 5),
      complete: true,
    };
  // An index is expanded one level and never deeper.
  const children = discoverPublicPages(xml, discovery, MAX_CHILD_SITEMAPS);
  const urls: string[] = [];
  let complete = true;
  for (const child of children) {
    try {
      const childXml = await read(child);
      if (/<sitemapindex[\s>]/i.test(childXml)) continue;
      urls.push(
        ...discoverPublicPages(childXml, pagePolicy, MAX_SITE_PAGES * 5),
      );
    } catch {
      // One unreadable child sitemap does not stop the others, but its pages
      // are unknown now: they have not been delisted.
      complete = false;
    }
  }
  return { urls, complete };
}

export async function discoverSite(
  rootUrl: string,
  options: { languages: string[]; fallbackLanguage: string },
  deps: DiscoverDeps = {},
): Promise<SiteDiscovery> {
  const fetchDiscovery: FetchDocument =
    deps.fetchDiscovery ?? ((u, p) => fetchDiscoveryDocument(u, p));
  const root = new URL(rootUrl);
  const candidates = [
    new URL(
      rootPath(root) === "/" ? "/sitemap.xml" : rootPath(root) + "/sitemap.xml",
      root.origin,
    ).href,
    new URL("/sitemap.xml", root.origin).href,
  ].filter((u, i, all) => all.indexOf(u) === i);

  const language = (url: string) =>
    pageLanguage(url, root, options.languages, options.fallbackLanguage);
  let complete = true;
  for (const candidate of candidates) {
    let found: Awaited<ReturnType<typeof readSitemapUrls>>;
    try {
      found = await readSitemapUrls(candidate, rootUrl, fetchDiscovery);
    } catch (error) {
      // Only "not found" says there is no sitemap here.
      if ((error as { code?: unknown })?.code !== "SOURCE_NOT_FOUND")
        complete = false;
      continue;
    }
    complete &&= found.complete;
    const unique = new Map<string, string>();
    for (const url of found.urls) {
      const key = isRoot(url, root) ? rootUrl : url;
      if (!unique.has(key)) unique.set(key, key);
    }
    if (!unique.size) continue;
    const all = [...unique.keys()];
    return {
      rootUrl,
      discovery: "sitemap",
      pages: all
        .slice(0, MAX_SITE_PAGES)
        .map((url) => ({ url, language: language(url) })),
      capped: all.length > MAX_SITE_PAGES,
      complete,
    };
  }
  return {
    rootUrl,
    discovery: "single",
    pages: [{ url: rootUrl, language: language(rootUrl) }],
    capped: false,
    complete,
  };
}

/** Drops a leading blockquote that only advertises `llms.txt`. */
function dropLlmsNotice(markdown: string) {
  const lines = markdown.replace(/^﻿/, "").split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start]!.trim()) start++;
  let end = start;
  while (end < lines.length && lines[end]!.trimStart().startsWith(">")) end++;
  if (end === start || !/llms\.txt/i.test(lines.slice(start, end).join("\n")))
    return markdown;
  return lines.slice(end).join("\n");
}

function firstHeading(text: string) {
  const match = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  return match?.[1]?.trim() || null;
}

function htmlTitle(html: string) {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.replace(/<[^>]+>/g, "") ?? "";
  return (
    raw
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function pathTitle(url: URL) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

async function readMarkdown(
  url: string,
  policy: FetchPolicy,
  fetchPage: FetchDocument,
) {
  try {
    const md = new URL(url);
    if (md.pathname === "/") return null;
    md.pathname = md.pathname.replace(/\/+$/, "") + ".md";
    const page = await fetchPage(md.href, policy);
    if (page.mimeType !== MIME.md) return null;
    const body = dropLlmsNotice(page.bytes.toString("utf8"));
    if (!body.trim()) return null;
    const { text } = await extractDocument(Buffer.from(body), MIME.md);
    return text;
  } catch {
    return null;
  }
}

export async function readSitePage(
  url: string,
  policy: FetchPolicy,
  deps: { fetchPage?: FetchDocument } = {},
): Promise<{ title: string; text: string; mimeType: string }> {
  const fetchPage: FetchDocument =
    deps.fetchPage ?? ((u, p) => fetchApprovedDocument(u, p));
  const markdown = await readMarkdown(url, policy, fetchPage);
  if (markdown !== null)
    return {
      title: firstHeading(markdown) ?? pathTitle(new URL(url)),
      text: markdown,
      mimeType: MIME.md,
    };
  // An error reading the page itself reaches the caller.
  const page = await fetchPage(url, policy);
  const { text } = await extractDocument(page.bytes, MIME.html);
  return {
    title:
      firstHeading(text) ??
      htmlTitle(page.bytes.toString("utf8")) ??
      pathTitle(new URL(url)),
    text,
    mimeType: MIME.html,
  };
}

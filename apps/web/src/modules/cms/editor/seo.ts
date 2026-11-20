import {
  plainText,
  tableOfContents,
  linkTargets,
  type OrbitDoc,
} from "../../../../../../packages/content-doc/src/index.ts";

// Deterministic SEO hints of the editor (ADR 0029 §8, CH1.14b). They
// recommend; nothing here stops a save or a publication. The ranges match
// SEO_RECOMMENDED on the server (apps/api/src/modules/cms/types/seo.ts).

export const RECOMMENDED = {
  seoTitle: { min: 30, max: 60 },
  metaDescription: { min: 70, max: 155 },
} as const;

/** The hard limits of the server's SEO schema. */
export const SEO_MAX = {
  seoTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  focusKeyword: 80,
  keyword: 60,
  keywords: 10,
} as const;

export type Seo = {
  seoTitle?: string;
  metaDescription?: string;
  canonicalOverride?: string;
  robots?: { index: boolean; follow: boolean };
  ogTitle?: string;
  ogDescription?: string;
  ogImageAssetId?: string;
  focusKeyword?: string;
  keywords?: string[];
};

export type LengthState = "empty" | "short" | "good" | "long";

export function lengthState(
  value: string,
  range: { min: number; max: number },
): LengthState {
  const n = value.trim().length;
  if (n === 0) return "empty";
  if (n < range.min) return "short";
  return n > range.max ? "long" : "good";
}

export type SeoCheckCode =
  | "title_length"
  | "meta_length"
  | "meta_missing"
  | "keyword_missing"
  | "keyword_not_in_title"
  | "keyword_not_in_meta"
  | "keyword_not_in_intro"
  | "headings_skip"
  | "no_headings"
  | "no_internal_links"
  | "noindex";

export type SeoCheck = { code: SeoCheckCode; ok: boolean };

const has = (text: string, keyword: string) =>
  text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());

/** Hints for the current draft; `ok: false` marks what to look at. */
export function seoChecks(input: {
  title: string;
  excerpt: string;
  seo: Seo;
  doc: OrbitDoc;
}): SeoCheck[] {
  const { seo, doc } = input;
  const title = seo.seoTitle?.trim() || input.title.trim();
  const meta = seo.metaDescription?.trim() || input.excerpt.trim();
  const keyword = seo.focusKeyword?.trim() ?? "";
  const checks: SeoCheck[] = [
    {
      code: "title_length",
      ok: lengthState(title, RECOMMENDED.seoTitle) === "good",
    },
    meta
      ? {
          code: "meta_length",
          ok: lengthState(meta, RECOMMENDED.metaDescription) === "good",
        }
      : { code: "meta_missing", ok: false },
  ];
  if (!keyword) checks.push({ code: "keyword_missing", ok: false });
  else {
    const firstParagraph = doc.blocks.find((b) => b.type === "paragraph");
    const intro = firstParagraph
      ? plainText({ ...doc, blocks: [firstParagraph] })
      : "";
    checks.push(
      { code: "keyword_not_in_title", ok: has(title, keyword) },
      { code: "keyword_not_in_meta", ok: Boolean(meta) && has(meta, keyword) },
      { code: "keyword_not_in_intro", ok: has(intro, keyword) },
    );
  }
  const headings = tableOfContents(doc);
  if (headings.length === 0) checks.push({ code: "no_headings", ok: false });
  else {
    let previous = 1;
    let skips = false;
    for (const heading of headings) {
      if (heading.level > previous + 1) skips = true;
      previous = heading.level;
    }
    checks.push({ code: "headings_skip", ok: !skips });
  }
  const internal = linkTargets(doc).some(
    (href) => href.startsWith("/") || href.startsWith("#"),
  );
  checks.push({ code: "no_internal_links", ok: internal });
  if (seo.robots && !seo.robots.index)
    checks.push({ code: "noindex", ok: false });
  return checks;
}

/** True for a full https:// address, as the server requires for canonicals. */
export function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

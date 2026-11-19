import sanitizeHtml from "sanitize-html";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  excerpt as textExcerpt,
  plainText,
  readingTimeMinutes,
  referencedAssetIds,
  renderHtml,
  tableOfContents,
  type OrbitDoc,
} from "../../../../../../packages/content-doc/src/index.ts";
import { renditionsOf } from "../media/assets.ts";
import { cmsMediaUrl } from "../media/public-media.ts";
import { structuredData } from "../types/json-ld.ts";
import { contentType } from "../types/registry.ts";
import { absoluteUrl } from "../types/routes.ts";
import type { SiteRow } from "./live.ts";

// What websites receive (ADR 0029 §4.2, CH1.12): published content in the
// shape a page needs, with paths and URLs for the site, image renditions with
// sizes, rendered and sanitized HTML, a table of contents and ready JSON-LD.
// Nothing internal (who edited, approvals, focus keywords) leaves Orbit.

type AssetRow = Awaited<ReturnType<DbTx["cmsAsset"]["findFirstOrThrow"]>>;
type AuthorRow = Awaited<ReturnType<DbTx["cmsAuthor"]["findFirstOrThrow"]>>;
type TermRow = Awaited<ReturnType<DbTx["cmsTaxonomyTerm"]["findFirstOrThrow"]>>;
type EntryRow = Awaited<ReturnType<DbTx["cmsEntry"]["findFirstOrThrow"]>>;

/** The content of an entry to show: a live revision, or a draft in preview. */
export interface ShownContent {
  slug: string;
  title: string;
  excerpt: string;
  body: unknown;
  fields: unknown;
  seo: unknown;
  heroAssetId: string | null;
  authorIds: readonly string[];
  termIds: readonly string[];
}

export type MediaUrl = (asset: AssetRow, rendition: string) => string;

const AI_ORIGINS = new Set(["ai_generated", "ai_substantially_modified"]);

/** Assets, authors and terms a set of content refers to, loaded once. */
export class Refs {
  assets = new Map<string, AssetRow>();
  aiAssets = new Set<string>();
  authors = new Map<string, AuthorRow>();
  terms = new Map<string, TermRow>();

  static async load(tx: DbTx, scope: Pick<Scope, "projectId">, contents: readonly ShownContent[], options: { body?: boolean } = {}) {
    const refs = new Refs();
    const authorIds = [...new Set(contents.flatMap((c) => c.authorIds))];
    const termIds = [...new Set(contents.flatMap((c) => c.termIds))];
    if (authorIds.length)
      for (const a of await tx.cmsAuthor.findMany({ where: { projectId: scope.projectId, id: { in: authorIds } } })) refs.authors.set(a.id, a);
    if (termIds.length)
      for (const t of await tx.cmsTaxonomyTerm.findMany({ where: { projectId: scope.projectId, id: { in: termIds } } })) refs.terms.set(t.id, t);
    const assetIds = new Set<string>();
    for (const c of contents) {
      if (c.heroAssetId) assetIds.add(c.heroAssetId);
      const og = ogImageOf(c.seo);
      if (og) assetIds.add(og);
      if (options.body) for (const id of referencedAssetIds(c.body as OrbitDoc)) assetIds.add(id);
    }
    for (const a of refs.authors.values()) if (a.avatarAssetId) assetIds.add(a.avatarAssetId);
    if (assetIds.size) {
      const rows = await tx.cmsAsset.findMany({ where: { projectId: scope.projectId, id: { in: [...assetIds] } } });
      for (const a of rows) refs.assets.set(a.id, a);
      const provenanceIds = rows.flatMap((a) => (a.provenanceId ? [a.provenanceId] : []));
      if (provenanceIds.length) {
        const records = await tx.imageProvenance.findMany({
          where: { projectId: scope.projectId, id: { in: provenanceIds } },
          select: { id: true, origin: true },
        });
        const ai = new Set(records.filter((r) => AI_ORIGINS.has(r.origin)).map((r) => r.id));
        for (const a of rows) if (a.provenanceId && ai.has(a.provenanceId)) refs.aiAssets.add(a.id);
      }
    }
    return refs;
  }
}

const ogImageOf = (seo: unknown) => {
  const id = (seo as { ogImageAssetId?: unknown } | null)?.ogImageAssetId;
  return typeof id === "string" ? id : null;
};
const localized = (value: unknown, locale: string) => {
  const text = (value as Record<string, string> | null)?.[locale];
  return typeof text === "string" && text.trim() ? text : null;
};

/** An image with its renditions for `<img srcset>` and the Open Graph crop. */
export function imageView(asset: AssetRow, locale: string, url: MediaUrl, aiGenerated: boolean) {
  const renditions = renditionsOf(asset);
  const widths = renditions.filter((r) => /^w\d+$/.test(r.name)).sort((a, b) => a.width - b.width);
  const main = widths.find((r) => r.name === "w960") ?? widths.at(-1) ?? renditions[0]!;
  const og = renditions.find((r) => r.name === "og");
  return {
    assetId: asset.id,
    alt: localized(asset.alt, locale) ?? "",
    caption: localized(asset.caption, locale),
    credit: asset.credit,
    /** Shown as "KI erstellt" / "AI generated" next to the image (ADR 0028). */
    aiGenerated,
    width: asset.width,
    height: asset.height,
    src: url(asset, main.name),
    srcset: widths.map((r) => `${url(asset, r.name)} ${r.width}w`).join(", "),
    og: og ? { url: url(asset, "og"), width: og.width, height: og.height } : null,
    renditions: renditions.map((r) => ({ name: r.name, url: url(asset, r.name), mime: r.mime, width: r.width, height: r.height })),
  };
}

const heroOf = (refs: Refs, content: ShownContent, locale: string, url: MediaUrl) => {
  const asset = content.heroAssetId ? refs.assets.get(content.heroAssetId) : undefined;
  return asset ? imageView(asset, locale, url, refs.aiAssets.has(asset.id)) : null;
};

const authorsOf = (refs: Refs, content: ShownContent, locale: string, url: MediaUrl, full: boolean) =>
  content.authorIds.flatMap((id) => {
    const author = refs.authors.get(id);
    if (!author) return [];
    const avatar = author.avatarAssetId ? refs.assets.get(author.avatarAssetId) : undefined;
    return [
      {
        id: author.id,
        name: author.name,
        slug: author.slug,
        ...(full
          ? {
              bio: localized(author.bio, locale),
              sameAs: author.sameAs,
              avatar: avatar ? imageView(avatar, locale, url, refs.aiAssets.has(avatar.id)) : null,
            }
          : {}),
      },
    ];
  });

const termsOf = (refs: Refs, content: ShownContent) =>
  content.termIds.flatMap((id) => {
    const term = refs.terms.get(id);
    return term && !term.archivedAt ? [{ id: term.id, kind: term.kind, slug: term.slug, name: term.name }] : [];
  });

/** A list item: enough for cards and indexes. */
export function summaryView(
  site: SiteRow,
  entry: Pick<EntryRow, "id" | "type" | "locale" | "translationGroupId">,
  revision: ShownContent & { id: string; number: number },
  dates: { publishedAt: Date; updatedAt: Date },
  path: string | null,
  refs: Refs,
  url: MediaUrl,
) {
  const doc = revision.body as OrbitDoc;
  return {
    id: entry.id,
    type: entry.type,
    locale: entry.locale,
    translationGroupId: entry.translationGroupId,
    slug: revision.slug,
    path,
    url: path ? absoluteUrl(site.baseUrl, path) : null,
    title: revision.title,
    excerpt: revision.excerpt || textExcerpt(doc),
    readingTimeMinutes: readingTimeMinutes(doc),
    publishedAt: dates.publishedAt.toISOString(),
    updatedAt: dates.updatedAt.toISOString(),
    revision: { id: revision.id, number: revision.number },
    hero: heroOf(refs, revision, entry.locale, url),
    authors: authorsOf(refs, revision, entry.locale, url, false),
    terms: termsOf(refs, revision),
  };
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ["h2", "h3", "h4", "p", "ul", "ol", "li", "blockquote", "aside", "pre", "code", "figure", "img", "figcaption", "hr", "a", "strong", "em", "br"],
  allowedAttributes: {
    a: ["href", "rel"],
    img: ["src", "srcset", "sizes", "width", "height", "alt", "loading", "decoding"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    aside: ["class", "data-tone"],
    code: ["class"],
  },
  allowedSchemes: ["https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

/** Escaping renderer first, sanitize-html as the second layer (ADR 0029 §4.4). */
export function bodyHtml(doc: OrbitDoc, site: SiteRow, locale: string, refs: Refs, url: MediaUrl) {
  const html = renderHtml(doc, {
    siteOrigins: [site.baseUrl],
    resolveAsset: (assetId) => {
      const asset = refs.assets.get(assetId);
      if (!asset) return null;
      const view = imageView(asset, locale, url, refs.aiAssets.has(asset.id));
      return { src: view.src, srcset: view.srcset, sizes: "(min-width: 960px) 960px, 100vw", width: view.width, height: view.height, alt: view.alt };
    },
  });
  return sanitizeHtml(html, SANITIZE);
}

export interface Alternate {
  locale: string;
  path: string;
  url: string;
}

/** The full entry a page renders. */
export function entryView(
  site: SiteRow,
  entry: Pick<EntryRow, "id" | "type" | "locale" | "translationGroupId">,
  revision: ShownContent & { id: string; number: number },
  dates: { publishedAt: Date; updatedAt: Date },
  path: string | null,
  alternates: readonly Alternate[],
  refs: Refs,
  url: MediaUrl,
) {
  const summary = summaryView(site, entry, revision, dates, path, refs, url);
  const doc = revision.body as OrbitDoc;
  const seo = (revision.seo ?? {}) as Record<string, unknown>;
  const fields = (revision.fields ?? {}) as Record<string, unknown>;
  const canonical = typeof seo.canonicalOverride === "string" ? seo.canonicalOverride : summary.url;
  const ogAsset = ogImageOf(seo) ? refs.assets.get(ogImageOf(seo)!) : undefined;
  const ogImage = ogAsset
    ? imageView(ogAsset, entry.locale, url, refs.aiAssets.has(ogAsset.id)).og
    : (summary.hero?.og ?? null);
  const description =
    (typeof seo.metaDescription === "string" && seo.metaDescription) || summary.excerpt;
  const faqs = Array.isArray(fields.faqs) ? fields.faqs : Array.isArray(fields.items) ? fields.items : [];
  const kind = contentType(entry.type)?.structuredData ?? "Article";
  const xDefault = alternates.find((a) => a.locale === site.defaultLocale) ?? null;
  return {
    ...summary,
    authors: authorsOf(refs, revision, entry.locale, url, true),
    body: { doc, html: bodyHtml(doc, site, entry.locale, refs, url), text: plainText(doc) },
    toc: tableOfContents(doc),
    fields,
    seo: {
      title: (typeof seo.seoTitle === "string" && seo.seoTitle) || revision.title,
      description,
      canonical,
      robots: (seo.robots as { index: boolean; follow: boolean } | undefined) ?? { index: true, follow: true },
      keywords: Array.isArray(seo.keywords) ? seo.keywords : [],
      og: {
        title: (typeof seo.ogTitle === "string" && seo.ogTitle) || (typeof seo.seoTitle === "string" && seo.seoTitle) || revision.title,
        description: (typeof seo.ogDescription === "string" && seo.ogDescription) || description,
        image: ogImage,
      },
    },
    alternates: [...alternates, ...(xDefault ? [{ locale: "x-default", path: xDefault.path, url: xDefault.url }] : [])],
    structuredData:
      canonical === null
        ? []
        : structuredData({
            kind,
            url: canonical,
            locale: entry.locale,
            title: revision.title,
            description,
            datePublished: dates.publishedAt,
            dateModified: dates.updatedAt,
            image: ogImage,
            authors: authorsOf(refs, revision, entry.locale, url, true).map((a) => ({ name: a.name, sameAs: a.sameAs })),
            publisher: { name: site.name, url: `${site.baseUrl}/` },
            faqs: faqs as Array<{ question: string; answer: string }>,
            breadcrumbs: [{ name: site.name, url: `${site.baseUrl}/` }],
          }),
  };
}

/** Media URLs for live content: the public, signed, cacheable route (CH1.9). */
export const publicMediaUrl = (scope: Pick<Scope, "projectId">): MediaUrl => (asset, rendition) => cmsMediaUrl(scope, asset, rendition);

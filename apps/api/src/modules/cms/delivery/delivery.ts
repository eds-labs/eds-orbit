import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { escapeHtml } from "../../../../../../packages/content-doc/src/index.ts";
import { notFound, refused, slugInput, localeInput } from "../entries/common.ts";
import { absoluteUrl } from "../types/routes.ts";
import { liveRows, pathOf, resolveRedirects, type LiveRow, type SiteRow } from "./live.ts";
import { entryView, imageView, publicMediaUrl, Refs, summaryView, type Alternate, type MediaUrl } from "./views.ts";

// The delivery API's reads (ADR 0029 §4.2, CH1.12). Every read is scoped to
// one site the key may read and shows only what is live there (live.ts).

type RevisionRow = Awaited<ReturnType<DbTx["cmsRevision"]["findFirstOrThrow"]>>;
type EntryRow = Awaited<ReturnType<DbTx["cmsEntry"]["findFirstOrThrow"]>>;

const typeKey = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/);
const cursorOf = (row: LiveRow) => Buffer.from(JSON.stringify({ at: row.publishedAt.toISOString(), id: row.id })).toString("base64url");
function decode(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const parsed = z.object({ at: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw refused("CURSOR_INVALID", 400);
  }
}

/** Entries and revisions of live rows, in row order. */
async function loadLive(tx: DbTx, scope: Pick<Scope, "projectId">, rows: readonly LiveRow[]) {
  if (!rows.length) return [];
  const [entries, revisions] = await Promise.all([
    tx.cmsEntry.findMany({ where: { projectId: scope.projectId, id: { in: rows.map((r) => r.id) } } }),
    tx.cmsRevision.findMany({ where: { projectId: scope.projectId, id: { in: rows.map((r) => r.revisionId) } } }),
  ]);
  return rows.flatMap((row) => {
    const entry = entries.find((e) => e.id === row.id);
    const revision = revisions.find((r) => r.id === row.revisionId);
    return entry && revision ? [{ row, entry, revision }] : [];
  });
}

/** A term by slug in a locale, for list filters. */
async function termBySlug(tx: DbTx, scope: Pick<Scope, "projectId">, kind: "category" | "tag", locale: string, slug: string) {
  const term = await tx.cmsTaxonomyTerm.findFirst({ where: { projectId: scope.projectId, kind, locale, slug, archivedAt: null }, select: { id: true } });
  return term?.id ?? null;
}

const listQuery = z
  .object({
    type: typeKey.default("article"),
    locale: localeInput.optional(),
    category: slugInput(120).optional(),
    tag: slugInput(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export async function listLiveEntries(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, raw: unknown, url: MediaUrl = publicMediaUrl(scope)) {
  const q = listQuery.parse(raw ?? {});
  if ((q.category || q.tag) && !q.locale) throw refused("CMS_LOCALE_REQUIRED", 422);
  if (q.category && q.tag) throw refused("CMS_FILTER_CONFLICT", 422);
  let termId: string | undefined;
  if (q.category || q.tag) {
    const found = await termBySlug(tx, scope, q.category ? "category" : "tag", q.locale!, (q.category ?? q.tag)!);
    if (!found) return { items: [], nextCursor: null };
    termId = found;
  }
  const rows = await liveRows(tx, scope, site.id, { type: q.type, locale: q.locale, termId }, { limit: q.limit + 1, after: decode(q.cursor) });
  const shown = await loadLive(tx, scope, rows.slice(0, q.limit));
  const refs = await Refs.load(tx, scope, shown.map((s) => s.revision));
  return {
    items: shown.map(({ row, entry, revision }) =>
      summaryView(site, entry, revision, row, pathOf(site, entry, revision.slug), refs, url),
    ),
    nextCursor: rows.length > q.limit ? cursorOf(rows[q.limit - 1]!) : null,
  };
}

/** Live translations of an entry on the site, as hreflang alternates (the entry included). */
async function alternatesOf(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, entry: EntryRow): Promise<Alternate[]> {
  const rows = await liveRows(tx, scope, site.id, { type: entry.type, translationGroupIds: [entry.translationGroupId] }, { limit: 25 });
  const live = await loadLive(tx, scope, rows);
  return live
    .flatMap(({ entry: e, revision }) => {
      const path = pathOf(site, e, revision.slug);
      return path && site.locales.includes(e.locale) ? [{ locale: e.locale, path, url: absoluteUrl(site.baseUrl, path) }] : [];
    })
    .sort((a, b) => a.locale.localeCompare(b.locale));
}

/** The full entry view of a live or previewed revision on a site. */
export async function fullEntry(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  site: SiteRow,
  entry: EntryRow,
  revision: Pick<RevisionRow, "id" | "number" | "slug" | "title" | "excerpt" | "body" | "fields" | "seo" | "heroAssetId" | "authorIds" | "termIds">,
  dates: { publishedAt: Date; updatedAt: Date },
  url: MediaUrl,
) {
  const refs = await Refs.load(tx, scope, [revision], { body: true });
  const alternates = await alternatesOf(tx, scope, site, entry);
  return entryView(site, entry, revision, dates, pathOf(site, entry, revision.slug), alternates, refs, url);
}

const slugQuery = z.object({ locale: localeInput.optional() }).strict();

export async function liveEntryBySlug(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, type: string, slug: string, raw: unknown) {
  const { locale = site.defaultLocale } = slugQuery.parse(raw ?? {});
  const parsedType = typeKey.safeParse(type);
  const parsedSlug = slugInput(120).safeParse(slug);
  if (!parsedType.success || !parsedSlug.success) throw notFound();
  const [row] = await liveRows(tx, scope, site.id, { type, locale, slug }, { limit: 1 });
  if (!row) {
    // An old address: tell the site where the content went (it may also use /redirects).
    const path = pathOf(site, { type, locale }, slug);
    const redirect = path
      ? await tx.cmsRedirect.findFirst({ where: { projectId: scope.projectId, siteId: site.id, fromPath: path, removedAt: null } })
      : null;
    const [resolved] = redirect ? await resolveRedirects(tx, scope, site, [redirect]) : [];
    throw refused("CMS_ENTRY_NOT_FOUND", 404, resolved ? { redirect: resolved } : undefined);
  }
  const [live] = await loadLive(tx, scope, [row]);
  if (!live) throw notFound();
  return fullEntry(tx, scope, site, live.entry, live.revision, row, publicMediaUrl(scope));
}

const termQuery = z.object({ locale: localeInput.optional() }).strict();

/** Live revisions of the whole site (ids, terms, authors), for counts and the manifest. */
async function siteInventory(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow) {
  const rows = await liveRows(tx, scope, site.id, {}, { limit: 10_000 });
  const revisions = rows.length
    ? await tx.cmsRevision.findMany({
        where: { projectId: scope.projectId, id: { in: rows.map((r) => r.revisionId) } },
        select: { id: true, entryId: true, termIds: true, authorIds: true, seo: true, slug: true },
      })
    : [];
  return { rows, revisions };
}

export async function liveTerms(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, kind: string, raw: unknown) {
  if (kind !== "category" && kind !== "tag") throw notFound("CMS_TAXONOMY_NOT_FOUND");
  const { locale } = termQuery.parse(raw ?? {});
  const { revisions } = await siteInventory(tx, scope, site);
  const counts = new Map<string, number>();
  for (const r of revisions) for (const id of r.termIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const terms = await tx.cmsTaxonomyTerm.findMany({
    where: { projectId: scope.projectId, kind, archivedAt: null, locale: locale ? locale : { in: site.locales } },
    orderBy: [{ locale: "asc" }, { name: "asc" }],
    take: 1000,
  });
  // Only terms live content on this site uses, with their parents: a key
  // for one site does not list another site's or a draft's categories.
  const parentOf = new Map(terms.map((t) => [t.id, t.parentId]));
  const shown = new Set<string>();
  for (const id of counts.keys())
    for (let at: string | null | undefined = id; at && !shown.has(at); at = parentOf.get(at)) shown.add(at);
  return {
    items: terms.filter((t) => shown.has(t.id)).map((t) => ({
      id: t.id,
      locale: t.locale,
      translationGroupId: t.translationGroupId,
      slug: t.slug,
      name: t.name,
      description: t.description,
      parentId: t.parentId,
      entries: counts.get(t.id) ?? 0,
    })),
  };
}

/** Authors named on content live on the site (no one else is public). */
export async function liveAuthors(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, raw: unknown) {
  const { locale = site.defaultLocale } = termQuery.parse(raw ?? {});
  const { revisions } = await siteInventory(tx, scope, site);
  const ids = [...new Set(revisions.flatMap((r) => r.authorIds))];
  const shown = { slug: "", title: "", excerpt: "", body: { schema: "orbit-doc", version: 1, blocks: [] }, fields: {}, seo: {}, heroAssetId: null, authorIds: ids, termIds: [] };
  const refs = await Refs.load(tx, scope, [shown]);
  const url = publicMediaUrl(scope);
  return {
    items: [...refs.authors.values()]
      .filter((a) => !a.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => {
        const avatar = a.avatarAssetId ? refs.assets.get(a.avatarAssetId) : undefined;
        const bio = (a.bio as Record<string, string> | null)?.[locale];
        return {
          id: a.id,
          name: a.name,
          slug: a.slug,
          bio: bio?.trim() ? bio : null,
          sameAs: a.sameAs,
          avatar: avatar ? imageView(avatar, locale, url, refs.aiAssets.has(avatar.id)) : null,
        };
      }),
  };
}

const pageQuery = (max: number, fallback: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(fallback), cursor: z.string().max(512).optional() }).strict();

export async function liveRedirects(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, raw: unknown) {
  const q = pageQuery(1000, 500).parse(raw ?? {});
  const after = decode(q.cursor);
  const rows = await tx.cmsRedirect.findMany({
    where: {
      projectId: scope.projectId,
      siteId: site.id,
      removedAt: null,
      ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await resolveRedirects(tx, scope, site, page),
    nextCursor:
      rows.length > q.limit && last ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null,
  };
}

const sitemapQuery = z
  .object({ locale: localeInput.optional(), limit: z.coerce.number().int().min(1).max(1000).default(1000), cursor: z.string().max(512).optional() })
  .strict();

/** Pages for the site's sitemap: indexable live entries with lastmod and alternates. */
export async function liveSitemap(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, raw: unknown) {
  const q = sitemapQuery.parse(raw ?? {});
  const rows = await liveRows(tx, scope, site.id, { locale: q.locale }, { limit: q.limit + 1, after: decode(q.cursor) });
  const live = await loadLive(tx, scope, rows.slice(0, q.limit));
  const groups = [...new Set(live.map((l) => l.entry.translationGroupId))];
  // Translations of these entries live on the site, for hreflang in the sitemap.
  const siblings = groups.length
    ? await loadLive(tx, scope, await liveRows(tx, scope, site.id, { translationGroupIds: groups }, { limit: groups.length * 25 }))
    : [];
  const byGroup = new Map<string, Alternate[]>();
  for (const s of siblings) {
    const path = pathOf(site, s.entry, s.revision.slug);
    if (!path) continue;
    const list = byGroup.get(s.entry.translationGroupId) ?? [];
    list.push({ locale: s.entry.locale, path, url: absoluteUrl(site.baseUrl, path) });
    byGroup.set(s.entry.translationGroupId, list);
  }
  const items = live.flatMap(({ row, entry, revision }) => {
    const path = pathOf(site, entry, revision.slug);
    const robots = (revision.seo as { robots?: { index?: boolean } } | null)?.robots;
    if (!path || robots?.index === false) return [];
    const alternates = (byGroup.get(entry.translationGroupId) ?? []).sort((a, b) => a.locale.localeCompare(b.locale));
    return [{ type: entry.type, locale: entry.locale, path, url: absoluteUrl(site.baseUrl, path), lastmod: row.updatedAt.toISOString(), alternates: alternates.length > 1 ? alternates : [] }];
  });
  return { items, nextCursor: rows.length > q.limit ? cursorOf(rows[q.limit - 1]!) : null };
}

const feedQuery = z
  .object({
    type: typeKey.default("article"),
    locale: localeInput.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    format: z.enum(["json", "rss"]).default("json"),
  })
  .strict();

const xml = (value: string) => escapeHtml(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** The newest live entries of a type and locale, as data or as RSS 2.0. */
export async function liveFeed(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, raw: unknown) {
  const q = feedQuery.parse(raw ?? {});
  const locale = q.locale ?? site.defaultLocale;
  const list = await listLiveEntries(tx, scope, site, { type: q.type, locale, limit: q.limit });
  const items = list.items.filter((i) => i.url);
  const updated = items.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), "");
  if (q.format === "json")
    return { kind: "json" as const, body: { title: site.name, home: `${site.baseUrl}/`, locale, updatedAt: updated || null, items } };
  const rss = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0"><channel>`,
    `<title>${xml(site.name)}</title><link>${xml(`${site.baseUrl}/`)}</link><description>${xml(site.name)}</description><language>${xml(locale)}</language>`,
    ...(updated ? [`<lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`] : []),
    ...items.map(
      (i) =>
        `<item><title>${xml(i.title)}</title><link>${xml(i.url!)}</link><guid isPermaLink="false">${xml(`orbit:${i.id}`)}</guid>` +
        `<pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate><description>${xml(i.excerpt)}</description>` +
        i.terms.filter((t) => t.kind === "category").map((t) => `<category>${xml(t.name)}</category>`).join("") +
        (i.hero ? `<enclosure url="${xml(i.hero.src)}" type="image/webp" length="0"/>` : "") +
        `</item>`,
    ),
    `</channel></rss>`,
  ].join("\n");
  return { kind: "rss" as const, body: rss };
}

/**
 * The site as a whole: settings, live entry count and one revision hash over
 * all live revisions and redirects. A build compares it with its snapshot
 * and refetches only when it changed.
 */
export async function liveManifest(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow) {
  const { rows } = await siteInventory(tx, scope, site);
  const redirects = await tx.cmsRedirect.findMany({
    where: { projectId: scope.projectId, siteId: site.id, removedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const hash = createHash("sha256");
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) hash.update(`${r.id}:${r.revisionId};`);
  hash.update("|");
  for (const r of redirects) hash.update(`${r.id};`);
  hash.update(`|${site.version}`);
  // Terms, authors and media render into entries without a new revision
  // (a renamed category, an alt text): their latest change counts too. The
  // project-wide maximum may refetch a little more often, never too rarely.
  const where = { projectId: scope.projectId };
  const [terms, authors, assets] = await Promise.all([
    tx.cmsTaxonomyTerm.aggregate({ where, _max: { updatedAt: true } }),
    tx.cmsAuthor.aggregate({ where, _max: { updatedAt: true } }),
    tx.cmsAsset.aggregate({ where, _max: { updatedAt: true } }),
  ]);
  for (const at of [terms._max.updatedAt, authors._max.updatedAt, assets._max.updatedAt]) hash.update(`|${at?.toISOString() ?? "-"}`);
  return {
    site: {
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      locales: site.locales,
      defaultLocale: site.defaultLocale,
      routes: site.routes,
      trailingSlash: site.trailingSlash,
    },
    entries: rows.length,
    redirects: redirects.length,
    revision: hash.digest("hex").slice(0, 32),
  };
}

import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { ApiPrincipal } from "../../../platform/api-keys/keys.ts";
import { notFound, UUID_RE } from "../entries/common.ts";
import { entryPath, siteRoutes, type SiteRoutes } from "../types/routes.ts";

// What a site shows (ADR 0029 §4.2, CH1.12). An entry is live on a site when
// its live revision went live there: a publication of that revision on that
// site reached `visible` (or later). Changing an entry's sites therefore
// takes effect with its next publication, exactly like the content itself,
// and a site never shows a revision nobody approved for it.

export const LIVE_PUBLICATION = ["visible", "notified", "live_verified"] as const;

export type SiteRow = Awaited<ReturnType<DbTx["cmsSite"]["findFirstOrThrow"]>>;

/** The site a key may read: in the key's site filter, active. Anything else is 404. */
export async function deliverySite(tx: DbTx, principal: Pick<ApiPrincipal, "projectId" | "resourceFilter">, siteId: string) {
  if (!UUID_RE.test(siteId)) throw notFound("CMS_SITE_NOT_FOUND");
  const allowed = principal.resourceFilter.siteIds;
  if (allowed && !allowed.includes(siteId)) throw notFound("CMS_SITE_NOT_FOUND");
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: principal.projectId, archivedAt: null } });
  if (!site) throw notFound("CMS_SITE_NOT_FOUND");
  return site;
}

export interface LiveRow {
  id: string;
  revisionId: string;
  publishedAt: Date;
  updatedAt: Date;
}

export interface LiveFilter {
  type?: string;
  locale?: string;
  termId?: string;
  slug?: string;
  translationGroupIds?: readonly string[];
  entryIds?: readonly string[];
}

/** Live entries of a site, newest first (by first publication), keyset paged. */
export async function liveRows(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  siteId: string,
  filter: LiveFilter,
  page: { limit: number; after?: { at: Date; id: string } | null },
) {
  const where = [
    filter.type ? Prisma.sql`AND e."type" = ${filter.type}` : Prisma.empty,
    filter.locale ? Prisma.sql`AND e."locale" = ${filter.locale}` : Prisma.empty,
    filter.slug ? Prisma.sql`AND r."slug" = ${filter.slug}` : Prisma.empty,
    filter.termId ? Prisma.sql`AND ${filter.termId}::uuid = ANY (r."termIds")` : Prisma.empty,
    filter.translationGroupIds ? Prisma.sql`AND e."translationGroupId" = ANY (${[...filter.translationGroupIds]}::uuid[])` : Prisma.empty,
    filter.entryIds ? Prisma.sql`AND e."id" = ANY (${[...filter.entryIds]}::uuid[])` : Prisma.empty,
    page.after
      ? Prisma.sql`AND (e."firstPublishedAt", e."id") < (${page.after.at}::timestamptz, ${page.after.id}::uuid)`
      : Prisma.empty,
  ];
  return tx.$queryRaw<LiveRow[]>(Prisma.sql`
    SELECT e."id", e."publishedRevisionId" AS "revisionId", e."firstPublishedAt" AS "publishedAt",
           COALESCE(e."lastPublishedAt", e."firstPublishedAt") AS "updatedAt"
    FROM "CmsEntry" e
    JOIN "CmsRevision" r ON r."id" = e."publishedRevisionId"
    WHERE e."projectId" = ${scope.projectId}::uuid
      AND e."publishedRevisionId" IS NOT NULL
      AND e."firstPublishedAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "CmsPublication" p
        WHERE p."entryId" = e."id" AND p."revisionId" = e."publishedRevisionId" AND p."siteId" = ${siteId}::uuid
          AND p."status" IN ('visible', 'notified', 'live_verified')
      )
      ${Prisma.join(where, " ")}
    ORDER BY e."firstPublishedAt" DESC, e."id" DESC
    LIMIT ${page.limit}`);
}

/** The site's path for an entry, or null when the site has no route for its type. */
export function pathOf(site: Pick<SiteRow, "routes" | "trailingSlash">, entry: { type: string; locale: string }, slug: string) {
  try {
    return entryPath(siteRoutes.parse(site.routes) as SiteRoutes, entry.type, entry.locale, slug, site.trailingSlash);
  } catch {
    return null;
  }
}

/**
 * An active redirect from a path, resolved for the site: a 301 to an entry
 * points at the entry's current live path there; an entry no longer live
 * makes it a 410.
 */
export async function resolveRedirects(tx: DbTx, scope: Pick<Scope, "projectId">, site: SiteRow, rows: ReadonlyArray<{ fromPath: string; toPath: string | null; toEntryId: string | null; code: number }>) {
  const targets = [...new Set(rows.flatMap((r) => (r.toEntryId ? [r.toEntryId] : [])))];
  const live = targets.length ? await liveRows(tx, scope, site.id, { entryIds: targets }, { limit: targets.length }) : [];
  const entries = live.length
    ? await tx.cmsEntry.findMany({ where: { projectId: scope.projectId, id: { in: live.map((l) => l.id) } }, select: { id: true, type: true, locale: true } })
    : [];
  const revisions = live.length
    ? await tx.cmsRevision.findMany({ where: { projectId: scope.projectId, id: { in: live.map((l) => l.revisionId) } }, select: { id: true, entryId: true, slug: true } })
    : [];
  const pathOfEntry = new Map(
    entries.map((e) => {
      const slug = revisions.find((r) => r.entryId === e.id)?.slug;
      return [e.id, slug ? pathOf(site, e, slug) : null];
    }),
  );
  return rows.map((row) => {
    if (row.code === 410) return { fromPath: row.fromPath, toPath: null, code: 410 as const };
    const toPath = row.toEntryId ? (pathOfEntry.get(row.toEntryId) ?? null) : row.toPath;
    return toPath && toPath !== row.fromPath
      ? { fromPath: row.fromPath, toPath, code: 301 as const }
      : { fromPath: row.fromPath, toPath: null, code: 410 as const };
  });
}

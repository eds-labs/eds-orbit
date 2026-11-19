import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { cancelActionRequest, type RequestedBy } from "../../platform/governance/action-requests.ts";
import { audit, DomainError } from "../../shared.ts";
import { localeInput, lockEntry, notFound, UUID_RE } from "./entries/common.ts";
import { insertEntry, saveDraft } from "./entries/entries.ts";
import { cmsActive } from "./gate.ts";
import { liveRows, pathOf, LIVE_PUBLICATION } from "./delivery/live.ts";
import { requestPublication } from "./publishing/approval.ts";
import { pendingRequestFor } from "./publishing/requests.ts";
import { absoluteUrl } from "./types/routes.ts";

// What other modules may use of the content module (ADR 0029 §6, CH1.15).
// This file is the content module's interface: Marketing (and later Support
// or Knowledge) import only from here (boundary module:marketing →
// module:cms). Another module writes drafts, never live content: a
// publication always goes through the content module's approval (decision
// E-4), with the origin module's requester recorded. Reads give what is live
// and where, for internal links, novelty checks and metrics.
//
// Domain events (content-free, `publishEvent`) other modules may subscribe to:
// - `cms.entry.published|updated|unpublished` — data `{ revision, previousRevision, sites }`
// - `cms.entry.scheduled` — data `{ revision, sites, at }`
// - `cms.publication.needs_attention` — data `{ code, publications, reason? }`
// The subject is always `{ type: "cms.entry", id: entryId }`.

export const CMS_EVENTS = [
  "cms.entry.published",
  "cms.entry.updated",
  "cms.entry.unpublished",
  "cms.entry.scheduled",
  "cms.publication.needs_attention",
] as const;

export type CmsOriginRef = { module: "marketing"; type: string; id: string; version: number };

/** Whether the content module is on in the project (switch and activation). */
export function cmsAvailable(tx: DbTx, scope: Scope) {
  return cmsActive(tx, scope);
}

const requireAvailable = async (tx: DbTx, scope: Scope) => {
  if (!(await cmsActive(tx, scope))) throw new DomainError("CMS_DISABLED", 404);
};

const originDraft = z
  .object({
    origin: z
      .object({ module: z.literal("marketing"), type: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), id: z.string().min(1).max(100), version: z.int().min(1) })
      .strict(),
    type: z.string().max(31).default("article"),
    locale: localeInput,
    title: z.string().trim().min(1).max(200),
    excerpt: z.string().max(500).optional(),
    body: z.unknown(),
    fields: z.unknown().optional(),
    seo: z.unknown().optional(),
    heroAssetId: z.uuid().nullable().optional(),
    authorIds: z.array(z.uuid()).max(10).optional(),
    termIds: z.array(z.uuid()).max(50).optional(),
    /** Sites for a new entry; an existing entry keeps its sites. */
    siteIds: z.array(z.uuid()).max(20).optional(),
  })
  .strict();
export type OriginDraftInput = z.input<typeof originDraft>;

/** The entry made from an origin record (any version), newest first. */
async function entryOfOrigin(tx: DbTx, scope: Scope, origin: CmsOriginRef) {
  return tx.cmsEntry.findFirst({
    where: {
      projectId: scope.projectId,
      AND: [
        { originRef: { path: ["module"], equals: origin.module } },
        { originRef: { path: ["type"], equals: origin.type } },
        { originRef: { path: ["id"], equals: origin.id } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * A draft from another module's record. The first version creates an entry
 * (origin `marketing`); a newer version of the same record updates that
 * entry's draft (an update, not a second article); the same version again
 * changes nothing. Live content changes only through a publication.
 */
export async function submitOriginDraft(tx: DbTx, scope: Scope, raw: OriginDraftInput) {
  await requireAvailable(tx, scope);
  const input = originDraft.parse(raw);
  const existing = await entryOfOrigin(tx, scope, input.origin);
  if (!existing) {
    const entry = await insertEntry(tx, scope, {
      type: input.type,
      locale: input.locale,
      title: input.title,
      siteIds: input.siteIds,
      origin: input.origin.module,
      originRef: input.origin,
      draft: {
        title: input.title,
        excerpt: input.excerpt,
        body: input.body,
        fields: input.fields,
        seo: input.seo,
        heroAssetId: input.heroAssetId ?? null,
        authorIds: input.authorIds,
        termIds: input.termIds,
      },
    });
    const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
    return { entryId: entry.id, draftVersion: draft.version, created: true, deduplicated: false };
  }
  const known = (existing.originRef as CmsOriginRef | null)?.version ?? 0;
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: existing.id, projectId: scope.projectId } });
  if (input.origin.version <= known) return { entryId: existing.id, draftVersion: draft.version, created: false, deduplicated: true };
  if (existing.archivedAt) throw new DomainError("CMS_ENTRY_ARCHIVED", 409);
  if (existing.locale !== input.locale || existing.type !== input.type) throw new DomainError("CMS_ORIGIN_MISMATCH", 409);
  const saved = await saveDraft(tx, scope, existing.id, {
    version: draft.version,
    title: input.title,
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    body: input.body,
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    ...(input.seo !== undefined ? { seo: input.seo } : {}),
    ...(input.heroAssetId !== undefined ? { heroAssetId: input.heroAssetId } : {}),
    ...(input.authorIds ? { authorIds: input.authorIds } : {}),
    ...(input.termIds ? { termIds: input.termIds } : {}),
  });
  await tx.cmsEntry.update({ where: { id: existing.id }, data: { originRef: input.origin } });
  return { entryId: existing.id, draftVersion: saved.draft.version, created: false, deduplicated: false };
}

/**
 * Asks for the publication of an entry's draft (or a revision) on behalf of
 * the origin module: the content module's approval decides (decision E-4).
 * `requestedBy` names who asked (an agent run, a member).
 */
export async function requestOriginPublication(tx: DbTx, scope: Scope, entryId: string, raw: unknown, requestedBy: RequestedBy) {
  await requireAvailable(tx, scope);
  const result = await requestPublication(tx, scope, entryId, raw, requestedBy);
  return { mode: result.mode, requestId: result.requestId, status: result.entry.status };
}

/** Withdraws an open publication request the origin made (nothing live changes). */
export async function cancelOriginRequest(tx: DbTx, scope: Scope, entryId: string) {
  await requireAvailable(tx, scope);
  const entry = await lockEntry(tx, scope, entryId);
  const pending = await pendingRequestFor(tx, scope, entry.id);
  if (!pending) return { cancelled: false };
  await cancelActionRequest(tx, scope, pending.id, "cms_origin_cancelled", { pendingOnly: true });
  await audit(tx, scope, "cms.publication.cancelled", entry.id, { request: true, publications: 0, origin: true });
  return { cancelled: true };
}

/** Where each live site shows the entry. */
async function liveUrls(tx: DbTx, scope: Scope, entries: ReadonlyArray<{ id: string; type: string; locale: string; publishedRevisionId: string | null }>) {
  const live = entries.filter((e) => e.publishedRevisionId);
  if (!live.length) return new Map<string, Array<{ siteId: string; url: string }>>();
  const [pubs, revisions] = await Promise.all([
    tx.cmsPublication.findMany({
      where: {
        projectId: scope.projectId,
        entryId: { in: live.map((e) => e.id) },
        revisionId: { in: live.map((e) => e.publishedRevisionId!) },
        status: { in: [...LIVE_PUBLICATION] },
      },
      select: { entryId: true, revisionId: true, siteId: true },
    }),
    tx.cmsRevision.findMany({ where: { projectId: scope.projectId, id: { in: live.map((e) => e.publishedRevisionId!) } }, select: { id: true, slug: true } }),
  ]);
  const sites = await tx.cmsSite.findMany({ where: { projectId: scope.projectId, id: { in: [...new Set(pubs.map((p) => p.siteId))] }, archivedAt: null } });
  const out = new Map<string, Array<{ siteId: string; url: string }>>();
  for (const entry of live) {
    const slug = revisions.find((r) => r.id === entry.publishedRevisionId)?.slug;
    const urls = pubs
      .filter((p) => p.entryId === entry.id && p.revisionId === entry.publishedRevisionId)
      .flatMap((p) => {
        const site = sites.find((s) => s.id === p.siteId);
        const path = site && slug ? pathOf(site, entry, slug) : null;
        return site && path ? [{ siteId: site.id, url: absoluteUrl(site.baseUrl, path) }] : [];
      });
    out.set(entry.id, [...new Map(urls.map((u) => [u.siteId, u])).values()]);
  }
  return out;
}

/** Status of entries: live state, live revision, open request and live URLs. */
export async function entryStatus(tx: DbTx, scope: Scope, entryIds: readonly string[]) {
  const ids = entryIds.filter((id) => UUID_RE.test(id)).slice(0, 100);
  if (!ids.length) return [];
  const entries = await tx.cmsEntry.findMany({ where: { projectId: scope.projectId, id: { in: ids } } });
  const urls = await liveUrls(tx, scope, entries);
  const revisions = await tx.cmsRevision.findMany({
    where: { projectId: scope.projectId, id: { in: entries.flatMap((e) => (e.publishedRevisionId ? [e.publishedRevisionId] : [])) } },
    select: { id: true, number: true },
  });
  const out = [];
  for (const entry of entries) {
    const pending = await pendingRequestFor(tx, scope, entry.id);
    out.push({
      entryId: entry.id,
      status: entry.status,
      origin: entry.origin,
      liveRevision: revisions.find((r) => r.id === entry.publishedRevisionId)?.number ?? null,
      scheduledAt: entry.scheduledAt?.toISOString() ?? null,
      lastPublishedAt: entry.lastPublishedAt?.toISOString() ?? null,
      pendingRequestId: pending?.id ?? null,
      urls: urls.get(entry.id) ?? [],
    });
  }
  return out;
}

const publishedQuery = z
  .object({
    type: z.string().max(31).optional(),
    locale: localeInput.optional(),
    siteId: z.uuid().optional(),
    limit: z.int().min(1).max(500).default(100),
  })
  .strict();

/**
 * Live entries with title, excerpt, terms and URLs, newest first: for
 * internal links, cannibalization and novelty checks. No body.
 */
export async function publishedEntries(tx: DbTx, scope: Scope, raw: z.input<typeof publishedQuery> = {}) {
  const q = publishedQuery.parse(raw);
  let ids: string[] | null = null;
  if (q.siteId) {
    const rows = await liveRows(tx, scope, q.siteId, { type: q.type, locale: q.locale }, { limit: q.limit });
    ids = rows.map((r) => r.id);
  }
  const entries = await tx.cmsEntry.findMany({
    where: {
      projectId: scope.projectId,
      publishedRevisionId: { not: null },
      ...(ids ? { id: { in: ids } } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.locale ? { locale: q.locale } : {}),
    },
    orderBy: [{ firstPublishedAt: "desc" }, { id: "desc" }],
    take: q.limit,
  });
  const revisions = await tx.cmsRevision.findMany({
    where: { projectId: scope.projectId, id: { in: entries.map((e) => e.publishedRevisionId!) } },
    select: { id: true, title: true, excerpt: true, slug: true, termIds: true, number: true },
  });
  const urls = await liveUrls(tx, scope, entries);
  return entries.flatMap((entry) => {
    const revision = revisions.find((r) => r.id === entry.publishedRevisionId);
    return revision
      ? [
          {
            entryId: entry.id,
            type: entry.type,
            locale: entry.locale,
            translationGroupId: entry.translationGroupId,
            title: revision.title,
            excerpt: revision.excerpt,
            slug: revision.slug,
            termIds: revision.termIds,
            revision: revision.number,
            publishedAt: entry.firstPublishedAt?.toISOString() ?? null,
            urls: urls.get(entry.id) ?? [],
          },
        ]
      : [];
  });
}

/** Live URL → entry id of a site, for page metrics (Search Console, Matomo). */
export async function entryUrlMap(tx: DbTx, scope: Scope, siteId: string) {
  if (!UUID_RE.test(siteId)) throw notFound("CMS_SITE_NOT_FOUND");
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: scope.projectId } });
  if (!site) throw notFound("CMS_SITE_NOT_FOUND");
  const rows = await liveRows(tx, scope, siteId, {}, { limit: 10_000 });
  if (!rows.length) return new Map<string, string>();
  const [entries, revisions] = await Promise.all([
    tx.cmsEntry.findMany({ where: { projectId: scope.projectId, id: { in: rows.map((r) => r.id) } }, select: { id: true, type: true, locale: true } }),
    tx.cmsRevision.findMany({ where: { projectId: scope.projectId, id: { in: rows.map((r) => r.revisionId) } }, select: { entryId: true, slug: true } }),
  ]);
  const map = new Map<string, string>();
  for (const entry of entries) {
    const slug = revisions.find((r) => r.entryId === entry.id)?.slug;
    const path = slug ? pathOf(site, entry, slug) : null;
    if (path) map.set(absoluteUrl(site.baseUrl, path), entry.id);
  }
  return map;
}

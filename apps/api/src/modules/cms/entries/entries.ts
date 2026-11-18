import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  assertOrbitDoc,
  canonicalize,
  emptyDoc,
  OrbitDocError,
  referencedAssetIds,
} from "../../../../../../packages/content-doc/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import { enabledContentType, parseFields } from "../types/registry.ts";
import { seoSchema } from "../types/seo.ts";
import {
  afterCursor,
  decodeCursor,
  encodeCursor,
  findEntry,
  listLimit,
  localeInput,
  lockEntry,
  refused,
  requireRefs,
  requireVersion,
  slugInput,
  versionInput,
} from "./common.ts";
import { contentHashOf, latestRevision, snapshotOf } from "./revisions.ts";
import { ENTRY_SLUG_MAX, freeSlugFrom, requireSlugFree, slugFree } from "./slugs.ts";
import { termsInLocale } from "./taxonomies.ts";

// Entries and their drafts (ADR 0029 §3.2, CH1.8). An entry is one piece of
// content in one locale; its draft is the single working copy, saved with an
// optimistic version (CMS_DRAFT_STALE). Revisions, publication and
// withdrawal of live content are separate steps (revisions.ts, CH1.10).

export const ORIGINS = ["manual", "assistant", "marketing", "api", "mcp", "import"] as const;
export type EntryOrigin = (typeof ORIGINS)[number];
const STATUSES = ["draft", "in_review", "scheduled", "published", "archived"] as const;

/** Draft saves by the same member within this window share one audit record. */
const DRAFT_AUDIT_WINDOW_MS = 15 * 60_000;

type EntryRow = Awaited<ReturnType<DbTx["cmsEntry"]["findFirstOrThrow"]>>;
type DraftRow = Awaited<ReturnType<DbTx["cmsDraft"]["findFirstOrThrow"]>>;

export const entryView = (row: EntryRow) => ({
  id: row.id,
  type: row.type,
  locale: row.locale,
  translationGroupId: row.translationGroupId,
  slug: row.slug,
  status: row.status,
  publishedRevisionId: row.publishedRevisionId,
  scheduledRevisionId: row.scheduledRevisionId,
  scheduledAt: row.scheduledAt?.toISOString() ?? null,
  firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
  lastPublishedAt: row.lastPublishedAt?.toISOString() ?? null,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  origin: row.origin,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const draftView = (row: DraftRow) => ({
  title: row.title,
  excerpt: row.excerpt,
  body: row.body,
  fields: row.fields as Record<string, unknown>,
  seo: row.seo as Record<string, unknown>,
  heroAssetId: row.heroAssetId,
  authorIds: row.authorIds,
  termIds: row.termIds,
  version: row.version,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

// --- Inputs -----------------------------------------------------------------

const title = z.string().trim().max(200);
const excerptText = z.string().trim().max(500);
const ids = (max: number) => z.array(z.uuid()).max(max);

const createInput = z
  .object({
    type: z.string().max(31),
    locale: localeInput,
    title: title.optional(),
    slug: slugInput(ENTRY_SLUG_MAX).optional(),
    siteIds: ids(20).optional(),
  })
  .strict();

const draftInput = z
  .object({
    version: versionInput,
    title: title.optional(),
    excerpt: excerptText.optional(),
    slug: slugInput(ENTRY_SLUG_MAX).optional(),
    /** orbit-doc-v1; the editor converts from TipTap before saving. */
    body: z.unknown().optional(),
    fields: z.unknown().optional(),
    seo: z.unknown().optional(),
    heroAssetId: z.uuid().nullable().optional(),
    authorIds: ids(10).optional(),
    termIds: ids(50).optional(),
  })
  .strict();

const listQuery = z
  .object({
    type: z.string().max(31).optional(),
    locale: localeInput.optional(),
    /** Comma-separated statuses; without it, everything but archived entries. */
    status: z.string().max(80).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    siteId: z.uuid().optional(),
    cursor: z.string().max(200).optional(),
    limit: listLimit,
  })
  .strict();

/** A validated, canonical orbit-doc or 422 CMS_BODY_INVALID with the problem paths. */
export function parseBody(raw: unknown) {
  try {
    return canonicalize(assertOrbitDoc(raw));
  } catch (error) {
    if (error instanceof OrbitDocError)
      throw refused("CMS_BODY_INVALID", 422, { problems: error.problems.slice(0, 20).map((p) => ({ path: p.path, code: p.code })) });
    throw error;
  }
}

function typeFor(key: string) {
  try {
    return enabledContentType(key);
  } catch {
    throw refused("CMS_TYPE_UNAVAILABLE", 422, { type: key });
  }
}

// --- Sites ------------------------------------------------------------------

/** Active sites of the project that serve the locale; others are refused. */
async function requireSites(tx: DbTx, scope: Scope, siteIds: readonly string[], locale: string) {
  const wanted = [...new Set(siteIds)];
  if (!wanted.length) return [];
  const sites = await tx.cmsSite.findMany({
    where: { projectId: scope.projectId, id: { in: wanted }, archivedAt: null },
    select: { id: true, locales: true },
  });
  const known = new Map(sites.map((s) => [s.id, s.locales]));
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length) throw refused("CMS_REFERENCE_UNKNOWN", 422, { missing: { siteIds: missing } });
  const wrongLocale = wanted.filter((id) => !known.get(id)!.includes(locale));
  if (wrongLocale.length) throw refused("CMS_SITE_LOCALE_MISSING", 422, { siteIds: wrongLocale, locale });
  return wanted;
}

async function writeSites(tx: DbTx, scope: Scope, entryId: string, siteIds: readonly string[]) {
  await tx.cmsEntrySite.deleteMany({ where: { projectId: scope.projectId, entryId, siteId: { notIn: [...siteIds] } } });
  const existing = new Set(
    (await tx.cmsEntrySite.findMany({ where: { projectId: scope.projectId, entryId }, select: { siteId: true } })).map((r) => r.siteId),
  );
  const added = siteIds.filter((id) => !existing.has(id));
  if (added.length)
    await tx.cmsEntrySite.createMany({
      data: added.map((siteId) => ({ workspaceId: scope.workspaceId, projectId: scope.projectId, entryId, siteId })),
    });
}

async function sitesOf(tx: DbTx, scope: Scope, entryId: string) {
  return (
    await tx.cmsEntrySite.findMany({ where: { projectId: scope.projectId, entryId }, select: { siteId: true }, orderBy: { createdAt: "asc" } })
  ).map((r) => r.siteId);
}

// --- Create -----------------------------------------------------------------

export interface NewEntry {
  type: string;
  locale: string;
  title?: string;
  slug?: string;
  siteIds?: readonly string[];
  translationGroupId?: string;
  origin?: EntryOrigin;
  originRef?: Record<string, unknown> | null;
  draft?: Partial<Pick<DraftRow, "title" | "excerpt" | "heroAssetId" | "authorIds" | "termIds">> & {
    body?: unknown;
    fields?: unknown;
    seo?: unknown;
  };
}

/** Creates an entry with its draft. Shared by the UI routes, the API and MCP. */
export async function insertEntry(tx: DbTx, scope: Scope, input: NewEntry) {
  const type = typeFor(input.type);
  const target = { type: type.key, locale: input.locale };
  const draftTitle = input.draft?.title ?? input.title ?? "";
  const slug = input.slug ?? (await freeSlugFrom(tx, scope, target, input.title || draftTitle));
  if (input.slug) await requireSlugFree(tx, scope, target, slug);
  const siteIds = await requireSites(tx, scope, input.siteIds ?? [], input.locale);
  const body = input.draft?.body === undefined ? emptyDoc() : parseBody(input.draft.body);
  const fields = parseFields(type.key, input.draft?.fields);
  const seo = seoSchema.parse(input.draft?.seo ?? {});
  await requireRefs(tx, scope, {
    authorIds: input.draft?.authorIds,
    termIds: input.draft?.termIds,
    locale: input.locale,
    assetIds: [
      ...referencedAssetIds(body),
      ...(input.draft?.heroAssetId ? [input.draft.heroAssetId] : []),
      ...(seo.ogImageAssetId ? [seo.ogImageAssetId] : []),
    ],
  });
  const translationGroupId = input.translationGroupId ?? randomUUID();
  if (
    input.translationGroupId &&
    (await tx.cmsEntry.findFirst({ where: { projectId: scope.projectId, translationGroupId, locale: input.locale }, select: { id: true } }))
  )
    throw refused("CMS_TRANSLATION_EXISTS", 409, { locale: input.locale });
  const entry = await tx.cmsEntry.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      type: type.key,
      locale: input.locale,
      translationGroupId,
      slug,
      origin: input.origin ?? "manual",
      originRef: (input.originRef ?? undefined) as Prisma.InputJsonValue | undefined,
      createdBy: scope.userId,
    },
  });
  await tx.cmsDraft.create({
    data: {
      entryId: entry.id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      title: draftTitle,
      excerpt: input.draft?.excerpt ?? "",
      body: body as unknown as Prisma.InputJsonValue,
      fields: fields as Prisma.InputJsonValue,
      seo: seo as Prisma.InputJsonValue,
      heroAssetId: input.draft?.heroAssetId ?? null,
      authorIds: [...(input.draft?.authorIds ?? [])],
      termIds: [...(input.draft?.termIds ?? [])],
      updatedBy: scope.userId,
    },
  });
  await writeSites(tx, scope, entry.id, siteIds);
  await audit(tx, scope, "cms.entry.created", entry.id, { type: entry.type, locale: entry.locale, origin: entry.origin });
  return entry;
}

export async function createEntry(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  const entry = await insertEntry(tx, scope, input);
  return getEntry(tx, scope, entry.id);
}

// --- Read -------------------------------------------------------------------

export async function listEntries(tx: DbTx, scope: Scope, raw: unknown) {
  const q = listQuery.parse(raw ?? {});
  const statuses = q.status ? q.status.split(",").filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s)) : null;
  if (statuses && !statuses.length) throw new DomainError("VALIDATION_FAILED", 400);
  const after = decodeCursor(q.cursor);
  let idFilter: string[] | null = null;
  if (q.q) {
    idFilter = (
      await tx.cmsDraft.findMany({
        where: { projectId: scope.projectId, title: { contains: q.q, mode: "insensitive" } },
        select: { entryId: true },
        take: 500,
      })
    ).map((d) => d.entryId);
  }
  if (q.siteId) {
    const onSite = (
      await tx.cmsEntrySite.findMany({ where: { projectId: scope.projectId, siteId: q.siteId }, select: { entryId: true }, take: 5000 })
    ).map((r) => r.entryId);
    idFilter = idFilter ? idFilter.filter((id) => onSite.includes(id)) : onSite;
  }
  const rows = await tx.cmsEntry.findMany({
    where: {
      projectId: scope.projectId,
      status: statuses ? { in: statuses } : { not: "archived" },
      ...(q.type ? { type: q.type } : {}),
      ...(q.locale ? { locale: q.locale } : {}),
      ...(idFilter ? { id: { in: idFilter } } : {}),
      ...afterCursor(after),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const drafts = await tx.cmsDraft.findMany({
    where: { projectId: scope.projectId, entryId: { in: page.map((e) => e.id) } },
    select: { entryId: true, title: true, excerpt: true },
  });
  const draftOf = new Map(drafts.map((d) => [d.entryId, d]));
  const last = page[page.length - 1];
  return {
    items: page.map((entry) => ({
      ...entryView(entry),
      title: draftOf.get(entry.id)?.title ?? "",
      excerpt: [...(draftOf.get(entry.id)?.excerpt ?? "")].slice(0, 160).join(""),
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
  };
}

/** The entry with its draft, translations, sites and revision state. */
export async function getEntry(tx: DbTx, scope: Scope, id: string) {
  const entry = await findEntry(tx, scope, id);
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
  const latest = await latestRevision(tx, scope, entry.id);
  const translations = await tx.cmsEntry.findMany({
    where: { projectId: scope.projectId, translationGroupId: entry.translationGroupId, id: { not: entry.id } },
    select: { id: true, locale: true, slug: true, status: true, updatedAt: true },
    orderBy: { locale: "asc" },
  });
  const published = entry.publishedRevisionId
    ? await tx.cmsRevision.findFirst({ where: { id: entry.publishedRevisionId }, select: { id: true, number: true, slug: true } })
    : null;
  return {
    entry: entryView(entry),
    draft: draftView(draft),
    siteIds: await sitesOf(tx, scope, entry.id),
    translations: translations.map((t) => ({ ...t, updatedAt: t.updatedAt.toISOString() })),
    latestRevision: latest ? { id: latest.id, number: latest.number, contentHash: latest.contentHash, createdAt: latest.createdAt.toISOString() } : null,
    publishedRevision: published,
    /** True when the draft has changes no revision holds yet. */
    unsavedChanges: !latest || latest.contentHash !== contentHashOf(snapshotOf(entry, draft)),
  };
}

// --- Draft ------------------------------------------------------------------

/** Saves draft changes (autosave). Fields not sent stay as they are. */
export async function saveDraft(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const { version, ...input } = draftInput.parse(raw);
  const entry = await lockEntry(tx, scope, id);
  if (entry.archivedAt) throw refused("CMS_ENTRY_ARCHIVED", 409);
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
  if (draft.version !== version) throw refused("CMS_DRAFT_STALE", 409, { version: draft.version });

  const body = input.body === undefined ? undefined : parseBody(input.body);
  const fields = input.fields === undefined ? undefined : parseFields(entry.type, input.fields);
  const seo = input.seo === undefined ? undefined : seoSchema.parse(input.seo);
  await requireRefs(tx, scope, {
    authorIds: input.authorIds,
    termIds: input.termIds,
    locale: entry.locale,
    assetIds: [
      ...(body ? referencedAssetIds(body) : []),
      ...(input.heroAssetId ? [input.heroAssetId] : []),
      ...(seo?.ogImageAssetId ? [seo.ogImageAssetId] : []),
    ],
  });
  if (input.slug !== undefined && input.slug !== entry.slug) {
    await requireSlugFree(tx, scope, { type: entry.type, locale: entry.locale, entryId: entry.id }, input.slug);
    await tx.cmsEntry.update({ where: { id: entry.id }, data: { slug: input.slug } });
  } else await tx.cmsEntry.update({ where: { id: entry.id }, data: { updatedAt: new Date() } });

  const result = await tx.cmsDraft.updateMany({
    where: { entryId: entry.id, projectId: scope.projectId, version },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      ...(body ? { body: body as unknown as Prisma.InputJsonValue } : {}),
      ...(fields ? { fields: fields as Prisma.InputJsonValue } : {}),
      ...(seo ? { seo: seo as Prisma.InputJsonValue } : {}),
      ...(input.heroAssetId !== undefined ? { heroAssetId: input.heroAssetId } : {}),
      ...(input.authorIds ? { authorIds: input.authorIds } : {}),
      ...(input.termIds ? { termIds: input.termIds } : {}),
      updatedBy: scope.userId,
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw refused("CMS_DRAFT_STALE", 409);
  // Content-free and coalesced: one record per member and editing session.
  if (draft.updatedBy !== scope.userId || Date.now() - draft.updatedAt.getTime() > DRAFT_AUDIT_WINDOW_MS)
    await audit(tx, scope, "cms.draft.saved", entry.id, { fields: Object.keys(input).sort() });
  return getEntry(tx, scope, entry.id);
}

// --- Sites, archive, translations ---------------------------------------------

const sitesInput = z.object({ siteIds: ids(20), version: versionInput }).strict();

/** Which sites show the entry. A live entry's change takes effect with its next publication. */
export async function setEntrySites(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const input = sitesInput.parse(raw);
  const entry = await lockEntry(tx, scope, id);
  requireVersion(entry.version, input.version);
  if (entry.archivedAt) throw refused("CMS_ENTRY_ARCHIVED", 409);
  const siteIds = await requireSites(tx, scope, input.siteIds, entry.locale);
  await writeSites(tx, scope, entry.id, siteIds);
  await tx.cmsEntry.update({ where: { id: entry.id }, data: { version: { increment: 1 } } });
  await audit(tx, scope, "cms.entry.sites_changed", entry.id, { sites: siteIds.length });
  return getEntry(tx, scope, entry.id);
}

/**
 * Archives an entry that is not live. Live or scheduled content is withdrawn
 * through an approved unpublish request (CH1.10), never directly.
 */
export async function archiveEntry(tx: DbTx, scope: Scope, id: string, version: number) {
  const entry = await lockEntry(tx, scope, id);
  requireVersion(entry.version, version);
  if (entry.status === "archived") return getEntry(tx, scope, entry.id);
  if (entry.publishedRevisionId || entry.scheduledRevisionId) throw refused("CMS_ENTRY_LIVE", 409);
  if (entry.status === "in_review") throw refused("CMS_ENTRY_IN_REVIEW", 409);
  await tx.cmsEntry.update({
    where: { id: entry.id },
    data: { status: "archived", archivedAt: new Date(), version: { increment: 1 } },
  });
  await audit(tx, scope, "cms.entry.archived", entry.id, {});
  return getEntry(tx, scope, entry.id);
}

export async function unarchiveEntry(tx: DbTx, scope: Scope, id: string, version: number) {
  const entry = await lockEntry(tx, scope, id);
  requireVersion(entry.version, version);
  if (entry.status !== "archived") return getEntry(tx, scope, entry.id);
  await tx.cmsEntry.update({
    where: { id: entry.id },
    data: { status: "draft", archivedAt: null, version: { increment: 1 } },
  });
  await audit(tx, scope, "cms.entry.restored", entry.id, {});
  return getEntry(tx, scope, entry.id);
}

const translationInput = z
  .object({
    locale: localeInput,
    slug: slugInput(ENTRY_SLUG_MAX).optional(),
    /** Start from a copy of the source draft (default) or from an empty one. */
    copy: z.boolean().default(true),
  })
  .strict();

/**
 * A new entry in another locale of the same translation group. A copy keeps
 * the source's text for translating, its terms mapped to the target locale's
 * translations, and the source's sites that serve the target locale.
 */
export async function createTranslation(tx: DbTx, scope: Scope, sourceId: string, raw: unknown) {
  const input = translationInput.parse(raw);
  const source = await findEntry(tx, scope, sourceId);
  if (source.locale === input.locale) throw refused("CMS_TRANSLATION_EXISTS", 409, { locale: input.locale });
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: source.id, projectId: scope.projectId } });
  const sourceSites = await tx.cmsSite.findMany({
    where: { projectId: scope.projectId, id: { in: await sitesOf(tx, scope, source.id) }, archivedAt: null },
    select: { id: true, locales: true },
  });
  const target = { type: source.type, locale: input.locale };
  const slug = input.slug ?? ((await slugFree(tx, scope, target, source.slug)) ? source.slug : undefined);
  const entry = await insertEntry(tx, scope, {
    type: source.type,
    locale: input.locale,
    slug,
    title: draft.title,
    translationGroupId: source.translationGroupId,
    siteIds: sourceSites.filter((s) => s.locales.includes(input.locale)).map((s) => s.id),
    draft: input.copy
      ? {
          title: draft.title,
          excerpt: draft.excerpt,
          body: draft.body,
          fields: draft.fields,
          seo: draft.seo,
          heroAssetId: draft.heroAssetId,
          authorIds: draft.authorIds,
          termIds: await termsInLocale(tx, scope, draft.termIds, input.locale),
        }
      : { title: "" },
  });
  return getEntry(tx, scope, entry.id);
}


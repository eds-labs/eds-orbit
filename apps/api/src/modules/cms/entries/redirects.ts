import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit } from "../../../shared.ts";
import { entryPath, siteRoutes } from "../types/routes.ts";
import { decodeCursor, listLimit, notFound, refused, UUID_RE } from "./common.ts";

// Redirects of a site (ADR 0029 §3.2, §8). The publishing core records a 301
// when a published entry goes live under a new slug and a 410 (or a 301 to a
// replacement) when it is withdrawn; editors add manual ones. A 301 to an
// entry follows the entry's current path, so slug changes never chain.
// At most one redirect per site and path is active (database key).

const path = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/[^\s?#]*$/, "CMS_PATH_INVALID")
  .refine((value) => !value.startsWith("//") && !value.includes("\\"), "CMS_PATH_INVALID");

interface EntryRef {
  id: string;
  type: string;
  locale: string;
}

async function requireSite(tx: DbTx, scope: Scope, siteId: string) {
  if (!UUID_RE.test(siteId)) throw notFound("CMS_SITE_NOT_FOUND");
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: scope.projectId, archivedAt: null } });
  if (!site) throw notFound("CMS_SITE_NOT_FOUND");
  return site;
}

/** The entry's path on each active site it is assigned to (or on the given sites). */
export async function entryPaths(tx: DbTx, scope: Scope, entry: EntryRef, slug: string, onSites?: readonly string[]) {
  const siteIds =
    onSites ??
    (await tx.cmsEntrySite.findMany({ where: { projectId: scope.projectId, entryId: entry.id }, select: { siteId: true } })).map((l) => l.siteId);
  if (!siteIds.length) return [];
  const sites = await tx.cmsSite.findMany({
    where: { projectId: scope.projectId, id: { in: [...siteIds] }, archivedAt: null },
  });
  return sites.map((site) => ({
    siteId: site.id,
    path: entryPath(siteRoutes.parse(site.routes), entry.type, entry.locale, slug, site.trailingSlash),
  }));
}

async function retire(tx: DbTx, scope: Scope, siteId: string, fromPath: string) {
  await tx.cmsRedirect.updateMany({
    where: { projectId: scope.projectId, siteId, fromPath, removedAt: null },
    data: { removedAt: new Date() },
  });
}

/**
 * The entry now lives at its slug's path: redirects away from that path end.
 * Used by the publishing core when a revision goes live (CH1.10).
 */
export async function clearRedirectsAt(tx: DbTx, scope: Scope, entry: EntryRef, slug: string) {
  for (const { siteId, path: at } of await entryPaths(tx, scope, entry, slug)) await retire(tx, scope, siteId, at);
}

/** A published entry moved from one slug to another: 301 from the old path. */
export async function redirectSlugChange(tx: DbTx, scope: Scope, entry: EntryRef, fromSlug: string, toSlug: string) {
  if (fromSlug === toSlug) return 0;
  const before = new Map((await entryPaths(tx, scope, entry, fromSlug)).map((p) => [p.siteId, p.path]));
  let created = 0;
  for (const { siteId, path: to } of await entryPaths(tx, scope, entry, toSlug)) {
    const from = before.get(siteId);
    await retire(tx, scope, siteId, to);
    if (!from || from === to) continue;
    await retire(tx, scope, siteId, from);
    await tx.cmsRedirect.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        siteId,
        fromPath: from,
        toEntryId: entry.id,
        code: 301,
        reason: "slug_changed",
        createdBy: scope.userId,
      },
    });
    created++;
  }
  return created;
}

/** A withdrawn entry: 410 on its paths on the sites that showed it, or 301 to the replacement entry. */
export async function redirectWithdrawn(
  tx: DbTx,
  scope: Scope,
  entry: EntryRef,
  slug: string,
  replacementId: string | null,
  onSites?: readonly string[],
) {
  let created = 0;
  for (const { siteId, path: from } of await entryPaths(tx, scope, entry, slug, onSites)) {
    await retire(tx, scope, siteId, from);
    await tx.cmsRedirect.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        siteId,
        fromPath: from,
        toEntryId: replacementId,
        code: replacementId ? 301 : 410,
        reason: "archived",
        createdBy: scope.userId,
      },
    });
    created++;
  }
  return created;
}

const redirectView = (row: {
  id: string;
  siteId: string;
  fromPath: string;
  toEntryId: string | null;
  toPath: string | null;
  code: number;
  reason: string;
  createdAt: Date;
}) => ({
  id: row.id,
  siteId: row.siteId,
  fromPath: row.fromPath,
  toEntryId: row.toEntryId,
  toPath: row.toPath,
  code: row.code,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});

const listQuery = z.object({ cursor: z.string().max(200).optional(), limit: listLimit }).strict();

/** Active redirects of a site, newest first. */
export async function listRedirects(tx: DbTx, scope: Scope, siteId: string, raw: unknown) {
  await requireSite(tx, scope, siteId);
  const q = listQuery.parse(raw ?? {});
  const after = decodeCursor(q.cursor);
  const rows = await tx.cmsRedirect.findMany({
    where: {
      projectId: scope.projectId,
      siteId,
      removedAt: null,
      ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(redirectView),
    nextCursor:
      rows.length > q.limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") : null,
  };
}

const createInput = z
  .object({
    fromPath: path,
    code: z.union([z.literal(301), z.literal(410)]),
    toPath: path.optional(),
    toEntryId: z.uuid().optional(),
  })
  .strict();

/** A manual redirect; replaces an active one from the same path. */
export async function createRedirect(tx: DbTx, scope: Scope, siteId: string, raw: unknown) {
  await requireSite(tx, scope, siteId);
  const input = createInput.parse(raw);
  const targets = Number(Boolean(input.toPath)) + Number(Boolean(input.toEntryId));
  if (input.code === 410 ? targets !== 0 : targets !== 1) throw refused("CMS_REDIRECT_TARGET_INVALID", 422);
  if (input.toPath === input.fromPath) throw refused("CMS_REDIRECT_LOOP", 422);
  if (input.toEntryId && !(await tx.cmsEntry.findFirst({ where: { id: input.toEntryId, projectId: scope.projectId }, select: { id: true } })))
    throw refused("CMS_REFERENCE_UNKNOWN", 422, { missing: { toEntryId: [input.toEntryId] } });
  if (input.toPath) {
    const back = await tx.cmsRedirect.findFirst({
      where: { projectId: scope.projectId, siteId, fromPath: input.toPath, toPath: input.fromPath, removedAt: null },
      select: { id: true },
    });
    if (back) throw refused("CMS_REDIRECT_LOOP", 422);
  }
  await retire(tx, scope, siteId, input.fromPath);
  const row = await tx.cmsRedirect.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      siteId,
      fromPath: input.fromPath,
      toPath: input.toPath ?? null,
      toEntryId: input.toEntryId ?? null,
      code: input.code,
      reason: "manual",
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "cms.redirect.created", row.id, { siteId, code: row.code });
  return redirectView(row);
}

export async function removeRedirect(tx: DbTx, scope: Scope, siteId: string, redirectId: string) {
  await requireSite(tx, scope, siteId);
  if (!UUID_RE.test(redirectId)) throw notFound("CMS_REDIRECT_NOT_FOUND");
  const result = await tx.cmsRedirect.updateMany({
    where: { id: redirectId, projectId: scope.projectId, siteId, removedAt: null },
    data: { removedAt: new Date() },
  });
  if (result.count !== 1) throw notFound("CMS_REDIRECT_NOT_FOUND");
  await audit(tx, scope, "cms.redirect.removed", redirectId, { siteId });
  return { removed: true };
}

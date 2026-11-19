import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit } from "../../../shared.ts";
import { localeInput, notFound, refused, requireVersion, UUID_RE, versionInput } from "../entries/common.ts";
import { entryPath, siteRoutes, type SiteRoutes } from "../types/routes.ts";
import { adapterCatalog, adapterFor, notifierAvailable, notifierCatalog, notifierInput, storedNotifiers, type Notifier } from "./adapters.ts";
import { contentRules, storedRules } from "./rules.ts";
import { liveRows } from "../delivery/live.ts";

// Websites of a project (ADR 0029 §3.2, CH1.11). A site names where content
// appears: its origin, locales, a route per type and locale, how it receives
// content (adapter), whom Orbit tells about changes (notifiers) and its
// editorial rules. Managing sites is owner work; members read them. Sites
// are archived, never deleted, because publications and redirects refer to
// them. A route change on a site with live entries leaves 301s from the old
// paths, so links keep working.

type SiteRow = Awaited<ReturnType<DbTx["cmsSite"]["findFirstOrThrow"]>>;

const name = z.string().trim().min(1).max(80);
/** The site's origin: HTTPS, host (and port) only, as the database requires. */
const baseUrl = z
  .string()
  .trim()
  .max(255)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !value.endsWith("#");
    } catch {
      return false;
    }
  }, "CMS_SITE_URL_INVALID")
  .transform((value) => new URL(value).origin);

const fields = {
  name,
  baseUrl,
  locales: z.array(localeInput).min(1).max(20),
  defaultLocale: localeInput,
  routes: siteRoutes,
  trailingSlash: z.boolean(),
  adapter: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  adapterConfig: z.record(z.string(), z.unknown()),
  notifiers: z.array(notifierInput).max(10),
  contentRules,
};

const createInput = z
  .object({
    ...fields,
    routes: siteRoutes.default({}),
    trailingSlash: fields.trailingSlash.default(true),
    adapter: fields.adapter.default("orbit_pull"),
    adapterConfig: fields.adapterConfig.default({}),
    notifiers: fields.notifiers.default([]),
    contentRules: contentRules.default(contentRules.parse({})),
  })
  .strict();

const updateInput = z
  .object({
    version: versionInput,
    name: fields.name.optional(),
    baseUrl: fields.baseUrl.optional(),
    locales: fields.locales.optional(),
    defaultLocale: fields.defaultLocale.optional(),
    routes: fields.routes.optional(),
    trailingSlash: fields.trailingSlash.optional(),
    adapter: fields.adapter.optional(),
    adapterConfig: fields.adapterConfig.optional(),
    notifiers: fields.notifiers.optional(),
    contentRules: contentRules.optional(),
  })
  .strict();

export function siteView(row: SiteRow) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    locales: row.locales,
    defaultLocale: row.defaultLocale,
    routes: row.routes as SiteRoutes,
    trailingSlash: row.trailingSlash,
    adapter: row.adapter,
    adapterConfig: row.adapterConfig as Record<string, unknown>,
    notifiers: storedNotifiers(row.notifiers),
    contentRules: storedRules(row.contentRules),
    verification: row.verification,
    archived: Boolean(row.archivedAt),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export async function findSite(tx: DbTx, scope: Scope, siteId: string, options: { lock?: boolean } = {}) {
  if (!UUID_RE.test(siteId)) throw notFound("CMS_SITE_NOT_FOUND");
  if (options.lock)
    await tx.$queryRaw`SELECT id FROM "CmsSite" WHERE id = ${siteId}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: scope.projectId } });
  if (!site) throw notFound("CMS_SITE_NOT_FOUND");
  return site;
}

/** Checks what the database cannot: locales, adapter, routes and notifier targets. */
async function validate(
  tx: DbTx,
  scope: Scope,
  site: { locales: string[]; defaultLocale: string; adapter: string; adapterConfig: Record<string, unknown>; routes: SiteRoutes; notifiers: Notifier[] },
) {
  if (new Set(site.locales).size !== site.locales.length) throw refused("CMS_SITE_LOCALES_INVALID", 422);
  if (!site.locales.includes(site.defaultLocale)) throw refused("CMS_SITE_DEFAULT_LOCALE_INVALID", 422);
  const adapter = adapterFor(site.adapter);
  if (!adapter?.available) throw refused("CMS_ADAPTER_UNAVAILABLE", 422, { adapter: site.adapter });
  const config = adapter.config.safeParse(site.adapterConfig);
  if (!config.success) throw refused("CMS_ADAPTER_CONFIG_INVALID", 422, { issues: config.error.issues.map((i) => i.path.join(".")) });
  // Routes only for locales the site serves; one site path per entry.
  const strayLocales = Object.values(site.routes).flatMap((byLocale) => Object.keys(byLocale).filter((l) => !site.locales.includes(l)));
  if (strayLocales.length) throw refused("CMS_SITE_ROUTE_LOCALE_UNKNOWN", 422, { locales: [...new Set(strayLocales)] });
  for (const [type, byLocale] of Object.entries(site.routes)) {
    const patterns = Object.values(byLocale);
    if (new Set(patterns).size !== patterns.length) throw refused("CMS_SITE_ROUTES_CLASH", 422, { type });
  }
  const unavailable = site.notifiers.filter((n) => !notifierAvailable(n.kind)).map((n) => n.kind);
  if (unavailable.length) throw refused("CMS_NOTIFIER_UNAVAILABLE", 422, { kinds: [...new Set(unavailable)] });
  const endpointIds = site.notifiers.flatMap((n) => (n.kind === "webhook" ? [n.endpointId] : []));
  if (new Set(endpointIds).size !== endpointIds.length) throw refused("CMS_NOTIFIER_DUPLICATE", 422);
  if (endpointIds.length) {
    const found = await tx.webhookEndpoint.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, id: { in: endpointIds }, ownerModule: "cms" },
      select: { id: true },
    });
    const missing = endpointIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw refused("CMS_NOTIFIER_ENDPOINT_UNKNOWN", 422, { endpointIds: missing });
  }
  return config.data;
}

export async function listSites(tx: DbTx, scope: Scope, raw: unknown) {
  const q = z.object({ archived: z.enum(["true", "false"]).optional() }).strict().parse(raw ?? {});
  const rows = await tx.cmsSite.findMany({
    where: { projectId: scope.projectId, ...(q.archived === "true" ? {} : { archivedAt: null }) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
  return { items: rows.map(siteView), adapters: adapterCatalog(), notifiers: notifierCatalog() };
}

export async function getSite(tx: DbTx, scope: Scope, siteId: string) {
  const site = await findSite(tx, scope, siteId);
  const entries = await tx.cmsEntrySite.count({ where: { projectId: scope.projectId, siteId } });
  const live = await liveEntries(tx, scope, siteId);
  return { site: siteView(site), entries, liveEntries: live.length };
}

export async function createSite(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  const adapterConfig = await validate(tx, scope, input);
  const row = await tx.cmsSite.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      locales: input.locales,
      defaultLocale: input.defaultLocale,
      routes: input.routes as Prisma.InputJsonValue,
      trailingSlash: input.trailingSlash,
      adapter: input.adapter,
      adapterConfig: adapterConfig as Prisma.InputJsonValue,
      notifiers: input.notifiers as Prisma.InputJsonValue,
      contentRules: input.contentRules as Prisma.InputJsonValue,
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "cms.site.created", row.id, { adapter: row.adapter, locales: row.locales.length, notifiers: input.notifiers.length });
  return { site: siteView(row) };
}

/**
 * Entries the site shows with their live slug, for path changes: those whose
 * live revision went live on this site (the delivery rule), not merely the
 * ones assigned to it.
 */
async function liveEntries(tx: DbTx, scope: Scope, siteId: string) {
  const rows = await liveRows(tx, scope, siteId, {}, { limit: 10_000 });
  if (!rows.length) return [];
  const entries = await tx.cmsEntry.findMany({
    where: { projectId: scope.projectId, id: { in: rows.map((r) => r.id) }, publishedRevisionId: { not: null } },
    select: { id: true, type: true, locale: true, publishedRevisionId: true },
  });
  const revisions = await tx.cmsRevision.findMany({
    where: { projectId: scope.projectId, id: { in: entries.map((e) => e.publishedRevisionId!) } },
    select: { id: true, slug: true },
  });
  const slugOf = new Map(revisions.map((r) => [r.id, r.slug]));
  return entries.map((e) => ({ ...e, slug: slugOf.get(e.publishedRevisionId!)! }));
}

const pathOn = (site: { routes: SiteRoutes; trailingSlash: boolean }, entry: { type: string; locale: string; slug: string }) => {
  try {
    return entryPath(site.routes, entry.type, entry.locale, entry.slug, site.trailingSlash);
  } catch {
    return null;
  }
};

export async function updateSite(tx: DbTx, scope: Scope, siteId: string, raw: unknown) {
  const input = updateInput.parse(raw);
  const current = await findSite(tx, scope, siteId, { lock: true });
  if (current.archivedAt) throw refused("CMS_SITE_ARCHIVED", 409);
  requireVersion(current.version, input.version);
  const next = {
    locales: input.locales ?? current.locales,
    defaultLocale: input.defaultLocale ?? current.defaultLocale,
    adapter: input.adapter ?? current.adapter,
    adapterConfig: input.adapterConfig ?? (current.adapterConfig as Record<string, unknown>),
    routes: input.routes ?? siteRoutes.parse(current.routes),
    trailingSlash: input.trailingSlash ?? current.trailingSlash,
    notifiers: input.notifiers ?? storedNotifiers(current.notifiers),
  };
  const adapterConfig = await validate(tx, scope, next);

  // Entries live on this site keep their locale; a dropped locale would orphan them.
  const live = await liveEntries(tx, scope, siteId);
  const orphaned = live.filter((e) => !next.locales.includes(e.locale));
  if (orphaned.length) throw refused("CMS_SITE_LOCALE_IN_USE", 409, { entryIds: orphaned.slice(0, 20).map((e) => e.id) });

  // Changed paths of live entries: 301 from the old path to the entry.
  const before = { routes: siteRoutes.parse(current.routes), trailingSlash: current.trailingSlash };
  const moved = live.flatMap((entry) => {
    const from = pathOn(before, entry);
    const to = pathOn(next, entry);
    return from && to && from !== to ? [{ entryId: entry.id, from, to }] : [];
  });
  for (const m of moved) {
    await tx.cmsRedirect.updateMany({
      where: { projectId: scope.projectId, siteId, fromPath: { in: [m.from, m.to] }, removedAt: null },
      data: { removedAt: new Date() },
    });
    await tx.cmsRedirect.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        siteId,
        fromPath: m.from,
        toEntryId: m.entryId,
        code: 301,
        // A person's change (the owner's new routes), not a slug change.
        reason: "manual",
        createdBy: scope.userId,
      },
    });
  }

  const row = await tx.cmsSite.update({
    where: { id: siteId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      locales: next.locales,
      defaultLocale: next.defaultLocale,
      routes: next.routes as Prisma.InputJsonValue,
      trailingSlash: next.trailingSlash,
      adapter: next.adapter,
      adapterConfig: adapterConfig as Prisma.InputJsonValue,
      notifiers: next.notifiers as Prisma.InputJsonValue,
      ...(input.contentRules ? { contentRules: input.contentRules as Prisma.InputJsonValue } : {}),
      // A new origin has not been checked yet.
      ...(input.baseUrl && input.baseUrl !== current.baseUrl ? { verification: "configured" } : {}),
      version: { increment: 1 },
    },
  });
  await audit(tx, scope, "cms.site.updated", siteId, {
    fields: Object.keys(input).filter((k) => k !== "version").sort(),
    redirects: moved.length,
  });
  return { site: siteView(row), redirects: moved.map((m) => ({ fromPath: m.from, toPath: m.to, entryId: m.entryId })) };
}

/**
 * Archives a site: publishing to it stops (the preflight refuses archived
 * sites) and the delivery API stops serving it (CH1.12). Entries stay.
 */
export async function archiveSite(tx: DbTx, scope: Scope, siteId: string, raw: unknown) {
  const { version } = z.object({ version: versionInput }).strict().parse(raw);
  const site = await findSite(tx, scope, siteId, { lock: true });
  requireVersion(site.version, version);
  if (site.archivedAt) return { site: siteView(site) };
  const waiting = await tx.cmsPublication.count({ where: { projectId: scope.projectId, siteId, status: "queued" } });
  if (waiting) throw refused("CMS_SITE_HAS_SCHEDULE", 409, { publications: waiting });
  const row = await tx.cmsSite.update({ where: { id: siteId }, data: { archivedAt: new Date(), version: { increment: 1 } } });
  await audit(tx, scope, "cms.site.archived", siteId, {});
  return { site: siteView(row) };
}

export async function restoreSite(tx: DbTx, scope: Scope, siteId: string, raw: unknown) {
  const { version } = z.object({ version: versionInput }).strict().parse(raw);
  const site = await findSite(tx, scope, siteId, { lock: true });
  requireVersion(site.version, version);
  if (!site.archivedAt) return { site: siteView(site) };
  const row = await tx.cmsSite.update({ where: { id: siteId }, data: { archivedAt: null, version: { increment: 1 } } });
  await audit(tx, scope, "cms.site.restored", siteId, {});
  return { site: siteView(row) };
}

/** Raises a site's verification; never lowers it (a new origin resets it on save). */
export async function raiseVerification(tx: DbTx, scope: Scope, siteId: string, level: "read_verified" | "live_verified") {
  const order = ["configured", "read_verified", "live_verified"];
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: scope.projectId }, select: { verification: true } });
  if (!site || order.indexOf(site.verification) >= order.indexOf(level)) return false;
  await tx.cmsSite.update({ where: { id: siteId }, data: { verification: level } });
  await audit(tx, scope, "cms.site.verified", siteId, { level });
  return true;
}

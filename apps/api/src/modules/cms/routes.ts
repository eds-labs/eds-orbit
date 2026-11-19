import { z } from "zod";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { CMS_BASE, inCms } from "./http-scope.ts";
import { cmsModule } from "./manifest.ts";
import { CMS_READ, CMS_SETTINGS } from "./permissions.ts";
import { readCmsSettings, saveCmsSettings } from "./settings.ts";
import { cmsEntryRoutes } from "./entries/routes.ts";
import { cmsMediaRoutes } from "./media/routes.ts";
import { cmsPublishingRoutes } from "./publishing/routes.ts";
import { cmsSiteRoutes } from "./sites/routes.ts";
import { cmsDeliveryRoutes } from "./delivery/routes.ts";
import { cmsManagementRoutes } from "./management/routes.ts";
import { pendingRequestsByEntry } from "./publishing/requests.ts";

const settingsInput = z.object({ settings: z.unknown(), version: z.int().min(1) }).strict();

/** At most about two months per calendar request. */
const CALENDAR_MAX_MS = 62 * 86_400_000;
const calendarQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .strict()
  .refine((q) => {
    const span = Date.parse(q.to) - Date.parse(q.from);
    return span > 0 && span <= CALENDAR_MAX_MS;
  }, "CMS_CALENDAR_RANGE_INVALID");

const SHOWN = ["visible", "notified", "live_verified"] as const;

/** Content module routes; later steps add sites and the versioned API. */
export const cmsRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.get(`${CMS_BASE}/status`, (req) =>
    inCms(auth, req, CMS_READ, async (tx, scope) => {
      const { settings, version } = await readCmsSettings(tx, scope);
      return {
        module: "cms" as const,
        version: cmsModule.version,
        settings,
        settingsVersion: version,
      };
    }),
  );
  // Counts for the overview (CH1.14a): entries by status, open decisions, sites.
  app.get(`${CMS_BASE}/summary`, (req) =>
    inCms(auth, req, CMS_READ, async (tx, scope) => {
      const groups = await tx.cmsEntry.groupBy({ by: ["status"], where: { projectId: scope.projectId }, _count: { _all: true } });
      const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
      const recent = await tx.cmsEntry.findMany({
        where: { projectId: scope.projectId, archivedAt: null },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 5,
        select: { id: true, status: true, locale: true, updatedAt: true },
      });
      const titles = await tx.cmsDraft.findMany({
        where: { projectId: scope.projectId, entryId: { in: recent.map((r) => r.id) } },
        select: { entryId: true, title: true },
      });
      return {
        entries: {
          draft: byStatus.draft ?? 0,
          scheduled: byStatus.scheduled ?? 0,
          published: byStatus.published ?? 0,
          archived: byStatus.archived ?? 0,
        },
        waiting: (await pendingRequestsByEntry(tx, scope)).size,
        sites: await tx.cmsSite.count({ where: { projectId: scope.projectId, archivedAt: null } }),
        recent: recent.map((r) => ({
          id: r.id,
          status: r.status,
          locale: r.locale,
          title: titles.find((t) => t.entryId === r.id)?.title ?? "",
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    }),
  );
  // The calendar (CH1.14e): schedules and publications in a time range,
  // one item per entry, action and version (websites together).
  app.get(`${CMS_BASE}/calendar`, (req) =>
    inCms(auth, req, CMS_READ, async (tx, scope) => {
      const q = calendarQuery.parse(req.query ?? {});
      const from = new Date(q.from);
      const to = new Date(q.to);
      const scheduled = await tx.cmsEntry.findMany({
        where: { projectId: scope.projectId, scheduledAt: { gte: from, lt: to }, archivedAt: null },
        select: { id: true, locale: true, scheduledAt: true, scheduledRevisionId: true },
        take: 500,
      });
      const queued = scheduled.length
        ? await tx.cmsPublication.findMany({
            where: { projectId: scope.projectId, entryId: { in: scheduled.map((e) => e.id) }, status: "queued" },
            select: { entryId: true, siteId: true },
          })
        : [];
      const shown = await tx.cmsPublication.findMany({
        where: { projectId: scope.projectId, visibleAt: { gte: from, lt: to }, status: { in: [...SHOWN] } },
        select: { entryId: true, revisionId: true, siteId: true, action: true, visibleAt: true },
        orderBy: { visibleAt: "asc" },
        take: 2000,
      });
      const entryIds = [...new Set([...scheduled.map((e) => e.id), ...shown.map((p) => p.entryId)])];
      const entries = entryIds.length
        ? await tx.cmsEntry.findMany({ where: { projectId: scope.projectId, id: { in: entryIds } }, select: { id: true, locale: true, status: true } })
        : [];
      const drafts = entryIds.length
        ? await tx.cmsDraft.findMany({ where: { projectId: scope.projectId, entryId: { in: entryIds } }, select: { entryId: true, title: true } })
        : [];
      const titleOf = (id: string) => drafts.find((d) => d.entryId === id)?.title ?? "";
      const localeOf = (id: string) => entries.find((e) => e.id === id)?.locale ?? "";
      type Item = { entryId: string; title: string; locale: string; kind: string; at: string; siteIds: string[] };
      const items: Item[] = scheduled.map((e) => ({
        entryId: e.id,
        title: titleOf(e.id),
        locale: e.locale,
        kind: "scheduled",
        at: e.scheduledAt!.toISOString(),
        siteIds: [...new Set(queued.filter((p) => p.entryId === e.id).map((p) => p.siteId))],
      }));
      const grouped = new Map<string, Item>();
      for (const p of shown) {
        const key = `${p.entryId}:${p.action}:${p.revisionId}`;
        const item = grouped.get(key);
        if (item) {
          if (!item.siteIds.includes(p.siteId)) item.siteIds.push(p.siteId);
          continue;
        }
        grouped.set(key, {
          entryId: p.entryId,
          title: titleOf(p.entryId),
          locale: localeOf(p.entryId),
          kind: p.action === "publish" ? "published" : p.action === "update" ? "updated" : "unpublished",
          at: p.visibleAt!.toISOString(),
          siteIds: [p.siteId],
        });
      }
      items.push(...grouped.values());
      items.sort((a, b) => a.at.localeCompare(b.at) || a.entryId.localeCompare(b.entryId));
      return { from: from.toISOString(), to: to.toISOString(), items };
    }),
  );
  app.put(`${CMS_BASE}/settings`, (req) =>
    inCms(auth, req, CMS_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return saveCmsSettings(tx, scope, settings, version);
    }),
  );
  cmsEntryRoutes(context);
  cmsMediaRoutes(context);
  cmsPublishingRoutes(context);
  cmsSiteRoutes(context);
  cmsDeliveryRoutes(context);
  cmsManagementRoutes(context);
};

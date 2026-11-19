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

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
};

import type { RoutesContribution } from "../../platform/http/routes.ts";
import { ADS_BASE, inAds } from "./http-scope.ts";
import { adsModule } from "./manifest.ts";
import { ADS_READ } from "./permissions.ts";
import { readAdsSettings } from "./settings.ts";

/** Ads module routes; later steps add accounts, campaigns and reports. */
export const adsRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.get(`${ADS_BASE}/status`, (req) =>
    inAds(auth, req, ADS_READ, async (tx, scope) => {
      const { settings, version } = await readAdsSettings(tx, scope);
      return {
        module: "ads" as const,
        version: adsModule.version,
        settings,
        settingsVersion: version,
      };
    }),
  );
};

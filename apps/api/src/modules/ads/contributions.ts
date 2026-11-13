import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { adsConnectionProviders } from "./accounts/providers.ts";
import { adsAccountHealth } from "./accounts/health.ts";
import { adsOAuthStateCleanup } from "./accounts/cleanup.ts";
import { adsSwitchedOn } from "./gate.ts";
import { adsUserNotifications } from "./notifications.ts";
import { adsRoutes } from "./routes.ts";

/** What the ads module plugs into the platform; later steps add to it. */
export const adsContributions: ModuleContributions = {
  available: adsSwitchedOn,
  unavailableCode: "ADS_DISABLED",
  routes: adsRoutes,
  connections: { providers: adsConnectionProviders },
  periodic: [adsAccountHealth, adsOAuthStateCleanup],
  userNotifications: adsUserNotifications,
  events: { publishes: ["ads.account.reconnect_required"] },
};

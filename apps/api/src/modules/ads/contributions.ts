import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { adsSwitchedOn } from "./gate.ts";
import { adsRoutes } from "./routes.ts";

/** What the ads module plugs into the platform; later steps add to it. */
export const adsContributions: ModuleContributions = {
  available: adsSwitchedOn,
  unavailableCode: "ADS_DISABLED",
  routes: adsRoutes,
};

import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { supportSwitchedOn } from "./gate.ts";
import { supportRoutes } from "./routes.ts";

/** What the support module plugs into the platform (WP5.1). */
export const supportContributions: ModuleContributions = {
  available: supportSwitchedOn,
  routes: supportRoutes,
};

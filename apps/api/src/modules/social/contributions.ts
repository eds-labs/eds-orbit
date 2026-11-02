import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { socialSwitchedOn } from "./gate.ts";
import { socialRoutes } from "./routes.ts";

/** What the social module plugs into the platform; later phases add to it. */
export const socialContributions: ModuleContributions = {
  available: socialSwitchedOn,
  unavailableCode: "SOCIAL_DISABLED",
  routes: socialRoutes,
  // Post media belong to their posts: only social's own routes, with its
  // permissions, hand them out (never /files/:fileId).
  files: { privateToModule: true },
};

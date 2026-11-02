import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { socialOAuthStateCleanup } from "./accounts/oauth-state.ts";
import { socialConnectionProviders } from "./accounts/providers.ts";
import { socialAttention } from "./attention.ts";
import { socialSwitchedOn } from "./gate.ts";
import { socialUserNotifications } from "./notifications.ts";
import { socialRoutes } from "./routes.ts";

/** What the social module plugs into the platform; later phases add to it. */
export const socialContributions: ModuleContributions = {
  available: socialSwitchedOn,
  unavailableCode: "SOCIAL_DISABLED",
  routes: socialRoutes,
  // Post media belong to their posts: only social's own routes, with its
  // permissions, hand them out (never /files/:fileId).
  files: { privateToModule: true },
  // Developer apps (administration) and the module-managed account
  // connections (accounts/providers.ts).
  connections: { providers: socialConnectionProviders },
  periodic: [socialOAuthStateCleanup],
  attention: socialAttention,
  userNotifications: socialUserNotifications,
};

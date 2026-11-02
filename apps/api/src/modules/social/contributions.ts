import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { socialAccountHealth } from "./accounts/health.ts";
import { socialOAuthStateCleanup } from "./accounts/oauth-state.ts";
import { socialConnectionProviders } from "./accounts/providers.ts";
import { socialAttention } from "./attention.ts";
import { socialSwitchedOn } from "./gate.ts";
import { socialUserNotifications } from "./notifications.ts";
import { socialActionTypes } from "./posts/approval.ts";
import { socialJobs } from "./dispatch/jobs.ts";
import { resumeBlocked } from "./dispatch/control.ts";
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
  periodic: [socialOAuthStateCleanup, socialAccountHealth],
  // Owner approvals of a post's schedule or immediate publication (S4).
  actionTypes: socialActionTypes,
  // Sending approved posts on the Orbit worker (S5).
  jobs: socialJobs,
  // Deliveries a pause blocked go out again if they are recent (S5).
  hooks: {
    onProjectResume: async (tx, scope, { generation }) => {
      await resumeBlocked(tx, scope, new Date(), generation);
    },
  },
  // Content-free facts about publications for other modules (S9 Marketing).
  events: {
    publishes: ["social.publication.published", "social.publication.failed", "social.publication.outcome_unknown"],
  },
  attention: socialAttention,
  userNotifications: socialUserNotifications,
};

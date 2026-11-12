import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { socialAccountHealth } from "./accounts/health.ts";
import { socialMetrics } from "./analytics/collect.ts";
import { socialOAuthStateCleanup } from "./accounts/oauth-state.ts";
import { socialConnectionProviders } from "./accounts/providers.ts";
import { socialProjectIntegrations } from "./accounts/accounts.ts";
import { socialAttention } from "./attention.ts";
import { socialSwitchedOn } from "./gate.ts";
import { socialUserNotifications } from "./notifications.ts";
import { socialActionTypes } from "./posts/approval.ts";
import { VERIFY_WRITE_ACTION, verifyWriteAction } from "./accounts/verify-write.ts";
import { socialJobs } from "./dispatch/jobs.ts";
import { socialDeliverySweep } from "./dispatch/sweep.ts";
import { resumeBlocked } from "./dispatch/control.ts";
import { socialRoutes } from "./routes.ts";
import { socialMediaMcpCleanup } from "./media/mcp-cleanup.ts";
import { socialInstructions, socialMcpActionTypes, socialTools } from "./tools.ts";

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
  // Post figures every six hours (S8).
  // Stale MCP media upload sessions and idempotency receipts.
  periodic: [socialOAuthStateCleanup, socialAccountHealth, socialDeliverySweep, socialMetrics, socialMediaMcpCleanup],
  // Owner approvals of a post's schedule or immediate publication (S4).
  // and the owner's approval of a write verification post (S5).
  actionTypes: { ...socialActionTypes, [VERIFY_WRITE_ACTION]: verifyWriteAction, ...socialMcpActionTypes },
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
  // The connected accounts in the project's Integrations Center (ADR 0027).
  projectIntegrations: socialProjectIntegrations,
  userNotifications: socialUserNotifications,
  // Assistant and MCP reads and proposals (S7, ADR 0020 §6.5).
  tools: socialTools,
  assistant: {
    features: () => ["social"],
    instructions: () => socialInstructions,
  },
};

import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { chatTools } from "./tools/index.ts";
import { marketingActionTypes } from "./action-types.ts";
import { marketingJobs } from "./jobs.ts";
import { marketingScheduler } from "./scheduler.ts";
import { marketingHooks } from "./hooks.ts";
import { marketingRetention } from "./retention.ts";
import { marketingPeriodicTasks } from "./periodic.ts";
import { marketingActions } from "./actions.ts";
import { marketingRoutes } from "./routes.ts";
import { readiness } from "./readiness/readiness.ts";
import { marketingAssistant } from "./assistant/prompt.ts";
import { marketingConversationSections } from "./assistant/conversation.ts";
import { assignedPostizChannels } from "./publishing/postiz-assignment.ts";
import { data } from "../../shared.ts";
import { connectionsOf } from "../../platform/connections/connections.ts";
import { registerAgentSpecialists } from "./agents/specialists/index.ts";
import { agentsEnabled } from "./agents/assignments.ts";
import { stopCallback } from "./agents/telegram-stop.ts";
import { marketingNotifications } from "./agents/notification-messages.ts";
import { marketingConnections } from "./publishing/connection-providers.ts";

/**
 * What the marketing module plugs into the platform (WP1.6). Transitional:
 * the contributed code still lives in the flat api modules until WP2.1.
 */
export const marketingContributions: ModuleContributions = {
  // Every assistant tool Orbit has today, in the order the chat offered them.
  tools: chatTools,
  actionTypes: marketingActionTypes,
  jobs: marketingJobs,
  scheduler: marketingScheduler,
  hooks: marketingHooks,
  retention: marketingRetention,
  periodic: marketingPeriodicTasks,
  actions: marketingActions,
  routes: marketingRoutes,
  readiness,
  assistant: marketingAssistant,
  conversationSections: marketingConversationSections,
  // Postiz channels by id, for the owner's decisions on action requests.
  channelDirectory: async (tx, scope) =>
    (await connectionsOf(tx, scope, "postiz")).flatMap((row) =>
      assignedPostizChannels(data(row)),
    ),
  // The owner's bot runs with Orbit Agents; its previews carry Stop (WP2.5a).
  telegram: { enabled: agentsEnabled, callbacks: { stop: stopCallback } },
  // Previews, notices and the daily report the bot sends (WP2.5b).
  notifications: marketingNotifications,
  // Postiz, Matomo and Slack connections and their checks (WP2.5c).
  connections: marketingConnections,
  // The model specialists and executor steps of the `agent` queue.
  onWorkerStart: registerAgentSpecialists,
  publicViews: {
    // Asset bytes never leave the server through the collection API.
    assets: (row) => {
      const { base64, ...safe } = data(row);
      return {
        ...row,
        data: {
          ...safe,
          hasContent: typeof base64 === "string" && base64.length > 0,
        },
      };
    },
  },
};

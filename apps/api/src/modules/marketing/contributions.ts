import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { chatTools } from "./tools/index.ts";
import { marketingActionTypes } from "./action-types.ts";
import { marketingJobs } from "./jobs.ts";
import { marketingScheduler } from "./scheduler.ts";
import { marketingHooks } from "./hooks.ts";
import { marketingRetention } from "./retention.ts";
import { marketingPeriodicTasks } from "./periodic.ts";
import { registerAgentSpecialists } from "./agents/specialists/index.ts";
import { data } from "../../shared.ts";

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

import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { chatTools } from "../agents/tools/index.ts";
import { marketingActionTypes } from "./action-types.ts";

/**
 * What the marketing module plugs into the platform (WP1.6). Transitional:
 * the contributed code still lives in the flat api modules until WP2.1.
 */
export const marketingContributions: ModuleContributions = {
  // Every assistant tool Orbit has today, in the order the chat offered them.
  tools: chatTools,
  actionTypes: marketingActionTypes,
};

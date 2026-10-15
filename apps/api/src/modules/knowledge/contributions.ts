import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { knowledgeActions } from "./actions.ts";
import { knowledgeRoutes } from "./routes.ts";

/**
 * What the knowledge module plugs into the platform (WP2.1f, WP3.3): its
 * management actions and read routes. The knowledge services themselves
 * belong to the platform (platform/knowledge), so the assistant and other
 * modules keep them while this module is off.
 */
export const knowledgeContributions: ModuleContributions = {
  actions: knowledgeActions,
  routes: knowledgeRoutes,
};

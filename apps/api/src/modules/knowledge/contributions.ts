import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { knowledgeActions } from "./actions.ts";

/**
 * What the knowledge module plugs into the platform (WP2.1f). Transitional:
 * the knowledge services stay where they are until WP3.3.
 */
export const knowledgeContributions: ModuleContributions = {
  actions: knowledgeActions,
};

import { runAnalysis } from "./workspace.ts";
import { knowledgeMcpTools, knowledgeMcpActions } from "./mcp-tools.ts";
import {
  knowledgeEvaluationActionTypes,
  knowledgeEvaluationTools,
} from "./evaluation-tools.ts";
import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { knowledgeActions } from "./actions.ts";
import { knowledgeRoutes } from "./routes.ts";
import { knowledgeActionPermissions } from "./permissions.ts";
import { knowledgeAttention } from "./attention.ts";

/**
 * What the knowledge module plugs into the platform (WP2.1f, WP3.3): its
 * management actions and read routes. The knowledge services themselves
 * belong to the platform (platform/knowledge), so the assistant and other
 * modules keep them while this module is off.
 */
export const knowledgeContributions: ModuleContributions = {
  jobs: [
    {
      queueClass: "knowledge_analysis",
      concurrency: 1,
      leaseMs: 300000,
      handler: ({ scope, job }) => runAnalysis(scope, job.resourceId),
    },
  ],
  actions: knowledgeActions,
  // The live RAG evaluation over MCP (docs/MCP_PROJECT_ADMINISTRATION.md).
  tools: [...knowledgeMcpTools, ...knowledgeEvaluationTools],
  actionTypes: { ...knowledgeMcpActions, ...knowledgeEvaluationActionTypes },
  actionPermissions: knowledgeActionPermissions,
  routes: knowledgeRoutes,
  // Stale and expiring sources, conflicts and failed imports that need the
  // member (UI restructure §4.2).
  attention: knowledgeAttention,
};

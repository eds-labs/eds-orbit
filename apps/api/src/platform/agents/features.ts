/**
 * Tool features (registry `feature`) switched on per channel. Split from
 * capabilities.ts so the principal can use it without an import cycle.
 */
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { registeredAssistants } from "../modules/contributions.ts";
import type { ToolFeature } from "./tools/registry.ts";

/**
 * The tool features the platform switches on by flag, after the modules'
 * own features. Module operations (`mcp_tasks`) are offered only where the
 * caller says so: delegated MCP work orders and MCP clients, never the
 * in-app chat (its ~22 KB of operation schemas left a Claude chat too
 * little room, CHAT_CONTEXT_LIMIT).
 */
export function platformFeatures(options: { moduleOperations: boolean }): ToolFeature[] {
  const config = loadConfig();
  const features: ToolFeature[] = [];
  if (options.moduleOperations && config.ORBIT_MCP_TASKS === "true")
    features.push("mcp_tasks");
  if (config.ORBIT_MCP_PROJECT_CONFIGURATION === "true")
    features.push("project_configuration");
  if (config.ORBIT_MCP_PROJECT_ADMINISTRATION === "true")
    features.push("project_administration");
  return features;
}

/**
 * The features of configured agents (ADR 0021): the enabled modules' own
 * features as MCP lists them, the platform's flags, and module operations
 * always: a tool reaches an agent only through its explicit agent
 * exposure, so the MCP work-order switch does not gate it.
 */
export function agentFeatures(enabled?: ReadonlySet<string>): ToolFeature[] {
  return [
    ...registeredAssistants(enabled).flatMap((a) => a.features({ toolSearch: true })),
    "mcp_tasks",
    ...platformFeatures({ moduleOperations: false }),
  ];
}

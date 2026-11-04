/**
 * Capability layer (ADR 0021, plan agent-platform-phase-1 WP1.1): the one
 * place that decides which registry tools a member may be offered in a
 * project, and that runs one tool call. The conversational host
 * (chat-runner), the task host (runStructured) and the MCP gateway all use
 * it, so a rule change for tool visibility or execution applies to every
 * channel at once. Channel-specific gates (MCP grants and scopes, delegated
 * work orders, quotas) stay with their channel and narrow this set further;
 * nothing here can widen what the member may do in the UI.
 */
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { AssistantContribution } from "../assistant/types.ts";
import {
  registeredToolOwner,
  registeredTools,
} from "../modules/contributions.ts";
import { effectiveRole, moduleScope } from "../tenancy/module-roles.ts";
import {
  availableTools,
  exposedToAssistant,
  exposedToMcp,
  type OrbitTool,
  type ToolContext,
  type ToolFeature,
  type ToolResult,
} from "./tools/registry.ts";

/** Where a tool is offered: Orbit's own hosts, or an outside MCP client. */
export type CapabilityChannel = "assistant" | "mcp";

const EXPOSED: Record<CapabilityChannel, (tool: OrbitTool) => boolean> = {
  assistant: exposedToAssistant,
  mcp: exposedToMcp,
};

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

/** The features the given module assistants turn on, then the platform's. */
export function capabilityFeatures(
  assistants: readonly AssistantContribution[],
  options: {
    toolSearch: boolean;
    fullTools?: boolean;
    moduleOperations: boolean;
  },
): ToolFeature[] {
  const moduleOptions =
    options.fullTools === undefined
      ? { toolSearch: options.toolSearch }
      : { toolSearch: options.toolSearch, fullTools: options.fullTools };
  return [
    ...assistants.flatMap((assistant) => assistant.features(moduleOptions)),
    ...platformFeatures({ moduleOperations: options.moduleOperations }),
  ];
}

/**
 * The registry tools the member may be offered for a channel, in registry
 * order: tools of the enabled modules (all available ones without a set),
 * exposed to the channel, whose module the member can see and whose
 * permission and feature the member's role in that module allows.
 */
export function resolveCapabilities(
  scope: Scope,
  options: {
    channel: CapabilityChannel;
    enabled: ReadonlySet<string> | undefined;
    features: readonly ToolFeature[];
  },
): OrbitTool[] {
  const exposed = EXPOSED[options.channel];
  return registeredTools(options.enabled).filter((tool) => {
    if (!exposed(tool)) return false;
    const role = effectiveRole(scope, registeredToolOwner(tool.name));
    return (
      role !== "none" && availableTools([tool], role, options.features).length > 0
    );
  });
}

/**
 * The arguments parsed with the tool's own schema, asynchronously so async
 * refinements run instead of throwing. A ZodError names the invalid fields.
 */
export const validateCapabilityArgs = (tool: OrbitTool, args: unknown) =>
  tool.parameters.parseAsync(args);

/**
 * Runs one authorized tool call. The tool runs with the member's role in
 * its own module (WP4.5) unless the host still runs it with the project
 * role (`roleScope: "project"`, the task host until WP1.3). With
 * `validate: "host"` the arguments are parsed with the tool's own schema
 * first (async refinements included) and the parsed value is passed on, as
 * the MCP gateway does; with `"tool"` the raw arguments are passed and the
 * tool validates them itself, as the in-app hosts do today.
 */
export async function executeCapability(
  tool: OrbitTool,
  context: ToolContext,
  args: unknown,
  options: { validate: "host" | "tool"; roleScope?: "module" | "project" } = {
    validate: "tool",
  },
): Promise<ToolResult> {
  const input =
    options.validate === "host" ? await validateCapabilityArgs(tool, args) : args;
  const scope =
    options.roleScope === "project"
      ? context.scope
      : moduleScope(context.scope, registeredToolOwner(tool.name));
  return tool.execute({ ...context, scope }, input);
}

/** Tool results sent back to a model are capped at this length. */
export const MAX_TOOL_OUTPUT_CHARS = 12_000;

/**
 * A tool result as JSON of at most `max` characters that is always valid
 * JSON. A result that fits is sent unchanged. A longer one is sent as
 * `{"truncated":true,"partial":"<the first part of its JSON>"}`, so the
 * model sees that it was cut and never receives broken JSON (before WP1.1
 * the JSON text was sliced, which could end inside a string or object).
 */
export function capToolOutput(output: unknown, max = MAX_TOOL_OUTPUT_CHARS): string {
  const json = JSON.stringify(output) ?? "null";
  if (json.length <= max) return json;
  const wrap = (part: string) => JSON.stringify({ truncated: true, partial: part });
  // Escaping can grow the text; shrink until the wrapper fits.
  let length = Math.max(0, max - wrap("").length);
  let capped = wrap(json.slice(0, length));
  while (capped.length > max && length > 0) {
    length -= Math.max(1, capped.length - max);
    capped = wrap(json.slice(0, Math.max(0, length)));
  }
  return capped;
}

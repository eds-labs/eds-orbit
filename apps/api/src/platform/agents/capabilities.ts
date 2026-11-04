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
import { platformFeatures } from "./features.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { AssistantContribution } from "../assistant/types.ts";
import {
  registeredToolOwner,
  registeredTools,
} from "../modules/contributions.ts";
import { effectiveRole, moduleScope } from "../tenancy/module-roles.ts";
import { agentExecution, type AgentToolBudget } from "./agent-execution.ts";
import { authorizeAgentTool, type AgentPrincipal } from "./principal.ts";
import {
  availableTools,
  dropNullFields,
  exposedToAgent,
  exposedToAssistant,
  exposedToMcp,
  exposedToPersonal,
  userScoped,
  type OrbitTool,
  type ToolContext,
  type ToolFeature,
  type ToolResult,
} from "./tools/registry.ts";

/**
 * Where a tool is offered: Orbit's own hosts (project chat), an outside MCP
 * client, a configured agent, or the personal Orbit Assistant's project
 * tools (ADR 0022). User tools (`scopeShape: "user"`) are never project
 * capabilities: they act across projects and are offered only by the
 * personal turn host (`personalUserTools`).
 */
export type CapabilityChannel = "assistant" | "mcp" | "agent" | "personal";

const EXPOSED: Record<CapabilityChannel, (tool: OrbitTool) => boolean> = {
  assistant: (tool) => exposedToAssistant(tool) && !userScoped(tool),
  mcp: (tool) => exposedToMcp(tool) && !userScoped(tool),
  agent: (tool) => exposedToAgent(tool) && !userScoped(tool),
  personal: (tool) => exposedToPersonal(tool) && !userScoped(tool),
};

/**
 * The user tools of the personal Orbit Assistant (ADR 0022 §6), in
 * registry order: platform tools with `scopeShape: "user"` that opt into
 * the personal channel. Each reads per project in its own transaction.
 */
export function personalUserTools(): OrbitTool[] {
  return registeredTools().filter(
    (tool) => userScoped(tool) && tool.exposure?.personal === true,
  );
}

export { platformFeatures } from "./features.ts";

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

/**
 * An agent's arguments as its tool's schema reads them. Strict tool calls
 * send null for every optional field the model leaves empty; when the raw
 * arguments fail, they are read once more without those nulls.
 */
async function agentArgs(tool: OrbitTool, raw: unknown) {
  const first = await tool.parameters.safeParseAsync(raw);
  if (first.success) return first.data;
  return validateCapabilityArgs(tool, dropNullFields(raw));
}

/**
 * Runs one tool call of a configured agent (ADR 0021 §2). The principal is
 * checked first (authorizeAgentTool: allowlist, mode, module, sponsor and
 * requester rights, the work order's own checks); nothing runs on a
 * refusal. The arguments are validated on the host. The tool runs with the
 * sponsor's current scope in its module, and every ActionRequest it creates
 * records the agent (agent-execution.ts).
 */
export async function executeAgentCapability(
  principal: AgentPrincipal,
  tool: OrbitTool,
  context: Omit<ToolContext, "principal" | "channel">,
  args: unknown,
  options: { current?: () => Promise<void>; budget?: AgentToolBudget } = {},
): Promise<ToolResult> {
  const scope = await authorizeAgentTool(principal, context.scope, tool, options);
  const input = await agentArgs(tool, args);
  const store = {
    principal,
    agentRunId: context.runId,
    ...(options.budget ? { budget: options.budget } : {}),
  };
  return agentExecution.run(store, () =>
    tool.execute({ ...context, scope, principal }, input),
  );
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

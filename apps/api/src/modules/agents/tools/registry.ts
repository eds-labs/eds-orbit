/**
 * Agent tool registry (ADR 0007). Every tool is declared once; the
 * model-facing strict JSON schema is generated from its zod parameters by
 * the pinned openai SDK, which rejects schemas strict mode cannot express.
 */
import type { z } from "zod";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { ChatCard } from "../../chat-tools.ts";

export type ToolRole = Scope["role"];
export type ToolNamespace =
  | "project"
  | "knowledge"
  | "content"
  | "brand"
  | "assets"
  | "analytics"
  | "calendar"
  | "drive"
  | "research"
  | "proposals";
// Agents never receive tools with external or irreversible effects.
export type ToolRisk = "R0_read" | "W0_internal" | "P_proposal";
export type ToolContext = {
  scope: Scope;
  runId: string;
  conversationId: string;
  // 1-based position of this call within the run.
  callIndex: number;
};
export type ToolResult = { output: unknown; cards: ChatCard[] };
export type OrbitTool = {
  name: string;
  namespace: ToolNamespace;
  description: string;
  parameters: z.ZodObject;
  risk: ToolRisk;
  roles: readonly ToolRole[];
  // Design for tool search (plan §6.4); unused until it is enabled.
  deferLoading: boolean;
  execute(context: ToolContext, args: unknown): Promise<ToolResult>;
};

// The function API accepts [a-zA-Z0-9_-]{1,64}; Orbit uses lower snake case.
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function responsesTool(tool: OrbitTool) {
  const generated = zodResponsesFunction({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  const { $schema: _schema, ...parameters } = generated.parameters as Record<
    string,
    unknown
  >;
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    strict: true as const,
    parameters,
  };
}

/** Validates a tool at import time, so a bad schema never reaches a paid call. */
export function defineTool(tool: OrbitTool): OrbitTool {
  if (!TOOL_NAME.test(tool.name)) throw new Error("TOOL_NAME_INVALID");
  responsesTool(tool);
  return tool;
}

export function availableTools(
  registry: readonly OrbitTool[],
  role: ToolRole,
): OrbitTool[] {
  return registry.filter((tool) => tool.roles.includes(role));
}

export function findTool(
  registry: readonly OrbitTool[],
  name: unknown,
): OrbitTool | undefined {
  return typeof name === "string"
    ? registry.find((tool) => tool.name === name)
    : undefined;
}

/**
 * Strict tool calls send null for every optional field the model leaves
 * empty; the server contracts expect such fields to be absent.
 */
export function dropNullFields(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      item !== null && typeof item === "object" ? dropNullFields(item) : item,
    );
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNullFields(field)]),
  );
}

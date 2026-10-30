/**
 * Agent tool registry (ADR 0007). Every tool is declared once; the
 * model-facing strict JSON schema is generated from its zod parameters by
 * the pinned openai SDK, which rejects schemas strict mode cannot express.
 */
import { z } from "zod";
import type { PermissionDef } from "../../../../../../packages/module-contracts/src/index.ts";
import { can } from "../../tenancy/permissions.ts";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { ChatCard } from "../../assistant/cards.ts";

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
  | "proposals"
  | "assignments"
  // A module's own namespace (WP4.1): the namespace only groups tools for
  // tool search, so a third module must not need a platform change for it.
  | (string & {});
// Agents never receive tools with external or irreversible effects.
export type ToolRisk = "R0_read" | "W0_internal" | "P_proposal";
// Tools behind a feature flag are offered only while it is on.
export type ToolFeature =
  | "content_packages"
  | "agents"
  | "mcp_tasks"
  | "project_configuration"
  | "project_administration"
  // Project management tools (ADR 0016), offered while the module is on.
  | "work"
  // The AI project manager's tools (ADR 0017), while ORBIT_WORK_PM is on.
  | "work_pm"
  // Issue center tools (ADR 0018), offered while the module is on.
  | "issues"
  // Creative Studio previews and options, while ORBIT_CREATIVE_STUDIO is on.
  | "creative_studio";
export type ToolContext = {
  scope: Scope;
  runId: string;
  conversationId: string;
  // 1-based position of this call within the run.
  callIndex: number;
  // Set for a specialist's task; its paid reads reserve under the task's keys, not as chat.
  agentTask?: { taskId: string; runId: string };
  // Set when the MCP gateway runs the tool for an outside client (Track M);
  // absent means the assistant. Only the gateway sets it.
  channel?: {
    kind: "mcp";
    clientId: string;
    grantId: string;
    requestId: string;
  };
};
/** An image a tool returns to an outside client (MCP image content), base64. */
export type ToolImage = { data: string; mimeType: "image/png" | "image/jpeg" };
export type ToolResult = {
  output: unknown;
  cards: ChatCard[];
  /** Sent over MCP next to the JSON output; the assistant never sees them. */
  images?: ToolImage[];
};
export type OrbitTool = {
  name: string;
  namespace: ToolNamespace;
  description: string;
  parameters: z.ZodObject;
  risk: ToolRisk;
  // Who may be offered and run the tool (WP1.5 permission catalogue).
  permission: PermissionDef;
  feature?: ToolFeature;
  // Design for tool search (plan §6.4); unused until it is enabled.
  deferLoading: boolean;
  /**
   * A platform tool a module lists only to keep its place in the tool list:
   * registered as the platform's, so it is offered whether or not that
   * module is on (WP3.3).
   */
  alwaysOffered?: true;
  /**
   * Where the tool may appear. Absent means `{ assistant: true, mcp: false }`:
   * nothing reaches an outside client unless its module opts in (Track M).
   */
  exposure?: { assistant?: boolean; mcp?: boolean };
  /** The shape of `output`; a zod object, required for every tool exposed to MCP. */
  outputSchema?: z.ZodType;
  /** The tool reads content outside Orbit's control (MCP `openWorldHint`). */
  openWorld?: true;
  /** Extra explicit OAuth consent required for sensitive module content. */
  mcpScopes?: readonly string[];
  /** Require an explicit MCP project argument even for a single-project grant. */
  mcpProjectRequired?: boolean;
  /** May execute under an explicitly enabled owner standing authorization. */
  mcpDirectEffect?: true;
  /**
   * For a proposal tool: whether an outside client may propose its action
   * now (the action type's `mcpProposable`). False hides it from MCP, so a
   * listed proposal never fails as not proposable.
   */
  mcpProposable?: () => boolean;
  execute(context: ToolContext, args: unknown): Promise<ToolResult>;
};

// The function API accepts [a-zA-Z0-9_-]{1,64}; Orbit uses lower snake case.
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

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

// Keywords strict mode accepts (OpenAI structured outputs, "Supported
// properties"); strings allow only pattern and format, so zod length limits
// and defaults must stay in the server-side validation.
const STRICT_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "pattern",
  "format",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "minItems",
  "maxItems",
]);

function assertStrictKeywords(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      assertStrictKeywords(item, `${path}/${index}`),
    );
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (!STRICT_KEYWORDS.has(key))
      throw new Error(`TOOL_SCHEMA_KEYWORD_UNSUPPORTED:${path}/${key}`);
    if (key === "properties")
      for (const [name, child] of Object.entries(value as object))
        assertStrictKeywords(child, `${path}/properties/${name}`);
    else if (key === "items" || key === "anyOf")
      assertStrictKeywords(value, `${path}/${key}`);
  }
}

/** Offered by Orbit Chat unless the tool opts out (`exposure.assistant: false`). */
export const exposedToAssistant = (tool: OrbitTool) =>
  tool.exposure?.assistant !== false;

/**
 * Exposed to MCP clients only when the tool opts in and declares an object
 * output schema (MCP `outputSchema` and `structuredContent` are objects).
 */
export const exposedToMcp = (tool: OrbitTool) =>
  tool.exposure?.mcp === true && tool.outputSchema instanceof z.ZodObject;

/**
 * Whether a proposal tool's MCP output reports what the gateway's quotas
 * rely on (D-M5-8): a required boolean `deduplicated` (a retry that returned
 * an existing proposal is neither charged nor recorded) and the string
 * `actionRequestId` the gateway records with `mcp.proposal`.
 */
const proposalOutputComplete = (schema: z.ZodObject) => {
  const { deduplicated, actionRequestId } = schema.shape;
  return (
    deduplicated instanceof z.ZodBoolean &&
    actionRequestId instanceof z.ZodString
  );
};

/** Registration error codes for a tool that may not be exposed to MCP. */
export type McpExposureCode =
  | "TOOL_OUTPUT_SCHEMA_REQUIRED"
  | "TOOL_OUTPUT_SCHEMA_NOT_OBJECT"
  | "TOOL_PROPOSAL_OUTPUT_INVALID";

/**
 * A tool that opts into MCP without an output schema, or with one that is
 * not a zod object, or a proposal tool whose output does not report
 * `deduplicated` and `actionRequestId`, is a registration error naming the
 * tool. Each problem carries its own code, so `defineTool` never infers it.
 */
export const mcpExposureIssue = (
  tool: OrbitTool,
): { code: McpExposureCode; message: string } | undefined => {
  if (tool.exposure?.mcp !== true) return undefined;
  if (tool.outputSchema === undefined)
    return {
      code: "TOOL_OUTPUT_SCHEMA_REQUIRED",
      message: `tool ${tool.name} is exposed to MCP without an output schema`,
    };
  if (!(tool.outputSchema instanceof z.ZodObject))
    return {
      code: "TOOL_OUTPUT_SCHEMA_NOT_OBJECT",
      message: `tool ${tool.name} is exposed to MCP with an output schema that is not an object`,
    };
  if (tool.risk === "P_proposal" && !proposalOutputComplete(tool.outputSchema))
    return {
      code: "TOOL_PROPOSAL_OUTPUT_INVALID",
      message: `tool ${tool.name} is a proposal tool exposed to MCP whose output schema lacks a required boolean deduplicated or a string actionRequestId`,
    };
  return undefined;
};

/** The message of `mcpExposureIssue`, for registration problem lists. */
export const mcpExposureProblem = (tool: OrbitTool) =>
  mcpExposureIssue(tool)?.message;

/** Validates a tool at import time, so a bad schema never reaches a paid call. */
export function defineTool(tool: OrbitTool): OrbitTool {
  if (!TOOL_NAME.test(tool.name)) throw new Error("TOOL_NAME_INVALID");
  const exposure = mcpExposureIssue(tool);
  if (exposure) throw new Error(`${exposure.code}:${tool.name}`);
  assertStrictKeywords(responsesTool(tool).parameters, "parameters");
  return tool;
}

export function availableTools(
  registry: readonly OrbitTool[],
  role: ToolRole,
  features: readonly ToolFeature[] = [],
): OrbitTool[] {
  return registry.filter(
    (tool) =>
      can({ role }, tool.permission) &&
      (!tool.feature || features.includes(tool.feature)),
  );
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
/** Tool search runs in Orbit (ADR 0007); the Responses API supports it from gpt-5.4. */
export function supportsToolSearch(model: string) {
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(model);
  if (!version) return false;
  const major = Number(version[1]);
  return major > 5 || (major === 5 && Number(version[2] ?? 0) >= 4);
}

// Client-executed: Orbit answers every search with tools this run may use.
export const TOOL_SEARCH = {
  type: "tool_search",
  execution: "client",
  description:
    "Load more Orbit tools when the loaded ones do not fit: slots and scheduling, content history, revisions, assets, analytics.",
  parameters: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description:
          "What you need to do next, or the exact names of every tool to load",
      },
    },
    required: ["goal"],
    additionalProperties: false,
  },
} as const;

/** A found tool as the model loads it: the strict definition, marked deferred. */
export function deferredDefinition(tool: OrbitTool) {
  return { ...responsesTool(tool), defer_loading: true };
}

/**
 * Deterministic search over the deferred tools a run may use. A tool the goal
 * names exactly always loads, so one search can load a whole flow (each search
 * costs a model call of the turn). Otherwise goal words found in a tool's
 * name, namespace or description: at most three tools with at least half the
 * best score, or every candidate when nothing matches.
 */
export function searchTools(candidates: readonly OrbitTool[], goal: string) {
  const tokens = new Set(goal.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const named = candidates.filter((tool) => tokens.has(tool.name));
  if (named.length) return named;
  const words = [
    ...new Set(goal.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  ];
  const scored = candidates.map((tool) => {
    const text =
      `${tool.name} ${tool.namespace} ${tool.description}`.toLowerCase();
    return { tool, score: words.filter((word) => text.includes(word)).length };
  });
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  if (best === 0) return [...candidates];
  return scored
    .filter((entry) => entry.score >= Math.max(1, Math.ceil(best / 2)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.tool);
}

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

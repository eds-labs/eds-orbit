/**
 * Registry adapter of the MCP gateway (Track M, WP-M2,
 * plans/orbit-modularization/09 §5.1): builds the per-request MCP server for
 * a principal from the native tools and the registry tools it may use, and
 * runs calls through the same `OrbitTool.execute` the assistant uses. It
 * holds no business logic: permissions come from visibility.ts, execution
 * from the tools themselves.
 *
 * Tool handlers never throw: the SDK would send a thrown message to the
 * client. Every outcome is a result built here or in errors.ts.
 */
import type { FastifyBaseLogger } from "fastify";
import {
  McpServer,
  Server,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  OrbitTool,
  ToolRisk,
} from "../../modules/agents/tools/registry.ts";
import { registeredToolOwner } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import {
  codeResult,
  internalFailure,
  toolFailure,
  unauthenticatedResult,
} from "./errors.ts";
import { nativeTools } from "./native-tools.ts";
import type { McpPrincipal } from "./principal.ts";
import {
  authorizeMcpCall,
  requiredScope,
  visibleMcpTools,
} from "./visibility.ts";

export const MCP_SERVER_INFO = { name: "orbit-mcp-gateway", version: "1.0.0" };
/** Largest JSON result a tool may return (09 §5.1, ADR 0007 §2). */
export const MCP_OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Cheap bound on argument size the SDK checks before validation. */
const MAX_TOOL_INPUT_ELEMENTS = 1000;
/** The argument the adapter adds to every project-bound tool. */
const PROJECT_ID = "projectId";

/**
 * One finished tools/call, for audit, telemetry and rate limits (Task 4).
 * `args` is the raw argument object: hash it, never store or log it.
 */
export type McpCallRecord = {
  requestId: string;
  tool: string;
  /** The token's subject: set even when the grant is gone. */
  userId: string;
  clientId: string;
  grantId: string | null;
  workspaceId: string | null;
  /** The project of the call when it is one of the grant's; otherwise null. */
  projectId: string | null;
  /** "ok" or the error code of the result ("INVALID_PARAMS" when the SDK refused it). */
  outcome: string;
  durationMs: number;
  args: unknown;
  clientIp: string;
};
/** The single hook point for Task 4; failures are logged and never change the result. */
export type McpCallObserver = (record: McpCallRecord) => void | Promise<void>;

/** What the factory knows about one HTTP request (set by server.ts). */
export type McpRequestState = {
  requestId: string;
  /** The token's subject. */
  userId: string;
  /** When the HTTP request arrived (ms). */
  startedAt: number;
  clientId: string;
  clientIp: string;
  /** Null when the token verifies but no active grant matches it any more. */
  principal: McpPrincipal | null;
  /** JSON-RPC method and tool name of the request, when readable. */
  method?: string;
  toolName?: string;
  /** The raw arguments of a tools/call: for the argument hash only. */
  args?: unknown;
  resource: string;
  log: FastifyBaseLogger;
  observe?: McpCallObserver;
};

/**
 * The MCP name of a registry tool: `<owner>_<name>`, unless the name already
 * starts with the owner prefix or the tool is the platform's.
 */
export function mcpToolName(tool: Pick<OrbitTool, "name">): string {
  const owner = registeredToolOwner(tool.name);
  if (!owner || owner === "platform" || tool.name.startsWith(`${owner}_`))
    return tool.name;
  return `${owner}_${tool.name}`;
}

/** MCP annotations per registry risk (09 §5.1). */
export function toolAnnotations(
  risk: ToolRisk,
  openWorld: boolean,
): ToolAnnotations {
  const byRisk: Record<ToolRisk, ToolAnnotations> = {
    R0_read: { readOnlyHint: true },
    P_proposal: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    W0_internal: { readOnlyHint: false, destructiveHint: false },
  };
  return { ...byRisk[risk], openWorldHint: openWorld };
}

/** The tool's parameters plus `projectId`, strict; optional with a single project. */
function inputSchemaFor(tool: OrbitTool, singleProject: boolean) {
  const projectId = z.uuid();
  return z.strictObject({
    ...tool.parameters.shape,
    [PROJECT_ID]: singleProject ? projectId.optional() : projectId,
  });
}

/**
 * The registry tools the principal may use in at least one of its projects.
 * Each call is checked again for its own project (authorizeMcpCall). A tool
 * that declares its own `projectId` parameter cannot be adapted and is left out.
 */
async function registryToolsFor(principal: McpPrincipal): Promise<OrbitTool[]> {
  const byName = new Map<string, OrbitTool>();
  for (const projectId of principal.projectIds) {
    const tools = await visibleMcpTools(principal, projectId).catch(
      (error: unknown) => {
        // Membership lost since the principal was resolved.
        if (error instanceof DomainError && error.code === "NOT_FOUND")
          return [];
        throw error;
      },
    );
    for (const tool of tools) byName.set(tool.name, tool);
  }
  return [...byName.values()].filter(
    (tool) => !(PROJECT_ID in tool.parameters.shape),
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Runs one call and maps every outcome to a result: output parsed with the
 * tool's output schema (only the parsed value is sent), capped at 64 KB;
 * errors through errors.ts. Then hands the record to the observer.
 */
async function runCall(
  state: McpRequestState,
  tool: string,
  args: unknown,
  outputSchema: z.ZodType,
  work: (call: { projectId: string | null }) => Promise<unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const call = { projectId: null as string | null };
  let result: CallToolResult;
  let outcome = "ok";
  try {
    const parsed = outputSchema.safeParse(await work(call));
    if (!parsed.success || !isPlainObject(parsed.data)) {
      outcome = "REQUEST_FAILED";
      state.log.error(
        { code: "MCP_OUTPUT_INVALID", tool, requestId: state.requestId },
        "mcp tool output failed its schema",
      );
      result = internalFailure(state.requestId);
    } else {
      const text = JSON.stringify(parsed.data);
      if (Buffer.byteLength(text, "utf8") > MCP_OUTPUT_LIMIT_BYTES) {
        outcome = "OUTPUT_TOO_LARGE";
        result = codeResult(outcome);
      } else
        result = {
          structuredContent: parsed.data,
          content: [{ type: "text", text }],
        };
    }
  } catch (error) {
    const failure = toolFailure(error, state.requestId);
    outcome = failure.code;
    result = failure.result;
    // Code only, as in the API: messages may carry user data.
    if (outcome === "REQUEST_FAILED")
      state.log.error(
        {
          code: outcome,
          tool,
          requestId: state.requestId,
          errorName: (error as Error)?.name,
        },
        "mcp tool call failed",
      );
  }
  await notify(state, {
    tool,
    projectId: call.projectId,
    outcome,
    durationMs: Date.now() - started,
    args,
  });
  return result;
}

async function notify(
  state: McpRequestState,
  record: Pick<
    McpCallRecord,
    "tool" | "projectId" | "outcome" | "durationMs" | "args"
  >,
) {
  if (!state.observe) return;
  try {
    await state.observe({
      ...record,
      requestId: state.requestId,
      userId: state.userId,
      clientId: state.clientId,
      grantId: state.principal?.grantId ?? null,
      workspaceId: state.principal?.workspaceId ?? null,
      clientIp: state.clientIp,
    });
  } catch (error) {
    state.log.warn(
      { code: "MCP_OBSERVER_FAILED", errorName: (error as Error)?.name },
      "mcp call observer failed",
    );
  }
}

/** Runs a registry tool for the principal in the requested (or only) project. */
async function executeRegistryTool(
  state: McpRequestState & { principal: McpPrincipal },
  tool: OrbitTool,
  args: Record<string, unknown>,
  call: { projectId: string | null },
): Promise<unknown> {
  const { principal, requestId } = state;
  const { [PROJECT_ID]: requested, ...rest } = args;
  const projectId =
    typeof requested === "string"
      ? requested
      : principal.projectIds.length === 1
        ? principal.projectIds[0]!
        : undefined;
  if (!projectId) throw new DomainError("PROJECT_REQUIRED", 400);
  // Audit rows go to the project only when it is one of the grant's.
  call.projectId = principal.projectIds.includes(projectId) ? projectId : null;
  const { tool: allowed, scope } = await authorizeMcpCall(
    principal,
    tool.name,
    projectId,
  );
  // Object-level rules of the tool's own schema apply too.
  const input = allowed.parameters.parse(rest);
  const { output } = await allowed.execute(
    {
      // The tool runs with the member's role in its module (as chat-runner).
      scope: moduleScope(scope, registeredToolOwner(allowed.name)),
      runId: requestId,
      conversationId: `mcp:${requestId}`,
      callIndex: 0,
      channel: {
        kind: "mcp",
        clientId: principal.clientId,
        grantId: principal.grantId,
        requestId,
      },
    },
    input,
  );
  // Chat cards are never sent over MCP (Orbit links follow in WP-M3).
  return output;
}

/** For a token whose grant is gone: every tools/call answers with the challenge. */
function unauthenticatedServer(state: McpRequestState): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
  });
  server.setRequestHandler("tools/call", async (request) => {
    await notify(state, {
      tool: String(request.params.name).slice(0, 128),
      projectId: null,
      outcome: "UNAUTHENTICATED",
      durationMs: Date.now() - state.startedAt,
      args: request.params.arguments,
    });
    return unauthenticatedResult(state.resource);
  });
  return server;
}

/**
 * The project a call that never reached its tool belongs to: the requested
 * one if it is the grant's, the only one when none was named, else none.
 */
function projectOfRefusedCall(
  principal: McpPrincipal,
  args: unknown,
): string | null {
  const requested = isPlainObject(args) ? args[PROJECT_ID] : undefined;
  if (typeof requested === "string")
    return principal.projectIds.includes(requested) ? requested : null;
  return principal.projectIds.length === 1 ? principal.projectIds[0]! : null;
}

type ToolDefinition = {
  name: string;
  description: string;
  risk: ToolRisk;
  openWorld: boolean;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodType;
  run: (
    args: Record<string, unknown>,
    call: { projectId: string | null },
  ) => Promise<unknown>;
};

/**
 * The MCP server for one request. Tools are computed only for tools/list
 * (all the principal may use) and tools/call (the named one); other methods
 * see the tool capability without a database read.
 */
export async function mcpServerFor(
  state: McpRequestState | undefined,
): Promise<McpServer | Server> {
  if (!state) throw new Error("MCP_REQUEST_STATE_MISSING");
  if (!state.principal) return unauthenticatedServer(state);
  const principalState = { ...state, principal: state.principal };
  const { principal } = principalState;
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
  });
  if (state.method !== "tools/list" && state.method !== "tools/call")
    return server;
  const wanted = (name: string) =>
    state.method === "tools/list" || name === state.toolName;

  const definitions = new Map<string, ToolDefinition>();
  for (const native of nativeTools)
    if (wanted(native.name) && principal.scopes.has(requiredScope(native)))
      definitions.set(native.name, {
        name: native.name,
        description: native.description,
        risk: native.risk,
        openWorld: false,
        inputSchema: native.inputSchema,
        outputSchema: native.outputSchema,
        run: () => native.run(principal),
      });
  const single = principal.projectIds.length === 1;
  for (const tool of await registryToolsFor(principal)) {
    const name = mcpToolName(tool);
    if (!wanted(name)) continue;
    if (definitions.has(name)) {
      state.log.warn({ tool: name }, "mcp tool name taken; tool left out");
      continue;
    }
    definitions.set(name, {
      name,
      description: tool.description,
      risk: tool.risk,
      openWorld: tool.openWorld === true,
      inputSchema: inputSchemaFor(tool, single),
      outputSchema: tool.outputSchema!,
      run: (args, call) =>
        executeRegistryTool(principalState, tool, args, call),
    });
  }

  // A call the SDK will refuse (unknown or unlisted tool, arguments that do
  // not fit the input schema) never reaches a handler, so it is reported here.
  if (state.method === "tools/call") {
    const definition = definitions.get(state.toolName ?? "");
    if (
      !definition ||
      !definition.inputSchema.safeParse(state.args ?? {}).success
    )
      await notify(principalState, {
        tool: String(state.toolName ?? "").slice(0, 128),
        projectId: projectOfRefusedCall(principal, state.args),
        outcome: "INVALID_PARAMS",
        durationMs: Date.now() - state.startedAt,
        args: state.args,
      });
  }

  // Name order, so clients can cache the list (09 §5.1).
  for (const definition of [...definitions.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  ))
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema as z.ZodObject,
        annotations: toolAnnotations(definition.risk, definition.openWorld),
        _meta: {
          securitySchemes: [
            { type: "oauth2", scopes: [requiredScope(definition)] },
          ],
        },
      },
      async (args: Record<string, unknown>) =>
        runCall(
          principalState,
          definition.name,
          args,
          definition.outputSchema,
          (call) => definition.run(args, call),
        ),
    );
  return server;
}

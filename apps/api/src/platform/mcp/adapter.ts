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
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  McpServer,
  Server,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  mcpExposureProblem,
  TOOL_NAME,
  type OrbitTool,
  type ToolRisk,
} from "../../modules/agents/tools/registry.ts";
import {
  registeredToolOwner,
  registeredTools,
} from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import {
  codeResult,
  internalFailure,
  McpToolTimeoutError,
  toolFailure,
  unauthenticatedResult,
} from "./errors.ts";
import { MCP_OUTPUT_LIMIT_BYTES, type McpProjectSlots } from "./limits.ts";
import { nativeTools, type NativeToolContext } from "./native-tools.ts";
import type { McpPrincipal } from "./principal.ts";
import {
  recordableId,
  recordMcpProposal,
  reserveProposal,
  type ProposalQuota,
  type ProposalQuotaKey,
  type ProposalReservation,
} from "./proposals.ts";
import {
  authorizeMcpCall,
  requiredScope,
  visibleMcpTools,
} from "./visibility.ts";

export const MCP_SERVER_INFO = { name: "orbit-mcp-gateway", version: "1.0.0" };
/** Largest JSON result a tool may return (limits.ts). */
export { MCP_OUTPUT_LIMIT_BYTES };
/** Cheap bound on argument size the SDK checks before validation. */
export const MAX_TOOL_INPUT_ELEMENTS = 1000;
/** How long a tool call may take before the client gets TIMEOUT (D-M3-11). */
export const MCP_TOOL_TIMEOUT_MS = 25_000;
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
  /** The `mcp` AgentRun started before the tool ran; null when none was (refused call, no project). */
  agentRunId: string | null;
  /** "ok" or the error code of the result ("INVALID_PARAMS" when the SDK refused it). */
  outcome: string;
  durationMs: number;
  args: unknown;
  clientIp: string;
};
/** The single hook point for Task 4; failures are logged and never change the result. */
export type McpCallObserver = (record: McpCallRecord) => void | Promise<void>;

/**
 * Starts the `mcp` AgentRun of a project call (audit.ts). Null when it cannot
 * be created: telemetry is best effort and never changes a result.
 */
export type McpRunStarter = (
  project: { workspaceId: string; projectId: string },
  call: { tool: string; clientId: string; grantId: string | null },
) => Promise<string | null>;

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
  /** Starts the call's AgentRun before the tool runs (absent: no runs). */
  startRun?: McpRunStarter;
  /** Overrides MCP_TOOL_TIMEOUT_MS (tests). */
  toolTimeoutMs?: number;
  /** The proposal quotas (limits.ts, D-M4-8; per user, client and workspace, D-M5-8). */
  proposalQuota: ProposalQuota;
  /** The process's per-project execution slots (limits.ts, R-10). */
  projectSlots: McpProjectSlots;
};

/** What one call tells the observer about itself while it runs. */
type CallTrace = {
  /** Unique per call, even if one HTTP request ever carried several. */
  id: string;
  projectId: string | null;
  agentRunId: string | null;
  /** The run being started (shared by concurrent `startRun` calls). */
  runStart: Promise<string | null> | null;
  /** The call has been answered (finished or timed out): its attribution is closed. */
  settled: boolean;
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

/** What audit rows, call logs and spans carry for a tool name Orbit does not know. */
export const MCP_UNKNOWN_TOOL = "<unknown>";

/**
 * The tool name a refused call may be recorded under: the client-supplied
 * name only when it matches the registry's name pattern and names a native
 * tool or a registered tool (by its MCP name); otherwise MCP_UNKNOWN_TOOL.
 * Client-controlled text never reaches an audit row, a span or a run.
 */
export function auditableToolName(name: unknown): string {
  if (typeof name !== "string" || !TOOL_NAME.test(name))
    return MCP_UNKNOWN_TOOL;
  if (nativeTools.some((tool) => tool.name === name)) return name;
  try {
    return registeredTools().some((tool) => mcpToolName(tool) === name)
      ? name
      : MCP_UNKNOWN_TOOL;
  } catch {
    // No registration (cannot happen in mcp-main.ts): know nothing, never throw.
    return MCP_UNKNOWN_TOOL;
  }
}

/**
 * Refuses to start the gateway with a tool whose MCP contract is broken
 * (D-M5-8): every exposed tool needs an object output schema, and every
 * exposed proposal tool must report `deduplicated` and `actionRequestId`,
 * which the quotas and `mcp.proposal` rely on. Module registration is the
 * authoritative check: it applies `mcpExposureProblem` to every registered
 * tool, also those of modules unavailable at startup. This repeats it over
 * the tools the gateway can serve (`registeredTools()`), as a guard at
 * gateway start.
 */
export function assertMcpToolContracts(tools: readonly OrbitTool[]): void {
  const problems = tools
    .map((tool) => mcpExposureProblem(tool))
    .filter((problem): problem is string => problem !== undefined);
  if (problems.length)
    throw new Error(`MCP_TOOL_CONTRACT_INVALID: ${problems.join("; ")}`);
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
 * Array items and object keys in `value`, counted until `max` is passed: the
 * same count as the SDK's `maxToolInputElements` check (McpServer
 * validateToolInput, SDK 2.3.1), which the SDK does not export.
 */
function toolInputElementCount(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    const children = Array.isArray(node)
      ? node
      : Object.keys(node).map((key) => (node as Record<string, unknown>)[key]);
    for (const child of children) {
      if (++count > max) return count;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return count;
}

/**
 * Whether the SDK will accept `args` for a tool with `schema` (D-M5-6): the
 * element cap first, then the schema with missing arguments as `{}`,
 * asynchronously as the SDK validates (async refinements run). A schema that
 * throws counts as a refusal, as the SDK answers it with an error result.
 */
export async function sdkAcceptsArguments(
  schema: z.ZodType,
  args: unknown,
): Promise<boolean> {
  if (
    toolInputElementCount(args, MAX_TOOL_INPUT_ELEMENTS) >
    MAX_TOOL_INPUT_ELEMENTS
  )
    return false;
  try {
    return (await schema.safeParseAsync(args ?? {})).success;
  } catch {
    return false;
  }
}

/**
 * Runs one call and maps every outcome to a result: output parsed with the
 * tool's output schema (only the parsed value is sent), capped at 64 KB;
 * errors through errors.ts. Then hands the record to the observer.
 */
async function runCall(
  state: McpRequestState,
  tool: string,
  risk: ToolRisk,
  args: unknown,
  outputSchema: z.ZodType,
  work: (call: CallTrace) => Promise<unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const call: CallTrace = {
    id: randomUUID(),
    projectId: null,
    agentRunId: null,
    runStart: null,
    settled: false,
  };
  let result: CallToolResult;
  let outcome = "ok";
  try {
    const parsed = outputSchema.safeParse(
      await withToolTimeout(
        work(call),
        state.toolTimeoutMs ?? MCP_TOOL_TIMEOUT_MS,
      ),
    );
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
    const failure = toolFailure(error, state.requestId, risk);
    outcome = failure.code;
    result = failure.result;
    if (outcome === "TIMEOUT")
      state.log.warn(
        { code: "MCP_TOOL_TIMEOUT", tool, requestId: state.requestId },
        "mcp tool call timed out",
      );
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
  // The call's attribution is closed first, so no run can start after this
  // point; a run still being created is awaited (it never rejects), so the
  // record names it.
  const pending = call.runStart;
  call.settled = true;
  await pending;
  await notify(state, {
    tool,
    projectId: call.projectId,
    agentRunId: call.agentRunId,
    outcome,
    durationMs: Date.now() - started,
    args,
  });
  return result;
}

/**
 * Waits for `work`, but at most `ms`: then it rejects with a timeout error.
 * The work itself cannot be cancelled and may still finish; its late result
 * or failure is dropped.
 */
export function withToolTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpToolTimeoutError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Attributes the call to a project, but only one of the grant's: audit rows
 * and runs go to a project only then. The first attribution wins: a call has
 * one audit project and at most one run, so a later, different project (or
 * any attribution after the call was answered, for example by a tool that
 * outlived its timeout) is ignored. Returns whether the call is attributed
 * to `projectId` afterwards.
 */
function attributeCall(
  principal: McpPrincipal,
  call: CallTrace,
  projectId: string,
): boolean {
  if (call.settled || !principal.projectIds.includes(projectId)) return false;
  if (call.projectId !== null) return call.projectId === projectId;
  call.projectId = projectId;
  return true;
}

/**
 * Starts the call's AgentRun in its project before the tool does any work, so
 * the tool can hand the run id on (`ToolContext.runId`). One run per call:
 * again for the same project it returns that run's id, for a different
 * project (see attributeCall) null. Also null when the project is not the
 * grant's or the run cannot be created.
 */
async function startCallRun(
  state: McpRequestState & { principal: McpPrincipal },
  call: CallTrace,
  tool: string,
  projectId: string,
): Promise<string | null> {
  const { principal } = state;
  if (!attributeCall(principal, call, projectId)) return null;
  call.runStart ??= (async () => {
    try {
      call.agentRunId =
        (await state.startRun?.(
          { workspaceId: principal.workspaceId, projectId },
          { tool, clientId: principal.clientId, grantId: principal.grantId },
        )) ?? null;
    } catch {
      // Best effort: the run id then falls back to the request id.
      call.agentRunId = null;
    }
    return call.agentRunId;
  })();
  return call.runStart;
}

/** The context a native tool receives for one call. */
function nativeContext(
  state: McpRequestState & { principal: McpPrincipal },
  tool: string,
  call: CallTrace,
): NativeToolContext {
  const { principal } = state;
  return {
    requestId: state.requestId,
    callId: call.id,
    clientId: principal.clientId,
    grantId: principal.grantId,
    get agentRunId() {
      return call.agentRunId;
    },
    setAuditProject: (projectId) =>
      void attributeCall(principal, call, projectId),
    startRun: (projectId) => startCallRun(state, call, tool, projectId),
    withProjectSlot: (projectId, work, options) =>
      state.projectSlots.run(projectId, work, options),
    projectSlotDeadline: () => state.projectSlots.deadline(),
    log: state.log,
  };
}

async function notify(
  state: McpRequestState,
  record: Pick<
    McpCallRecord,
    "tool" | "projectId" | "outcome" | "durationMs" | "args"
  > & { agentRunId?: string | null },
) {
  if (!state.observe) return;
  try {
    await state.observe({
      ...record,
      agentRunId: record.agentRunId ?? null,
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
  call: CallTrace,
  toolName: string,
): Promise<unknown> {
  const { principal } = state;
  const { [PROJECT_ID]: requested, ...rest } = args;
  const projectId =
    typeof requested === "string"
      ? requested
      : principal.projectIds.length === 1
        ? principal.projectIds[0]!
        : undefined;
  if (!projectId) throw new DomainError("PROJECT_REQUIRED", 400);
  // Audit rows go to the project only when it is one of the grant's.
  attributeCall(principal, call, projectId);
  // Authorization, the run and the execution all read the project (each
  // `scoped()` call locks it): one of its slots holds them (R-10). A BUSY
  // call starts no run.
  return state.projectSlots.run(projectId, () =>
    executeInProject(state, tool, rest, call, toolName, projectId),
  );
}

/** executeRegistryTool's work inside the project's slot. */
async function executeInProject(
  state: McpRequestState & { principal: McpPrincipal },
  tool: OrbitTool,
  rest: Record<string, unknown>,
  call: CallTrace,
  toolName: string,
  projectId: string,
): Promise<unknown> {
  const { principal, requestId } = state;
  const { tool: allowed, scope } = await authorizeMcpCall(
    principal,
    tool.name,
    projectId,
  );
  // Object-level rules of the tool's own schema apply too; asynchronously,
  // so async refinements run instead of throwing.
  const input = await allowed.parameters.parseAsync(rest);
  // A proposal tool runs only inside the quotas of the user, client and
  // workspace (D-M4-8, D-M5-8): a re-selection, a new grant id, keeps them.
  const proposing = allowed.risk === "P_proposal";
  const quotaKey: ProposalQuotaKey = {
    userId: principal.userId,
    clientId: principal.clientId,
    workspaceId: principal.workspaceId,
  };
  // The hourly place is taken before the tool runs (review M4); a call
  // that creates nothing gives it back.
  const reservation = proposing
    ? await reserveProposal(state.proposalQuota, quotaKey)
    : null;
  // The run exists before the tool works, so its spans and costs can hang on
  // it; without one the request id stands in, as before (it never rejects).
  const agentRunId = await startCallRun(state, call, toolName, projectId);
  let output: unknown;
  try {
    ({ output } = await allowed.execute(
      {
        // The tool runs with the member's role in its module (as chat-runner).
        scope: moduleScope(scope, registeredToolOwner(allowed.name)),
        runId: agentRunId ?? requestId,
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
    ));
  } catch (error) {
    // A thrown call created nothing it reports: its hourly place goes back.
    reservation?.release();
    throw error;
  }
  if (reservation)
    await settleProposal(state, toolName, quotaKey, reservation, output);
  // Chat cards are never sent over MCP (Orbit links follow in WP-M3).
  return output;
}

/**
 * Settles a proposal call centrally for every proposal tool (D-M5-8): a tool
 * that reports a deduplicated retry (`deduplicated: true`) gives its hourly
 * place back and writes nothing; any other result keeps the place and is
 * recorded (`mcp.proposal`), so no proposal tool can dodge the quota
 * (registration also requires the field). Runs after the tool's own
 * transaction committed, also when the call has timed out meanwhile, so a
 * late creation still counts. A failed event write is logged with the
 * identifiers to reconcile it and leaves the result alone: the proposal
 * exists, and the daily count is one short (the hourly place is kept).
 */
async function settleProposal(
  state: McpRequestState & { principal: McpPrincipal },
  toolName: string,
  key: ProposalQuotaKey,
  reservation: ProposalReservation,
  output: unknown,
): Promise<void> {
  if (isPlainObject(output) && output.deduplicated === true) {
    reservation.release();
    return;
  }
  const actionRequestId = recordableId(
    isPlainObject(output) ? output.actionRequestId : null,
  );
  try {
    await recordMcpProposal({
      ...key,
      grantId: state.principal.grantId,
      tool: toolName,
      actionRequestId,
    });
  } catch (error) {
    state.log.error(
      {
        code: "MCP_PROPOSAL_RECORD_FAILED",
        tool: toolName,
        requestId: state.requestId,
        actionRequestId,
        clientId: key.clientId,
        workspaceId: key.workspaceId,
        errorName: (error as Error)?.name,
      },
      "mcp proposal event not recorded",
    );
  }
}

/** For a token whose grant is gone: every tools/call answers with the challenge. */
function unauthenticatedServer(state: McpRequestState): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
  });
  server.setRequestHandler("tools/call", async (request) => {
    await notify(state, {
      tool: auditableToolName(request.params.name),
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
  outputSchema: z.ZodObject;
  meta?: Record<string, unknown>;
  run: (args: Record<string, unknown>, call: CallTrace) => Promise<unknown>;
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
        ...(native.meta ? { meta: native.meta } : {}),
        run: (args, call) =>
          native.run(
            principal,
            args,
            nativeContext(principalState, native.name, call),
          ),
      });
  const single = principal.projectIds.length === 1;
  for (const tool of await registryToolsFor(principal)) {
    const name = mcpToolName(tool);
    if (!wanted(name)) continue;
    // Registration refuses other shapes (mcpExposureProblem); never cast.
    const { outputSchema } = tool;
    if (!(outputSchema instanceof z.ZodObject)) continue;
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
      outputSchema,
      run: (args, call) =>
        executeRegistryTool(principalState, tool, args, call, name),
    });
  }

  // A call the SDK will refuse (unknown or unlisted tool, arguments that do
  // not fit the input schema) never reaches a handler, so it is reported here.
  if (state.method === "tools/call") {
    const definition = definitions.get(state.toolName ?? "");
    if (
      !definition ||
      !(await sdkAcceptsArguments(definition.inputSchema, state.args))
    )
      await notify(principalState, {
        tool: auditableToolName(state.toolName),
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
        outputSchema: definition.outputSchema,
        annotations: toolAnnotations(definition.risk, definition.openWorld),
        _meta: {
          ...definition.meta,
          securitySchemes: [
            { type: "oauth2", scopes: [requiredScope(definition)] },
          ],
        },
      },
      async (args: Record<string, unknown>) =>
        runCall(
          principalState,
          definition.name,
          definition.risk,
          args,
          definition.outputSchema,
          (call) => definition.run(args, call),
        ),
    );
  return server;
}

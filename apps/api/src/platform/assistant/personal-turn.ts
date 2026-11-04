/**
 * The personal Orbit Assistant's turn host (ADR 0022 §4-6, plan
 * agent-platform-phase-3 §2.2-2.3, WP3.2/WP3.3): which tools a personal turn
 * starts with, how project tools are loaded in stages, and how each call is
 * executed in its target project with the cross-project taint.
 *
 * - A turn starts with the platform user tools (`personalUserTools`), the
 *   host's own `load_project_tools` and, with a focus project, at most six
 *   of its tools. This fixed list never changes within the turn.
 * - `load_project_tools(projectId, goal)` loads up to LOAD_LIMIT project
 *   tools for the rest of the turn. Loaded definitions are appended after
 *   the fixed list with the next model call (ModelRequest.loadedTools), the
 *   same way for OpenAI and Anthropic: nothing depends on the Responses
 *   API's client-executed `tool_search` items, which the Anthropic adapter
 *   cannot send. A project tool's definition carries the injected
 *   `projectId`; a call may only name a project the tool was loaded for.
 * - Every project tool call runs through the capability layer's
 *   `executePersonalProjectCall` in its target project. Every project whose
 *   data entered the turn is recorded (`contextProjects`); a proposal made
 *   in project B after data of A entered names A
 *   (`requestedBy.crossProjectContext`), so no mandate approves it.
 *
 * Project mode (`/p/:id/assistant`) does not use this module: its loading is
 * unchanged. WP3.4 wires `preparePersonalTurn` into the chat runner (mode by
 * project kind, instructions, page context) and persists `contextProjects`.
 */
import { ZodError, z } from "zod";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { hashText, recordSpan } from "../../modules/telemetry.ts";
import { crossProjectExecution } from "../agents/agent-execution.ts";
import {
  capToolOutput,
  personalUserTools,
} from "../agents/capabilities.ts";
import {
  assertPersonalEntitlement,
  executePersonalProjectCall,
  inProjectCall,
  isProjectRefusal,
  personalToolsPolicy,
  projectCapabilityState,
  projectMemberScope,
  ProjectCallRefused,
  PROJECT_ID_PARAM,
} from "../agents/project-calls.ts";
import {
  accessibleBusinessProjects,
  type ProjectRef,
} from "../agents/project-reads.ts";
import type { ToolHost } from "../agents/runtime/port.ts";
import {
  responsesTool,
  searchTools,
  type OrbitTool,
  type ToolResult,
} from "../agents/tools/registry.ts";
import { scoped } from "../../../../../packages/db/src/index.ts";
import { registeredTools } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import type { ChatCard } from "./cards.ts";
import {
  actionRequestCard,
  readActionRequest,
  type RunStep,
} from "./personal-mode.ts";

/** The host's own loading tool (plan §2.2): not a registry tool. */
export const LOAD_PROJECT_TOOLS = "load_project_tools";
/** Project tools one `load_project_tools` call loads at most. */
export const LOAD_LIMIT = 8;
/** Distinct project tool definitions a turn may carry at most (preload included). */
export const MAX_LOADED_TOOLS = 24;
/** Focus-project tools preloaded at most (plan T3-3). */
export const FOCUS_PRELOAD_LIMIT = 6;

/** The fixed definition of `load_project_tools`, the same for both providers. */
export const LOAD_PROJECT_TOOLS_DEFINITION = {
  type: "function" as const,
  name: LOAD_PROJECT_TOOLS,
  description:
    "Load the tools of one project for the rest of this turn, before calling them: name the project (an id from projects_list) and what you need to do there. Returns the names of the loaded tools; call them with that projectId.",
  strict: true as const,
  parameters: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project's id from projects_list",
      },
      goal: {
        type: "string",
        description:
          "What you need to do in the project, or the exact names of the tools to load",
      },
    },
    required: ["projectId", "goal"],
    additionalProperties: false,
  },
};

/**
 * A project tool's definition in personal mode: its own strict parameters
 * plus the injected `projectId` (last), so every call names its project.
 */
export function projectToolDefinition(tool: OrbitTool) {
  return responsesTool({
    ...tool,
    parameters: tool.parameters.extend({
      [PROJECT_ID_PARAM]: z
        .string()
        .describe("The project this call acts in; one the tool was loaded for"),
    }),
  });
}

/** Bytes of one model request as the chat runner counts them (CHAT_MAX_INPUT_BYTES). */
export function requestBytes(request: {
  input: unknown[];
  instructions: string;
  tools: unknown[];
}) {
  return Buffer.byteLength(
    JSON.stringify({
      input: request.input,
      instructions: request.instructions,
      tools: request.tools,
    }),
  );
}

/** The project list of the personal-mode instructions: names and ids only. */
export function projectListSection(
  projects: readonly ProjectRef[],
  options: { truncated?: boolean; focusProjectId?: string | null } = {},
) {
  const lines = projects.map(
    (project) =>
      `${project.id}: ${project.name}${project.id === options.focusProjectId ? " (focus)" : ""}`,
  );
  return [
    "Projects you may use (id: name):",
    ...lines,
    ...(options.truncated
      ? ["More projects exist; call projects_list to see them."]
      : []),
  ].join("\n");
}

export type PersonalTurnRequest = {
  mode: "personal";
  userId: string;
  workspaceId: string;
  /** A hint (page context or the panel's switch); dropped when not accessible. */
  focusProjectId?: string | null;
  /** The turn's run in the personal space: tool context and telemetry. */
  run: {
    runId: string;
    conversationId: string;
    /**
     * The member's scope in their personal space: the context of user tools
     * (which read each target project with the member's own scope there)
     * and where spans are recorded with `agentRunId`.
     */
    scope: Scope;
    agentRunId?: string | null;
  };
  /** Projects whose data entered earlier turns still in the conversation. */
  initialContextProjects?: readonly string[];
  /** The user's latest message: what `context_remember` may ground on. */
  userText?: string;
  /** Progress of each tool call, for the run's `steps[]` (best effort). */
  onStep?: (step: RunStep) => Promise<void>;
};

export type PersonalTurn = {
  /** The accessible business projects (at most 50), for the instructions. */
  projects: readonly ProjectRef[];
  truncated: boolean;
  /** The focus project when the user may reach it, else null. */
  focusProjectId: string | null;
  /** The fixed tool list of every model call in this turn. */
  staticTools: readonly unknown[];
  /** The fixed list plus the definitions loaded so far: the next call's tools. */
  tools(): unknown[];
  /** Executes calls and loads; `loadedTools` feeds the runtime. */
  host: ToolHost;
  /** Every project whose data entered the turn so far. */
  contextProjects(): string[];
  /**
   * Cards of the turn's tools in call order; a project tool's cards name
   * their project, and approval cards carry `actionRequest` (WP3.5).
   */
  cards: ChatCard[];
};

type TurnState = {
  request: PersonalTurnRequest;
  names: Map<string, string>;
  userTools: Map<string, OrbitTool>;
  /** Project tool name -> the projects it was loaded for. */
  loadedFor: Map<string, Set<string>>;
  /** Project tool names with a definition in the fixed list. */
  staticNames: Set<string>;
  /** Definitions appended during the turn, in loading order. */
  appended: unknown[];
  contextProjects: Set<string>;
  cards: ChatCard[];
};

/**
 * Prepares one personal turn for the user: the project list, the validated
 * focus, the fixed tool list (user tools, `load_project_tools`, the focus
 * preload) and the host that runs the turn's calls. Refuses
 * ASSISTANT_ENTITLEMENT when the organization may not use the assistant.
 */
export async function preparePersonalTurn(
  request: PersonalTurnRequest,
): Promise<PersonalTurn> {
  await assertPersonalEntitlement(request.workspaceId);
  if (
    request.run.scope.userId !== request.userId ||
    request.run.scope.workspaceId !== request.workspaceId
  )
    throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
  const { projects, truncated } = await accessibleBusinessProjects(
    request.workspaceId,
    request.userId,
  );
  const state: TurnState = {
    request,
    names: new Map(projects.map((project) => [project.id, project.name])),
    userTools: new Map(personalUserTools().map((tool) => [tool.name, tool])),
    loadedFor: new Map(),
    staticNames: new Set(),
    appended: [],
    contextProjects: new Set(request.initialContextProjects ?? []),
    cards: [],
  };
  const focusProjectId =
    request.focusProjectId && state.names.has(request.focusProjectId)
      ? request.focusProjectId
      : null;
  const preload = focusProjectId
    ? await focusPreload(state, focusProjectId)
    : [];
  for (const tool of preload) {
    state.loadedFor.set(tool.name, new Set([focusProjectId!]));
    state.staticNames.add(tool.name);
  }
  const staticTools = Object.freeze([
    ...[...state.userTools.values()].map(responsesTool),
    LOAD_PROJECT_TOOLS_DEFINITION,
    ...preload.map(projectToolDefinition),
  ]);
  return {
    projects,
    truncated,
    focusProjectId,
    staticTools,
    tools: () => [...staticTools, ...state.appended],
    host: turnHost(state),
    contextProjects: () => [...state.contextProjects],
    cards: state.cards,
  };
}

/**
 * The focus project's top tools, at most FOCUS_PRELOAD_LIMIT (plan T3-3):
 * the ones the member may use there, tools offered directly in project chat
 * (`deferLoading: false`) first, each group in registry (module) order.
 * Nothing for a paused or no longer accessible project.
 */
async function focusPreload(
  state: TurnState,
  projectId: string,
): Promise<OrbitTool[]> {
  const { workspaceId, userId } = state.request;
  try {
    const tools = await projectToolsFor(workspaceId, userId, projectId);
    return [
      ...tools.filter((tool) => !tool.deferLoading),
      ...tools.filter((tool) => tool.deferLoading),
    ].slice(0, FOCUS_PRELOAD_LIMIT);
  } catch (error) {
    if (isProjectRefusal(error)) return [];
    throw error;
  }
}

/** The project tools the member may load in the project now (refusals thrown). */
function projectToolsFor(
  workspaceId: string,
  userId: string,
  projectId: string,
): Promise<OrbitTool[]> {
  return inProjectCall(projectId, async () => {
    const scope = await projectMemberScope({
      workspaceId,
      userId,
      projectId,
      businessOnly: true,
    });
    const { tools, state } = await projectCapabilityState(
      scope,
      personalToolsPolicy(),
    );
    if (state.paused) throw new ProjectCallRefused("PROJECT_PAUSED");
    return tools;
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Model-supplied JSON arguments as an object; anything else is invalid input. */
function parseArguments(raw: unknown): Record<string, unknown> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new DomainError("TOOL_INPUT_INVALID");
    }
  }
  if (!isPlainObject(value)) throw new DomainError("TOOL_INPUT_INVALID");
  return value;
}

/** A refused or failed call as the model sees it: a code, never a message. */
function failureOutput(error: unknown, projectId?: string) {
  if (error instanceof ZodError)
    return {
      error: "TOOL_INPUT_INVALID",
      invalidFields: [
        ...new Set(
          error.issues.map(
            (issue) =>
              issue.path
                .filter(
                  (part): part is string =>
                    typeof part === "string" &&
                    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(part),
                )
                .slice(0, 2)
                .join(".") || "input",
          ),
        ),
      ].slice(0, 8),
    };
  const raw = error instanceof Error ? error.message : "";
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(raw) ? raw : "TOOL_FAILED";
  return projectId && isProjectRefusal(error)
    ? { projectId, error: code }
    : { error: code };
}

/** Reports one step to the request's `onStep`; a failing report never fails the call. */
async function reportStep(
  state: TurnState,
  name: string,
  projectId: string | undefined,
  value: RunStep["state"],
) {
  if (!state.request.onStep) return;
  const known =
    name === LOAD_PROJECT_TOOLS ||
    state.userTools.has(name) ||
    state.loadedFor.has(name);
  const project =
    projectId && state.names.has(projectId)
      ? { projectId, projectName: state.names.get(projectId)! }
      : {};
  try {
    await state.request.onStep({
      tool: known ? name : "unknown_tool",
      ...project,
      state: value,
    });
  } catch {
    // Progress is a display aid; the call goes on.
  }
}

function turnHost(state: TurnState): ToolHost {
  const { request } = state;
  const spanName = (name: string) =>
    name === LOAD_PROJECT_TOOLS ||
    state.userTools.has(name) ||
    registeredTools().some((tool) => tool.name === name)
      ? name
      : "unknown_tool";
  const record = async (
    name: string,
    raw: unknown,
    startedAt: Date,
    failure: string | null,
  ) => {
    const { scope, agentRunId } = request.run;
    if (!agentRunId) return;
    await recordSpan(scope, agentRunId, {
      type: "tool_call",
      name: spanName(name),
      status: failure ? "failed" : "succeeded",
      errorCode: failure ?? undefined,
      startedAt,
      durationMs: Date.now() - startedAt.valueOf(),
      inputHash: hashText(typeof raw === "string" ? raw : JSON.stringify(raw ?? null)),
    });
  };
  return {
    // Personal turns offer no client-executed tool search item: tools load
    // through `load_project_tools`, the same for both providers.
    async search() {
      return [];
    },
    loadedTools: () => [...state.appended],
    async execute(call, callIndex) {
      const startedAt = new Date();
      let output: unknown;
      let failure: string | null = null;
      let projectId: string | undefined;
      // Steps name only tools Orbit knows and projects the user may reach.
      const step = (value: RunStep["state"]) =>
        reportStep(state, call.name, projectId, value);
      try {
        const args = parseArguments(call.arguments);
        if (typeof args[PROJECT_ID_PARAM] === "string")
          projectId = args[PROJECT_ID_PARAM] as string;
        await step("started");
        if (call.name === LOAD_PROJECT_TOOLS) output = await load(state, args);
        else if (state.userTools.has(call.name))
          output = await runUserTool(state, state.userTools.get(call.name)!, args, callIndex);
        else if (state.loadedFor.has(call.name))
          output = await runProjectTool(state, call.name, args, callIndex);
        else throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
        if (isPlainObject(output) && typeof output.error === "string")
          failure = output.error;
      } catch (error) {
        output = failureOutput(error, projectId);
        failure = (output as { error: string }).error;
      }
      await step(failure ? "failed" : "finished");
      await record(call.name, call.arguments, startedAt, failure);
      return capToolOutput(output);
    },
  };
}

/** `load_project_tools`: loads up to LOAD_LIMIT tools of one project for the rest of the turn. */
async function load(state: TurnState, args: Record<string, unknown>) {
  const input = z
    .object({ projectId: z.string(), goal: z.string().max(2000) })
    .strict()
    .parse(args);
  const { workspaceId, userId } = state.request;
  let candidates: OrbitTool[];
  try {
    candidates = await projectToolsFor(workspaceId, userId, input.projectId);
  } catch (error) {
    if (isProjectRefusal(error))
      return { projectId: input.projectId, error: error.refusal };
    throw error;
  }
  const found = searchTools(candidates, input.goal, { limit: LOAD_LIMIT });
  const loaded: string[] = [];
  let limited = false;
  for (const tool of found) {
    const known = state.loadedFor.get(tool.name);
    if (!known) {
      if (state.staticNames.size + state.appended.length >= MAX_LOADED_TOOLS) {
        limited = true;
        continue;
      }
      state.appended.push(projectToolDefinition(tool));
      state.loadedFor.set(tool.name, new Set([input.projectId]));
    } else known.add(input.projectId);
    loaded.push(tool.name);
  }
  return {
    projectId: input.projectId,
    ...projectLabel(state, input.projectId),
    loaded,
    ...(limited ? { error: "TOOL_LOAD_LIMIT" } : {}),
  };
}

const projectLabel = (state: TurnState, projectId: string) => {
  const name = state.names.get(projectId);
  return name === undefined ? {} : { projectName: name };
};

/** A user tool, with the personal space's context; it reports the projects it read. */
async function runUserTool(
  state: TurnState,
  tool: OrbitTool,
  args: Record<string, unknown>,
  callIndex: number,
) {
  const { request } = state;
  const { scope } = request.run;
  if (scope.userId !== request.userId || scope.workspaceId !== request.workspaceId)
    throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
  // A user tool that proposes (agent_delegate) records the turn's other
  // projects like a project tool does (ADR 0022 §5).
  const result = await crossProjectExecution.run(
    { contextProjects: [...state.contextProjects] },
    () =>
      tool.execute(
        {
          scope,
          runId: request.run.runId,
          conversationId: request.run.conversationId,
          callIndex,
          personal: {
            noteProjects: (ids) => ids.forEach((id) => state.contextProjects.add(id)),
            userText: request.userText ?? "",
          },
        },
        args,
      ),
  );
  // User tools label their cards with the project themselves.
  state.cards.push(...result.cards);
  return result.output;
}

/**
 * A loaded project tool in its target project. Only a project the tool was
 * loaded for: anything else is CHAT_TOOL_NOT_ALLOWED, before any read. The
 * capability layer authorizes the call there again; the tool runs with the
 * turn's taint, and its output comes back labelled with the project.
 */
async function runProjectTool(
  state: TurnState,
  name: string,
  args: Record<string, unknown>,
  callIndex: number,
) {
  const { [PROJECT_ID_PARAM]: target, ...rest } = args;
  const projectId = typeof target === "string" ? target : "";
  if (!state.loadedFor.get(name)?.has(projectId))
    throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
  const { request } = state;
  const projectName = state.names.get(projectId);
  const { result } = await executePersonalProjectCall({
    workspaceId: request.workspaceId,
    userId: request.userId,
    projectId,
    toolName: name,
    args: rest,
    context: {
      runId: request.run.runId,
      conversationId: request.run.conversationId,
      callIndex,
    },
    // Every request the tool creates names the other projects of the turn;
    // a proposal's status cards say whether the member may decide it here.
    wrap: async (tool, scope, execute) => {
      const done = await crossProjectExecution.run(
        { contextProjects: [...state.contextProjects] },
        execute,
      );
      return tool.risk === "P_proposal" ? withApprovalCards(scope, done) : done;
    },
  });
  state.contextProjects.add(projectId);
  for (const card of result.cards)
    state.cards.push({
      ...card,
      projectId,
      ...(projectName !== undefined ? { projectName } : {}),
    });
  return {
    projectId,
    ...projectLabel(state, projectId),
    result: result.output,
  };
}

/**
 * A proposal's result with its status cards bound to the request it made
 * (WP3.5): id, version and package hash as stored, and whether the member
 * may decide it in this project. Read after the tool's own transaction
 * committed, in the same target-project call.
 */
async function withApprovalCards(
  member: Scope,
  result: ToolResult,
): Promise<ToolResult> {
  const output = result.output as { actionRequestId?: unknown } | null;
  const id = typeof output?.actionRequestId === "string" ? output.actionRequestId : null;
  if (!id) return result;
  const row = await scoped(member.workspaceId, member.projectId, (tx) =>
    readActionRequest(tx, member, id),
  );
  if (!row) return result;
  const actionRequest = actionRequestCard(member, row);
  return {
    ...result,
    cards: result.cards.map((card) =>
      card.kind === "status" ? { ...card, actionRequest } : card,
    ),
  };
}

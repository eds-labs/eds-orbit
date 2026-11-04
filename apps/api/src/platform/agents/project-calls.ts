/**
 * Cross-project capability calls (ADR 0022 §4, plan agent-platform-phase-3
 * §2.2, WP3.2): one tool call that names its target project. Moved here from
 * the MCP adapter so the gateway and the personal Orbit Assistant share one
 * implementation of
 *
 * - the injected `projectId` argument (`projectBoundParameters`,
 *   `splitProjectArgument`),
 * - the member's scope in the target project, read again on every call
 *   (`projectMemberScope`, with actorScope, so the personal-space rule and
 *   deactivated users apply),
 * - the tools the member may use there (`projectCapabilities`: activation,
 *   module role, entitlement-backed features, the channel's exposure) and
 * - one call's authorization in that project (`authorizeProjectCapability`)
 *   with uniform refusals that carry no data: PROJECT_FORBIDDEN,
 *   MODULE_DISABLED, PERMISSION_DENIED (and PROJECT_PAUSED where the
 *   channel refuses paused projects).
 *
 * Each step reads the target project in its own `scoped()` transaction, and
 * every call runs inside `inProjectCall`, which never nests: a target-project
 * call cannot run while this layer holds another project's call open (in
 * test mode a nested call is refused with NESTED_PROJECT_CALL, the
 * lock-order assertion of plan R3-3). Channel gates (MCP grants, scopes,
 * proposal switches) are passed in as filters and only narrow the set.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { entitled, entitlementsFor } from "../entitlements/entitlements.ts";
import {
  moduleAvailable,
  registeredAssistants,
  registeredToolOwner,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { DomainError } from "../shared.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { visibleModules } from "../tenancy/module-roles.ts";
import {
  capabilityFeatures,
  executeCapability,
  resolveCapabilities,
  type CapabilityChannel,
} from "./capabilities.ts";
import type {
  OrbitTool,
  ToolContext,
  ToolFeature,
  ToolResult,
} from "./tools/registry.ts";

/** The argument added to every project-bound tool of a cross-project channel. */
export const PROJECT_ID_PARAM = "projectId";

/** Uniform refusal codes of a target-project call; none carries data. */
export const PROJECT_REFUSALS = [
  "PROJECT_FORBIDDEN",
  "MODULE_DISABLED",
  "PERMISSION_DENIED",
  "PROJECT_PAUSED",
] as const;
export type ProjectRefusalCode = (typeof PROJECT_REFUSALS)[number];

/** A refused target-project call: the code only, never a name or record. */
export class ProjectCallRefused extends DomainError {
  constructor(readonly refusal: ProjectRefusalCode) {
    super(refusal, refusal === "PROJECT_FORBIDDEN" ? 404 : 403);
    this.name = "ProjectCallRefused";
  }
}

export const isProjectRefusal = (error: unknown): error is ProjectCallRefused =>
  error instanceof ProjectCallRefused;

/** Whether a tool can take the injected argument (it declares no `projectId` itself). */
export const adaptsToProjectArgument = (tool: OrbitTool) =>
  !(PROJECT_ID_PARAM in tool.parameters.shape);

/**
 * The tool's parameters plus `projectId`, strict. With `optional` (a single
 * project, MCP) the argument may be left out unless the tool requires it.
 */
export function projectBoundParameters(
  tool: OrbitTool,
  options: { optional: boolean },
) {
  const projectId = z.uuid();
  return z.strictObject({
    ...tool.parameters.shape,
    [PROJECT_ID_PARAM]:
      options.optional && !tool.mcpProjectRequired
        ? projectId.optional()
        : projectId,
  });
}

/**
 * The target project and the tool's own arguments: the named `projectId`,
 * else `fallback` (the only project of a single-project grant). 400
 * PROJECT_REQUIRED when neither names one.
 */
export function splitProjectArgument(
  args: Record<string, unknown>,
  fallback?: string,
): { projectId: string; rest: Record<string, unknown> } {
  const { [PROJECT_ID_PARAM]: requested, ...rest } = args;
  const projectId = typeof requested === "string" ? requested : fallback;
  if (!projectId) throw new DomainError("PROJECT_REQUIRED", 400);
  return { projectId, rest };
}

// ---------------------------------------------------------------------------
// Lock order: one target-project call at a time per async chain.

const projectCall = new AsyncLocalStorage<{ projectId: string }>();

/** Whether the nested-call assertion is active (test mode, or switched on explicitly). */
export function lockOrderAssertionActive() {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.ORBIT_LOCK_ORDER_ASSERT === "true"
  );
}

/** The project of the target-project call in progress, or null outside one. */
export const activeProjectCall = () => projectCall.getStore()?.projectId ?? null;

/**
 * Runs `work` as the one target-project call of this async chain. A call
 * started while another one is open would read (and lock) a second project
 * inside the first one's work: in test mode it is refused with
 * NESTED_PROJECT_CALL before anything runs.
 */
export async function inProjectCall<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const open = projectCall.getStore();
  if (open && lockOrderAssertionActive())
    throw new DomainError("NESTED_PROJECT_CALL", 500);
  return projectCall.run({ projectId }, work);
}

// ---------------------------------------------------------------------------
// The member and the tools in the target project.

/**
 * The member's current scope in the target project. PROJECT_FORBIDDEN when
 * the channel does not admit the project or the member has no access there
 * (also a personal space of someone else, a deactivated user or another
 * workspace); the refusal never tells whether such a project exists.
 */
export async function projectMemberScope(input: {
  workspaceId: string;
  userId: string;
  projectId: string;
  admits?: (projectId: string) => boolean;
  /** Only business projects: never a personal space, not even the user's own. */
  businessOnly?: boolean;
}): Promise<Scope> {
  if (!z.uuid().safeParse(input.projectId).success)
    throw new ProjectCallRefused("PROJECT_FORBIDDEN");
  if (input.admits && !input.admits(input.projectId))
    throw new ProjectCallRefused("PROJECT_FORBIDDEN");
  if (
    input.businessOnly &&
    !(await authDb.project.findFirst({
      where: { id: input.projectId, kind: { not: "personal" } },
      select: { id: true },
    }))
  )
    throw new ProjectCallRefused("PROJECT_FORBIDDEN");
  const scope = await actorScope(
    input.workspaceId,
    input.projectId,
    input.userId,
  );
  if (!scope) throw new ProjectCallRefused("PROJECT_FORBIDDEN");
  return scope;
}

/** What a channel reads about the target project before deciding its tools. */
export type ProjectState = {
  /** The project's enabled modules; undefined means every available one. */
  enabled: ReadonlySet<string> | undefined;
  paused?: boolean;
};

/** The project's activation and pause, read in its own transaction. */
export const readProjectState = (scope: Scope): Promise<ProjectState> =>
  scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: scope.projectId },
      select: { paused: true },
    });
    return {
      enabled: await enabledModules(tx, scope),
      paused: project?.paused ?? false,
    };
  });

/** How a channel offers tools in a target project. */
export type ProjectToolsPolicy = {
  channel: CapabilityChannel;
  /** Reads the project's activation (default `readProjectState`). */
  state?: (scope: Scope) => Promise<ProjectState>;
  /** The features the visible enabled modules and the platform switch on. */
  features: (enabled: ReadonlySet<string> | undefined) => ToolFeature[];
  /** The channel's own gates; may only narrow the set. */
  filter?: (tool: OrbitTool) => boolean;
  /** Refuse every call in a paused project with PROJECT_PAUSED. */
  refusePaused?: boolean;
  /** Admit business projects only (the personal assistant's targets). */
  businessOnly?: boolean;
};

/**
 * The tools the member may use in the project through the channel, in
 * registry order, with the project state they were decided on.
 */
export async function projectCapabilityState(
  scope: Scope,
  policy: ProjectToolsPolicy,
): Promise<{ tools: OrbitTool[]; state: ProjectState }> {
  const state = await (policy.state ?? readProjectState)(scope);
  // A module the member has no access to counts as disabled (WP4.5).
  const enabled = visibleModules(scope, state.enabled);
  const tools = resolveCapabilities(scope, {
    channel: policy.channel,
    enabled,
    features: policy.features(enabled),
  }).filter((tool) => !policy.filter || policy.filter(tool));
  return { tools, state };
}

/** The tools the member may use in the project through the channel. */
export async function projectCapabilities(
  scope: Scope,
  policy: ProjectToolsPolicy,
): Promise<OrbitTool[]> {
  return (await projectCapabilityState(scope, policy)).tools;
}

/**
 * Why a tool the member may not use in the project is refused: its module
 * is unavailable or not enabled there (MODULE_DISABLED), otherwise the
 * member's role, module role or a feature does not allow it
 * (PERMISSION_DENIED).
 */
function refusalFor(toolName: string, state: ProjectState): ProjectRefusalCode {
  const owner = registeredToolOwner(toolName);
  if (owner && owner !== "platform") {
    if (!moduleAvailable(owner)) return "MODULE_DISABLED";
    if (state.enabled && !state.enabled.has(owner)) return "MODULE_DISABLED";
  }
  return "PERMISSION_DENIED";
}

/**
 * One call's authorization in the target project: the member's scope there
 * (checked first, so a tool name never reveals a project), the project's
 * pause where the channel refuses it, then the tool among those the member
 * may use there. Refusals are ProjectCallRefused; nothing runs.
 */
export async function authorizeProjectCapability(
  input: {
    workspaceId: string;
    userId: string;
    projectId: string;
    toolName: string;
    admits?: (projectId: string) => boolean;
  },
  policy: ProjectToolsPolicy,
): Promise<{ tool: OrbitTool; scope: Scope }> {
  const scope = await projectMemberScope({
    ...input,
    ...(policy.businessOnly ? { businessOnly: true } : {}),
  });
  const { tools, state } = await projectCapabilityState(scope, policy);
  if (policy.refusePaused && state.paused)
    throw new ProjectCallRefused("PROJECT_PAUSED");
  const tool = tools.find((candidate) => candidate.name === input.toolName);
  if (!tool) throw new ProjectCallRefused(refusalFor(input.toolName, state));
  return { tool, scope };
}

// ---------------------------------------------------------------------------
// The personal Orbit Assistant's project calls.

/**
 * How the personal Orbit Assistant offers project tools (ADR 0022 §4): the
 * tools Orbit Chat offers there (or that opt into the personal channel),
 * with every enabled module's features as with tool search (they load on
 * request anyway), never module operations, only tools that take the
 * injected `projectId`, and nothing in a paused project. Module activation
 * always applies, also while ORBIT_MODULES is off (opt-in modules count
 * only where an owner enabled them, as for MCP).
 */
export function personalToolsPolicy(): ProjectToolsPolicy {
  return {
    channel: "personal",
    features: (enabled) =>
      capabilityFeatures(registeredAssistants(enabled), {
        toolSearch: true,
        moduleOperations: false,
      }),
    filter: adaptsToProjectArgument,
    refusePaused: true,
    // A personal space is never a target, not even the user's own.
    businessOnly: true,
  };
}

/** Refuses ASSISTANT_ENTITLEMENT unless the organization may use the personal assistant. */
export async function assertPersonalEntitlement(workspaceId: string) {
  if (!entitled(await entitlementsFor(workspaceId), "assistantPersonal"))
    throw new DomainError("ASSISTANT_ENTITLEMENT", 403);
}

/**
 * Runs one project tool call of the personal Orbit Assistant in its target
 * project: authorized there (member, pause, activation, module role,
 * feature), executed with the member's role in the tool's module, inside
 * `inProjectCall`, so it never runs within another project's call. The
 * caller's own (personal-space) transaction is never open around it.
 * `wrap` lets the host run the execution inside its own context (the
 * cross-project taint of proposals). Refusals are ProjectCallRefused.
 */
export async function executePersonalProjectCall(input: {
  workspaceId: string;
  userId: string;
  projectId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: Pick<ToolContext, "runId" | "conversationId" | "callIndex">;
  wrap?: (
    tool: OrbitTool,
    scope: Scope,
    execute: () => Promise<ToolResult>,
  ) => Promise<ToolResult>;
}): Promise<{ tool: OrbitTool; scope: Scope; result: ToolResult }> {
  return inProjectCall(input.projectId, async () => {
    await assertPersonalEntitlement(input.workspaceId);
    const { tool, scope } = await authorizeProjectCapability(
      input,
      personalToolsPolicy(),
    );
    // As in project chat: the tool validates its raw arguments itself.
    const execute = () =>
      executeCapability(tool, { ...input.context, scope }, input.args, {
        validate: "tool",
      });
    const result = input.wrap
      ? await input.wrap(tool, scope, execute)
      : await execute();
    return { tool, scope, result };
  });
}

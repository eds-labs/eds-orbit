/**
 * The agent principal (ADR 0021 §2, plan agent-platform-phase-1 §2.3). An
 * agent never has rights of its own: it acts on behalf of its sponsor (the
 * owner who activated its current version) and, for a manual or delegated
 * work order, its requester. The effective rights of one tool call are the
 * agent's frozen allowlist intersected with the sponsor's and the
 * requester's current rights, read again on every call.
 */
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { registeredToolOwner } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { DomainError } from "../shared.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import { can } from "../tenancy/permissions.ts";
import { exposedToAgent, type OrbitTool, type ToolRisk } from "./tools/registry.ts";
import { agentFeatures } from "./features.ts";
import { agentExecution, agentExecutionRequester } from "./agent-execution.ts";

/** The MCP 2.0 autonomy vocabulary (ADR 0021 §5). */
export type AgentMode = "read" | "draft" | "execute";
export const AGENT_MODES: readonly AgentMode[] = ["read", "draft", "execute"];

/** Knowledge an agent may search: named sources and/or source audiences. */
export type KnowledgeRestriction = {
  sourceIds?: readonly string[];
  audiences?: readonly string[];
};

/** What an agent may use, frozen with its activated version. */
export type AgentAllow = {
  tools: ReadonlySet<string>;
  modules: ReadonlySet<string>;
  mode: AgentMode;
  knowledge: KnowledgeRestriction | null;
};

export type AgentPrincipal = {
  kind: "agent";
  /** The sponsor: the owner who activated the agent's current version. */
  userId: string;
  /** The member who asked for a manual or delegated work order. */
  requesterUserId?: string;
  agentId: string;
  agentVersion: number;
  workOrderId: string;
  rootWorkOrderId?: string;
  /** 0 for a root work order; at most 2 (ADR 0021 §8). */
  depth: number;
  allow: AgentAllow;
  ceilingMicros: number;
};

export const MAX_DELEGATION_DEPTH = 2;

/**
 * Which tool risks a mode permits: `read` reads only, `draft` also
 * proposes, `execute` also writes internally (W0).
 */
export function modePermits(mode: AgentMode, risk: ToolRisk): boolean {
  if (risk === "R0_read") return true;
  if (risk === "P_proposal") return mode !== "read";
  return mode === "execute";
}

/**
 * The module a tool's use counts against: its owner, except the platform's
 * knowledge search, which belongs to the knowledge module (as for delegated
 * MCP work orders).
 */
export function toolModule(tool: Pick<OrbitTool, "name">): string | undefined {
  const owner = registeredToolOwner(tool.name);
  return owner === "platform" && tool.name === "knowledge_search"
    ? "knowledge"
    : owner;
}

const forbidden = () => new DomainError("AGENT_PRINCIPAL_FORBIDDEN", 403);

/** The member's scope in the tool's module when it may use the tool now, else null. */
async function memberMay(
  project: Pick<Scope, "workspaceId" | "projectId">,
  userId: string,
  tool: OrbitTool,
): Promise<Scope | null> {
  const actor = await actorScope(project.workspaceId, project.projectId, userId);
  if (!actor) return null;
  try {
    const own = moduleScope(actor, registeredToolOwner(tool.name));
    return can(own, tool.permission) ? own : null;
  } catch {
    return null;
  }
}

/**
 * Authorizes one tool call of an agent and returns the scope it runs with:
 * the sponsor's current scope in the tool's module. Refuses
 * AGENT_PRINCIPAL_FORBIDDEN, and nothing runs, unless the tool is exposed to
 * agents and allow-listed, the mode permits its risk, its module is in the
 * allowlist and enabled for the project, and the sponsor and the requester
 * both still hold its permission there. `current` adds the work order's own
 * checks (the agent is still active at the same version, entitlements).
 */
export async function authorizeAgentTool(
  principal: AgentPrincipal,
  project: Pick<Scope, "workspaceId" | "projectId">,
  tool: OrbitTool,
  options: { current?: () => Promise<void> } = {},
): Promise<Scope> {
  if (!exposedToAgent(tool) || !principal.allow.tools.has(tool.name))
    throw forbidden();
  if (!modePermits(principal.allow.mode, tool.risk)) throw forbidden();
  const module = toolModule(tool);
  if (module && module !== "platform" && !principal.allow.modules.has(module))
    throw forbidden();
  const sponsor = await memberMay(project, principal.userId, tool);
  if (!sponsor) throw forbidden();
  if (
    principal.requesterUserId &&
    principal.requesterUserId !== principal.userId &&
    !(await memberMay(project, principal.requesterUserId, tool))
  )
    throw forbidden();
  const enabled = await scoped(project.workspaceId, project.projectId, (tx) =>
    enabledModules(tx, sponsor),
  );
  if (module && module !== "platform" && enabled && !enabled.has(module))
    throw forbidden();
  // A feature switched off (its module's or the platform's flag) stops the tool too.
  if (tool.feature && !agentFeatures(enabled).includes(tool.feature))
    throw forbidden();
  await options.current?.();
  return sponsor;
}

/**
 * Authorizes work a module's own agent does on behalf of a member (the
 * on-behalf principal, plan agent-platform-phase-1 WP1.9): Marketing's
 * specialists act for the owner who confirmed their assignment. The member
 * must still be an owner in `module` and, for a tool call, hold the tool's
 * permission in the tool's module; read again on every call, so a demoted
 * or removed member stops the work with AGENT_PRINCIPAL_FORBIDDEN. Returns
 * the member's current scope in `module`; the caller keeps its own scope for
 * its database work.
 */
export async function authorizeOnBehalf(
  project: Pick<Scope, "workspaceId" | "projectId">,
  userId: string | null | undefined,
  module: string,
  tool?: OrbitTool,
): Promise<Scope> {
  if (!userId) throw forbidden();
  const actor = await actorScope(project.workspaceId, project.projectId, userId);
  if (!actor) throw forbidden();
  let own: Scope;
  let toolAllowed = true;
  try {
    own = moduleScope(actor, module);
    if (tool)
      toolAllowed = can(
        moduleScope(actor, registeredToolOwner(tool.name)),
        tool.permission,
      );
  } catch {
    throw forbidden();
  }
  if (own.role !== "owner" || !toolAllowed) throw forbidden();
  return own;
}

/**
 * Whether `child` is within `parent` (monotonic narrowing for delegation,
 * ADR 0021 §8): every tool and module, the mode and the knowledge sources.
 */
export function narrowsAllow(parent: AgentAllow, child: AgentAllow): boolean {
  const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
    [...a].every((item) => b.has(item));
  if (!subset(child.tools, parent.tools)) return false;
  if (!subset(child.modules, parent.modules)) return false;
  if (AGENT_MODES.indexOf(child.mode) > AGENT_MODES.indexOf(parent.mode))
    return false;
  if (parent.knowledge) {
    if (!child.knowledge) return false;
    const within = (c?: readonly string[], p?: readonly string[]) =>
      !p || (c !== undefined && c.every((item) => p.includes(item)));
    if (!within(child.knowledge.sourceIds, parent.knowledge.sourceIds))
      return false;
    if (!within(child.knowledge.audiences, parent.knowledge.audiences))
      return false;
  }
  return true;
}

/** The agent fields an ActionRequest records for a proposal of this principal. */
export function agentRequester(principal: AgentPrincipal, agentRunId: string | null) {
  return agentExecution.run({ principal, agentRunId }, agentExecutionRequester)!;
}

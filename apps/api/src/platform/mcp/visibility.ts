/**
 * Which registry tools an MCP principal may list and call in a project
 * (Track M, WP-M2, plans/orbit-modularization/09 §4.2). The effective
 * permission is the intersection of the tool's permission, the user's current
 * role in the project (incl. module roles), the grant (projects, scopes,
 * modules) and module activation. It reuses the assistant's filter
 * (chat-runner) and adds exposure, grant and scope checks; it never widens
 * what the user may do in the UI.
 */
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  availableTools,
  exposedToMcp,
  type OrbitTool,
} from "../../modules/agents/tools/registry.ts";
import { moduleSwitchingEnabled } from "../modules/activation.ts";
import {
  moduleAvailable,
  registeredAssistants,
  registeredRegistry,
  registeredToolOwner,
  registeredTools,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { DomainError } from "../shared.ts";
import { effectiveRole, visibleModules } from "../tenancy/module-roles.ts";
import { projectScope, type McpPrincipal } from "./principal.ts";

export type McpScope = "orbit:read" | "orbit:propose" | "orbit:write";

/** The OAuth scope a tool needs: R0 reads, P proposals, W0 internal writes. */
export function requiredScope(tool: Pick<OrbitTool, "risk">): McpScope {
  switch (tool.risk) {
    case "R0_read":
      return "orbit:read";
    case "P_proposal":
      return "orbit:propose";
    case "W0_internal":
      return "orbit:write";
    default: {
      const unknown: never = tool.risk;
      throw new Error(`TOOL_RISK_UNKNOWN:${String(unknown)}`);
    }
  }
}

/** Available modules that are off by default (support): an owner must enable them. */
function optInModules(): string[] {
  return registeredRegistry()
    .modules.filter((m) => !m.defaultEnabled && moduleAvailable(m.id))
    .map((m) => m.id);
}

/**
 * Whether listing MCP tools must read the project's module activation. Not
 * while ORBIT_MODULES is off and no opt-in module owns an MCP-exposed tool:
 * the answer for the exposed tools is then the same for every project, so
 * the gateway saves one project transaction per granted project and request.
 */
export function mcpToolsNeedActivationRows(): boolean {
  if (moduleSwitchingEnabled()) return true;
  const optIn = new Set(optInModules());
  if (!optIn.size) return false;
  return registeredTools().some(
    (tool) => exposedToMcp(tool) && optIn.has(registeredToolOwner(tool.name)!),
  );
}

/** The project's enabled modules (enabledModules), read in its own transaction. */
const readEnabledModules = (scope: Scope) =>
  scoped(scope.workspaceId, scope.projectId, (tx) => enabledModules(tx, scope));

/**
 * The enabled modules that decide the project's MCP tools. Without the read
 * (see mcpToolsNeedActivationRows) every available module counts except the
 * opt-in ones, which own no exposed tool then; their assistants contribute
 * no tool features (only marketing does, and it is on by default).
 */
async function enabledForTools(
  scope: Scope,
): Promise<ReadonlySet<string> | undefined> {
  if (mcpToolsNeedActivationRows()) return readEnabledModules(scope);
  const optIn = optInModules();
  if (!optIn.length) return undefined;
  return new Set(
    registeredRegistry().order.filter(
      (id) => moduleAvailable(id) && !optIn.includes(id),
    ),
  );
}

/**
 * The tools the principal may use with this scope, in name order. Module
 * activation always applies: unlike the assistant it also applies while
 * ORBIT_MODULES is off, so an opt-in module (support) counts only where an
 * owner enabled it. Tool search does not exist over MCP, so features that a
 * module turns on only with tool search stay off.
 */
async function allowedTools(
  principal: McpPrincipal,
  scope: Scope,
): Promise<OrbitTool[]> {
  const enabled = visibleModules(scope, await enabledForTools(scope));
  const features = registeredAssistants(enabled).flatMap((assistant) =>
    assistant.features({ toolSearch: false }),
  );
  return registeredTools(enabled)
    .filter((tool) => {
      if (!exposedToMcp(tool)) return false;
      const owner = registeredToolOwner(tool.name);
      // A module restriction admits only the listed modules' tools.
      if (
        principal.modules.length &&
        !(owner && principal.modules.includes(owner))
      )
        return false;
      const role = effectiveRole(scope, owner);
      if (role === "none") return false;
      if (!availableTools([tool], role, features).length) return false;
      return principal.scopes.has(requiredScope(tool));
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The tools an MCP client may list for a project. 404 NOT_FOUND when the
 * project is outside the principal or the membership is gone.
 */
export async function visibleMcpTools(
  principal: McpPrincipal,
  projectId: string,
): Promise<OrbitTool[]> {
  return allowedTools(principal, await projectScope(principal, projectId));
}

/**
 * The same checks for one call: the tool and the project scope to run it
 * with. 404 NOT_FOUND for the project (checked first, so a tool name never
 * reveals a project), 403 MCP_TOOL_NOT_ALLOWED for a tool the principal may
 * not list there.
 */
export async function authorizeMcpCall(
  principal: McpPrincipal,
  toolName: string,
  projectId: string,
): Promise<{ tool: OrbitTool; scope: Scope }> {
  const scope = await projectScope(principal, projectId);
  const tool = (await allowedTools(principal, scope)).find(
    (candidate) => candidate.name === toolName,
  );
  if (!tool) throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  return { tool, scope };
}

/**
 * The modules of a project the principal may use, in registry order: enabled
 * for the project, visible to the member's role and inside the grant's
 * module restriction. Always reads the project's activation.
 */
export async function principalModules(
  principal: McpPrincipal,
  scope: Scope,
): Promise<string[]> {
  const enabled = visibleModules(scope, await readEnabledModules(scope));
  return registeredRegistry().order.filter(
    (id) =>
      moduleAvailable(id) &&
      (!enabled || enabled.has(id)) &&
      (!principal.modules.length || principal.modules.includes(id)),
  );
}

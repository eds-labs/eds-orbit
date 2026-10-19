import { can } from "../tenancy/permissions.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
/** Execution authority for a delegated turn; never inferred from prompt text. */
import { AsyncLocalStorage } from "node:async_hooks";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { OrbitTool } from "../../modules/agents/tools/registry.ts";
import { registeredToolOwner } from "../modules/contributions.ts";
import { data, DomainError, hash } from "../shared.ts";
import type { McpPrincipal } from "../mcp/principal.ts";

import { loadConfig } from "../../../../../packages/config/src/index.ts";

export type Delegation = {
  taskId: string;
  grantId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  modules: string[];
  mode: "read" | "draft" | "execute";
  ceilingMicros: number;
};
export const delegatedExecution = new AsyncLocalStorage<Delegation>();

export async function taskDelegation(
  tx: DbTx,
  scope: Scope,
  runId: string,
): Promise<Delegation | null> {
  const row = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "orbit_tasks",
      data: { path: ["runId"], equals: runId },
    },
  });
  return row
    ? ({ ...data(row).delegation, taskId: row.id } as Delegation)
    : null;
}

export async function delegationPrincipal(
  scope: Scope,
  d: Delegation,
): Promise<McpPrincipal> {
  const { projectScope } = await import("../mcp/principal.ts");
  if (
    loadConfig().ORBIT_MCP_TASKS !== "true" ||
    loadConfig().ORBIT_MCP_PROPOSALS !== "true"
  )
    throw new DomainError("MCP_PROPOSALS_DISABLED", 403);
  const g = await authDb.mcpGrant.findFirst({
    where: {
      id: d.grantId,
      workspaceId: scope.workspaceId,
      userId: d.userId,
      clientId: d.clientId,
      status: "active",
    },
  });
  if (
    !g ||
    (g.expiresAt && g.expiresAt.getTime() <= Date.now()) ||
    (!g.allCurrentProjects && !g.projectIds.includes(scope.projectId))
  )
    throw new DomainError("MCP_GRANT_ENDED", 403);
  const principal: McpPrincipal = {
    userId: d.userId,
    clientId: d.clientId,
    grantId: g.id,
    workspaceId: g.workspaceId,
    scopes: new Set(d.scopes.filter((s) => g.scopes.includes(s))),
    modules: g.modules,
    projectIds: [scope.projectId],
  };
  await projectScope(principal, scope.projectId);
  if (!principal.scopes.has("orbit:propose"))
    throw new DomainError("MCP_GRANT_ENDED", 403);
  return principal;
}

export async function assertDelegation(
  scope: Scope,
  d: Delegation | null,
  tx?: DbTx,
) {
  if (!d) return;
  const { projectScope } = await import("../mcp/principal.ts");
  const { principalModules } = await import("../mcp/visibility.ts");
  const p = await delegationPrincipal(scope, d);
  const allowed = await principalModules(
    p,
    await projectScope(p, scope.projectId),
    tx,
  );
  if (d.modules.some((m) => !allowed.includes(m)))
    throw new DomainError("MCP_MODULE_ACCESS_CHANGED", 403);
}

export async function authorizeDelegatedTool(
  scope: Scope,
  d: Delegation | null,
  tool: OrbitTool,
) {
  if (!d) return scope;
  await assertDelegation(scope, d);
  const { projectScope } = await import("../mcp/principal.ts");
  const { principalModules } = await import("../mcp/visibility.ts");
  const p = await delegationPrincipal(scope, d);
  if (tool.name === "propose_campaign")
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  const current = await projectScope(p, scope.projectId);
  const owner = registeredToolOwner(tool.name);
  const effective = moduleScope(current, owner);
  if (!can(effective, tool.permission))
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  const module =
    owner === "platform" && tool.name === "knowledge_search"
      ? "knowledge"
      : owner;
  if (module && module !== "platform" && !d.modules.includes(module))
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  if (
    (d.mode === "read" && tool.risk !== "R0_read") ||
    (d.mode !== "execute" && tool.risk === "W0_internal") ||
    !p.scopes.has(
      tool.risk === "R0_read"
        ? "orbit:read"
        : tool.risk === "P_proposal"
          ? "orbit:propose"
          : "orbit:write",
    ) ||
    !(tool.mcpScopes ?? []).every((s) => p.scopes.has(s))
  )
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  return effective;
}

/** Central request attribution: delegated tools cannot impersonate an in-app user. */
export function delegatedRequester(payload: unknown) {
  const d = delegatedExecution.getStore();
  return d
    ? {
        kind: "mcp" as const,
        userId: d.userId,
        clientId: d.clientId,
        grantId: d.grantId,
        agentRunId: null,
        argsHash: hash(payload),
        taskId: d.taskId,
      }
    : null;
}

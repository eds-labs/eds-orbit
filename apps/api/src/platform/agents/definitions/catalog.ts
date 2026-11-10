/**
 * The agent builder catalogue (ADR 0021, plan §2.8): which tools the
 * current member may grant an agent in this project. A member can only
 * grant what they hold themselves, so the catalogue is computed per member:
 * every tool exposed to agents, each with its badges and, when it cannot be
 * granted, the reason. Saving a definition uses the same check.
 */
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import {
  registeredActionType,
  registeredRegistry,
  registeredToolOwner,
  registeredTools,
  moduleAvailable,
} from "../../modules/contributions.ts";
import { enabledModules } from "../../modules/enforcement.ts";
import { effectiveRole, visibleModules } from "../../tenancy/module-roles.ts";
import { can } from "../../tenancy/permissions.ts";
import { agentFeatures } from "../features.ts";
import { toolModule } from "../principal.ts";
import { exposedToAgent, type OrbitTool } from "../tools/registry.ts";

export type CatalogRefusal =
  | "MODULE_DISABLED"
  | "MODULE_NOT_AVAILABLE"
  | "ROLE_INSUFFICIENT"
  | "FEATURE_OFF";

export type CatalogTool = {
  name: string;
  module: string;
  risk: OrbitTool["risk"];
  title: { en: string; de: string };
  summary: { en: string; de: string };
  dataClass: "internal" | "customer_personal" | "financial";
  cost: "none" | "paid";
  /** A proposal: an ActionRequest a person (or a mandate naming the agent) decides. */
  needsApproval: boolean;
  /** An owner may cover its action type with an agent mandate (ADR 0019). */
  mandatable: boolean;
  grantable: boolean;
  reason?: CatalogRefusal;
};

/** The action type of a proposal operation's tool (`<module>.mcp.<tool>`). */
const actionTypeOf = (tool: OrbitTool) => `${tool.namespace}.mcp.${tool.name}`;

/** Why the member cannot grant the tool, or null. */
function refusal(
  scope: Scope,
  tool: OrbitTool,
  enabled: ReadonlySet<string> | undefined,
  features: readonly string[],
): CatalogRefusal | null {
  const module = toolModule(tool);
  if (module && module !== "platform" && enabled && !enabled.has(module))
    return "MODULE_DISABLED";
  const role = effectiveRole(scope, registeredToolOwner(tool.name));
  if (role === "none") return "MODULE_NOT_AVAILABLE";
  if (!can({ role }, tool.permission)) return "ROLE_INSUFFICIENT";
  if (tool.feature && !features.includes(tool.feature)) return "FEATURE_OFF";
  return null;
}

/** Every tool exposed to agents, with what the member may grant, in name order. */
export async function agentToolCatalog(tx: DbTx, scope: Scope): Promise<CatalogTool[]> {
  const enabled = visibleModules(scope, await enabledModules(tx, scope));
  const features = agentFeatures(enabled);
  return registeredTools()
    .filter(exposedToAgent)
    .map((tool) => {
      const reason = refusal(scope, tool, enabled, features);
      const catalog = tool.catalog!;
      return {
        name: tool.name,
        module: toolModule(tool) ?? "platform",
        risk: tool.risk,
        title: catalog.title,
        summary: catalog.summary,
        dataClass: catalog.dataClass ?? "internal",
        cost: catalog.cost ?? "none",
        needsApproval: tool.risk === "P_proposal",
        mandatable:
          tool.risk === "P_proposal" &&
          Boolean(registeredActionType(actionTypeOf(tool))?.mandate),
        grantable: reason === null,
        ...(reason ? { reason } : {}),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The modules an agent may name in this project for the member: available, enabled, visible. */
export async function agentModuleCatalog(tx: DbTx, scope: Scope) {
  const enabled = visibleModules(scope, await enabledModules(tx, scope));
  return registeredRegistry()
    .order.filter((id) => moduleAvailable(id))
    .map((id) => ({
      id,
      enabled: !enabled || enabled.has(id),
      access: effectiveRole(scope, id) !== "none",
    }));
}

/**
 * Refuses AGENT_TOOL_NOT_GRANTABLE unless the member may grant every named
 * tool, each of whose modules is among `modules`. Used when a definition is
 * saved and when it is activated (with the activating owner's scope).
 */
export async function assertGrantable(
  tx: DbTx,
  scope: Scope,
  tools: readonly string[],
  modules: readonly string[],
) {
  const catalog = new Map((await agentToolCatalog(tx, scope)).map((t) => [t.name, t]));
  for (const name of tools) {
    const entry = catalog.get(name);
    if (!entry?.grantable) throw new DomainError("AGENT_TOOL_NOT_GRANTABLE", 403);
    if (entry.module !== "platform" && !modules.includes(entry.module))
      throw new DomainError("AGENT_TOOL_NOT_GRANTABLE", 403);
  }
}

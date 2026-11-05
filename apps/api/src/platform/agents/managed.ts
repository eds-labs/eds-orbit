/**
 * Agents a module manages itself (plan agent-platform-phase-1 WP1.9), e.g.
 * Marketing's assignments: listed read-only in the agent overview next to
 * configured agents. The platform never imports a module; each module
 * contributes `agentListings` and the overview reads them through the
 * registry.
 */
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { registeredAgentListings } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { moduleScope, visibleModules } from "../tenancy/module-roles.ts";

/** One module-managed agent as the overview shows it. */
export type ManagedAgentListing = {
  id: string;
  name: string;
  status: string;
  /** A short summary of when it runs, e.g. "Daily at 10:00, 17:00 (Europe/Berlin)". */
  schedule?: string;
  /** What it has spent in the current UTC month. */
  monthSpendMicros?: number;
  monthBudgetMicros?: number;
  /** Where the module's own page manages it (a web path). */
  link: string;
};

/**
 * A module's listing of its managed agents. It gets the member's scope in
 * the module (`moduleScope`) and must only return what that member may see.
 */
export type AgentListingsContribution = (
  tx: DbTx,
  scope: Scope,
) => Promise<ManagedAgentListing[]>;

/**
 * The managed agents of the project's enabled modules the member can see,
 * grouped by module in registry order; modules without items are left out.
 */
export async function managedAgentGroups(tx: DbTx, scope: Scope) {
  const visible = visibleModules(scope, await enabledModules(tx, scope));
  const groups: Array<{ module: string; items: ManagedAgentListing[] }> = [];
  for (const { module, list } of registeredAgentListings(visible)) {
    const items = await list(tx, moduleScope(scope, module));
    if (items.length) groups.push({ module, items });
  }
  return { groups };
}

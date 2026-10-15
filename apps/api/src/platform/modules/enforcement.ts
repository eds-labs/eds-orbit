import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { listModuleStates, moduleSwitchingEnabled } from "./activation.ts";
import { ownerEnabled, registeredRegistry } from "./contributions.ts";

// Module activation enforcement (WP2.4, docs/MODULE_ACTIVATION.md). Only
// with ORBIT_MODULES=true does a recorded "disabled" take effect; with the
// flag off every module counts as enabled and nothing reads the table.

/** The project's enabled modules, or undefined while enforcement is off. */
export async function enabledModules(
  tx: DbTx,
  scope: Scope,
): Promise<ReadonlySet<string> | undefined> {
  if (!moduleSwitchingEnabled()) return undefined;
  const states = await listModuleStates(tx, scope, registeredRegistry());
  return new Set(states.filter((s) => s.enabled).map((s) => s.id));
}

/** Throws 404 MODULE_DISABLED when the owner module is off for the project. */
export async function assertModuleEnabled(
  tx: DbTx,
  scope: Scope,
  owner: string | undefined,
) {
  if (!moduleSwitchingEnabled() || !owner || owner === "platform") return;
  if (!ownerEnabled(owner, await enabledModules(tx, scope)))
    throw new DomainError("MODULE_DISABLED", 404);
}

/** The same check in its own project transaction, only while enforcement is on. */
export async function assertModuleEnabledFor(
  scope: Scope,
  owner: string | undefined,
) {
  if (!moduleSwitchingEnabled() || !owner || owner === "platform") return;
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    assertModuleEnabled(tx, scope, owner),
  );
}

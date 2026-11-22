import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { validateActiveIndexEvaluation } from "../../../../../packages/knowledge/src/index.ts";
import {
  ownerEnabled,
  registeredReleaseGateDependents,
  type ReleaseGateDependent,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { effectiveRole } from "../tenancy/module-roles.ts";

export type ReleaseImpact = {
  /** False while the released-post watch is off for the installation. */
  enabled: boolean;
  /** Whether the live index evaluation is valid now (the gate is open). */
  gateValid: boolean;
  /** How many released records a corpus change would block, in every enabled module. */
  count: number;
  /** Their details, only from modules the member may use. */
  dependents: ReleaseGateDependent[];
};

/**
 * What a corpus change would block now (released-post watch, C): the
 * released records of every enabled module that depend on the valid live
 * index evaluation. Empty while the gate is already invalid (they are blocked
 * anyway). `count` covers every enabled module; `dependents` only those whose
 * module the member has a role in. Read-only.
 */
export async function releaseImpact(
  tx: DbTx,
  scope: Scope,
): Promise<ReleaseImpact> {
  if (loadConfig().ORBIT_RELEASED_POST_WATCH !== "true")
    return { enabled: false, gateValid: true, count: 0, dependents: [] };
  // No active index counts as an invalid gate, as the readiness read does.
  const live = await isolated(tx, "release_impact_gate", () =>
    validateActiveIndexEvaluation(tx, scope),
  ).catch(() => ({ valid: false }));
  if (!live.valid)
    return { enabled: true, gateValid: false, count: 0, dependents: [] };
  const enabled = await enabledModules(tx, scope);
  let count = 0;
  const dependents: ReleaseGateDependent[] = [];
  for (const [index, { moduleId, list }] of registeredReleaseGateDependents().entries()) {
    if (!ownerEnabled(moduleId, enabled)) continue;
    let found: ReleaseGateDependent[];
    try {
      found = await isolated(tx, `release_impact_${index}`, () => list(tx, scope));
    } catch (error) {
      // A warning must not fail the dialog or the change it guards: the
      // module is left out. Content-free: only the module and error class.
      console.warn(
        `release-impact: module ${moduleId} failed (${error instanceof Error ? error.name : "error"})`,
      );
      continue;
    }
    count += found.length;
    if (effectiveRole(scope, moduleId) !== "none") dependents.push(...found);
  }
  dependents.sort((a, b) => Date.parse(a.slotAt) - Date.parse(b.slotAt));
  return { enabled: true, gateValid: true, count, dependents };
}

/**
 * Runs `work` in its own savepoint: a failed statement (which aborts the
 * Postgres transaction) is rolled back to it, so the caller's transaction
 * stays usable; the error is rethrown. Names are fixed here, never input.
 */
export async function isolated<T>(
  tx: DbTx,
  savepoint: string,
  work: () => Promise<T>,
): Promise<T> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    const result = await work();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    throw error;
  }
}

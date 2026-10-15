import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { registeredReadiness } from "../modules/contributions.ts";
import type { ProjectReadiness } from "./types.ts";

/** The project's readiness from the registered provider (WP2.1f). */
export async function projectReadiness(
  tx: DbTx,
  scope: Scope,
): Promise<ProjectReadiness> {
  const provider = registeredReadiness();
  if (!provider) throw new DomainError("READINESS_NOT_REGISTERED", 500);
  return provider(tx, scope);
}

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import { registeredRetention } from "../modules/contributions.ts";

/**
 * Applies the project's retention period (WP1.8): every module purges what
 * expired before the cutoff, then one audit entry records the counts.
 */
export async function retention(
  tx: DbTx,
  scope: Scope,
  days: number,
  at = new Date(),
) {
  if (!Number.isInteger(days) || days < 30 || days > 3650)
    throw new DomainError("INVALID_RETENTION");
  const cutoff = new Date(at.valueOf() - days * 86400000);
  const counts: Record<string, number> = {};
  const result: Record<string, number> = {};
  for (const contribution of registeredRetention()) {
    const part = await contribution(tx, scope, { cutoff, at });
    Object.assign(counts, part.audit);
    Object.assign(result, part.result);
  }
  await audit(tx, scope, "retention.apply", scope.projectId, {
    days,
    ...counts,
  });
  return result;
}

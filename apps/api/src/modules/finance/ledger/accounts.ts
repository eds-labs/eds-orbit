import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";

/** The accounts the posting rules look up by role (FinanceAccount.role). */
export const SYSTEM_ROLES = [
  "payables",
  "receivables",
  "owner_contributions",
  "owner_draws",
  "fx_gain_loss",
  "rounding",
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Account id per system role. */
export type SystemAccounts = Record<SystemRole, string>;

/**
 * The project's live system accounts by role. Throws 409
 * FINANCE_SETUP_REQUIRED when any role has no unarchived account, so
 * nothing posts before the chart of accounts is set up.
 */
export async function systemAccounts(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
): Promise<SystemAccounts> {
  const rows = await tx.financeAccount.findMany({
    where: {
      projectId: scope.projectId,
      role: { in: [...SYSTEM_ROLES] },
      archivedAt: null,
    },
    select: { id: true, role: true },
  });
  const byRole = new Map(rows.map((row) => [row.role, row.id]));
  const accounts = {} as SystemAccounts;
  for (const role of SYSTEM_ROLES) {
    const id = byRole.get(role);
    if (!id) throw new DomainError("FINANCE_SETUP_REQUIRED", 409);
    accounts[role] = id;
  }
  return accounts;
}

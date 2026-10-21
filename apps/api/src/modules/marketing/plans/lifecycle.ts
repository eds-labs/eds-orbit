import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, entity, update, audit, DomainError } from "../../../shared.ts";
import { setAssignmentStatus } from "../agents/assignments.ts";

/** Only owned children stop; independent links remain independent. Shared
 * withdrawal retains provider-owned/unknown rows for reconciliation. */
export async function pauseOwnedChildren(
  tx: DbTx,
  scope: Scope,
  plan: { id: string; data: unknown },
) {
  for (const child of data(plan).activation?.children ?? []) {
    const row = await entity(tx, scope, "assignments", child.id);
    if (data(row).marketingPlan?.planId !== plan.id)
      throw new DomainError("PLAN_CHILD_OWNERSHIP_STALE", 409);
    if (["active", "budget_exhausted"].includes(data(row).status))
      await setAssignmentStatus(tx, scope, row.id, "paused", row.version);
  }
}
export async function pausePlanInTx(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
) {
  const row = await entity(tx, scope, "marketing_plans", id);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (data(row).status === "paused") return;
  if (data(row).status !== "active")
    throw new DomainError("PLAN_NOT_ACTIVE", 409);
  await pauseOwnedChildren(tx, scope, row);
  await update(tx, scope, row, { ...data(row), status: "paused" });
  await audit(tx, scope, "marketing_plan.paused", id, {
    revision: data(row).revision,
  });
}

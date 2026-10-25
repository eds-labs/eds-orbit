import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { readPmSettings } from "./settings.ts";

// The PM's own daily ceiling (Q-P2-1, default USD 2 per project and UTC
// day), on top of the spend mandate that `reserve` enforces. Settled calls
// count with their cost, open and unknown ones with their reservation.

export const PM_BUDGET_CATEGORY = "work_pm";

const dayStart = (now: Date) => {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
};

/** The PM's spend today, in micros. */
export async function pmSpentToday(tx: DbTx, scope: Scope, now = new Date()) {
  const rows = await tx.budgetReservation.findMany({
    where: {
      projectId: scope.projectId,
      category: PM_BUDGET_CATEGORY,
      createdAt: { gte: dayStart(now) },
      state: { not: "released" },
    },
    select: { amountMicros: true, settledMicros: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.settledMicros ?? r.amountMicros), 0);
}

/** Throws 409 WORK_PM_BUDGET_EXHAUSTED when `estimate` does not fit today. */
export async function assertPmBudget(
  tx: DbTx,
  scope: Scope,
  estimateMicros: number,
  now = new Date(),
) {
  const { settings } = await readPmSettings(tx, scope);
  if ((await pmSpentToday(tx, scope, now)) + estimateMicros > settings.dailyCeilingMicros)
    throw new DomainError("WORK_PM_BUDGET_EXHAUSTED", 409);
}

/** Today's spend and ceiling, for the PM panel. */
export async function pmBudgetToday(tx: DbTx, scope: Scope, now = new Date()) {
  const { settings } = await readPmSettings(tx, scope);
  return {
    spentMicros: await pmSpentToday(tx, scope, now),
    ceilingMicros: settings.dailyCeilingMicros,
  };
}

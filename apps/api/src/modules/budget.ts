import type { DbTx } from "../../../../packages/db/src/index.ts";
import type {
  Scope,
  PolicyInput,
} from "../../../../packages/schemas/src/index.ts";
import { DomainError, create, update, data } from "../shared.ts";
export async function reserve(
  tx: DbTx,
  scope: Scope,
  key: string,
  category: string,
  amount: number,
  policy: PolicyInput,
  now = new Date(),
  runKey = key,
) {
  if (now < new Date(policy.startAt) || now >= new Date(policy.endAt))
    throw new DomainError("PAID_MANDATE_EXPIRED");
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new DomainError("COST_ESTIMATE_REQUIRED");
  if (
    !policy.approvedPaidTests ||
    !policy.dailyBudgetMicros ||
    !policy.monthlyBudgetMicros ||
    amount > policy.perRunBudgetMicros
  )
    throw new DomainError("BUDGET_NOT_APPROVED");
  const qualified = scope.projectId + ":" + key;
  const existing = await tx.budgetReservation.findFirst({
    where: { key: qualified, projectId: scope.projectId },
  });
  if (existing) throw new DomainError("RESERVATION_ALREADY_USED", 409);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const rows = await tx.budgetReservation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: month },
      state: { not: "released" },
    },
  });
  const cost = (x: (typeof rows)[number]) =>
    Number(x.state === "settled" ? x.settledMicros : x.amountMicros);
  const monthly = rows.reduce((n, x) => n + cost(x), 0);
  const daily = rows
    .filter((x) => x.createdAt >= day)
    .reduce((n, x) => n + cost(x), 0);
  if (
    monthly + amount > policy.monthlyBudgetMicros ||
    daily + amount > policy.dailyBudgetMicros
  )
    throw new DomainError("BUDGET_EXCEEDED", 409);
  const run = await tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: "budget_runs",
      data: { path: ["runKey"], equals: runKey },
    },
  });
  const prior = run
    ? await tx.budgetReservation.findMany({
        where: {
          projectId: scope.projectId,
          id: { in: data(run).reservationIds },
          state: { not: "released" },
        },
      })
    : [];
  const runCost = prior.reduce(
    (n, r) =>
      n + Number(r.state === "settled" ? r.settledMicros : r.amountMicros),
    0,
  );
  if (runCost + amount > policy.perRunBudgetMicros)
    throw new DomainError("RUN_BUDGET_EXCEEDED", 409);
  const reservation = await tx.budgetReservation.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      key: qualified,
      category,
      amountMicros: BigInt(amount),
      state: "reserved",
    },
  });
  if (run)
    await update(tx, scope, run, {
      ...data(run),
      reservationIds: [...data(run).reservationIds, reservation.id],
    });
  else
    await create(tx, scope, "budget_runs", {
      runKey,
      reservationIds: [reservation.id],
    });
  return reservation;
}
export async function settle(
  tx: DbTx,
  scope: Scope,
  id: string,
  actual: number | null,
) {
  const row = await tx.budgetReservation.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("RESERVATION_MISSING");
  if (row.state === "settled") return row;
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0))
    throw new DomainError("INVALID_USAGE");
  return tx.budgetReservation.update({
    where: { id },
    data: {
      state: actual === null ? "unknown" : "settled",
      settledMicros: actual === null ? null : BigInt(actual),
    },
  });
}

export async function markTransmitted(tx: DbTx, scope: Scope, id: string) {
  const result = await tx.budgetReservation.updateMany({
    where: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      state: "reserved",
    },
    data: { state: "in_flight" },
  });
  if (result.count !== 1)
    throw new DomainError("PAID_CALL_ALREADY_STARTED", 409);
}

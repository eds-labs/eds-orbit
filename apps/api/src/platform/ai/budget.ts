import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError, create, update, data } from "../shared.ts";
import {
  passedLimitsAllowed,
  platformSpendLimits,
  type SpendLimits,
} from "./spend-mandate.ts";
import { assertProviderBudget } from "./provider-budget.ts";
import { chargedGrant, reserveOnGrant, settleOnGrant } from "./central-ai.ts";
import { runtimeProviderBudgets } from "./openai-configuration.ts";
/**
 * Start of the budget month that contains `at`: the first of the month at
 * 00:00 UTC. Project, assignment and reported month totals all count from it.
 */
export function budgetMonthStart(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
export async function reserve(
  tx: DbTx,
  scope: Scope,
  key: string,
  category: string,
  amount: number,
  // The spend mandate's limits; a full marketing policy fits as well.
  passed: SpendLimits,
  now = new Date(),
  runKey = key,
  attribution?: {
    agentRunId?: string | null;
    taskClass?: string;
    model?: string;
    missionId?: string | null;
  },
) {
  // The platform's spending authority wins over the limits a caller passed
  // (ADR 0015): Marketing callers still pass their own policy's budget,
  // which counts only in the rollback modes (plan 3.8).
  const platform = await platformSpendLimits(tx, scope);
  if (!platform && !passedLimitsAllowed())
    throw new DomainError("POLICY_REQUIRED");
  const policy = platform ?? passed;
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
  const month = budgetMonthStart(now);
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
  // The provider's credit budget (plan D-A6): a model of a provider with a
  // saved budget may not pass its stop threshold; PROVIDER_BUDGET_STOP.
  if (attribution?.model)
    await assertProviderBudget(tx, scope, attribution.model, amount, now);
  // A key from a granted central connection (ADR 0014) is also charged to
  // the grant's, the organization's and the connection's monthly budgets.
  const granted = attribution?.model
    ? await chargedGrant(
        tx,
        scope,
        attribution.model,
        (await runtimeProviderBudgets(tx, scope)).models as never,
      )
    : null;
  if (granted) await reserveOnGrant(tx, scope, granted, amount, month);
  const reservation = await tx.budgetReservation.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      key: qualified,
      category,
      amountMicros: BigInt(amount),
      state: "reserved",
      agentRunId: attribution?.agentRunId ?? null,
      taskClass: attribution?.taskClass ?? null,
      model: attribution?.model ?? null,
      missionId: attribution?.missionId ?? null,
      ...(granted
        ? {
            connectionId: granted.connection.id,
            grantId: granted.grant.id,
            parentGrantId: granted.parent?.id ?? null,
          }
        : {}),
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
  if (actual !== null) await settleOnGrant(tx, row, BigInt(actual));
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

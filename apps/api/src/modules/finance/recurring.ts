import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  allocationSchema,
  assertUnreferenced,
  assertUpdated,
  isoDate,
  versionField,
} from "./common.ts";
import { assertAllocationTargets } from "./cost-centers.ts";
import { CURRENCY_DECIMALS, isCurrency } from "./money.ts";

// Recurring costs: what is expected, how often, and how to recognise it.
// "Archiving" one switches it off (`active` false); it stays readable.

const micros = z.union([
  z.bigint().min(0n),
  z.string().regex(/^\d{1,18}$/).transform((text) => BigInt(text)),
]);

const matchSchema = z
  .object({ toleranceBp: z.number().int().min(0).max(10_000).optional() })
  .strict();

const fields = {
  name: z.string().trim().min(1).max(160),
  counterpartyId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  allocation: allocationSchema.nullable(),
  interval: z.enum(["monthly", "quarterly", "yearly"]),
  expectedAmountMicros: micros,
  currency: z.string().refine(isCurrency, "Unknown currency"),
  nextDueDate: isoDate,
  match: matchSchema.nullable(),
};

export const createRecurringInput = z
  .object({
    name: fields.name,
    counterpartyId: fields.counterpartyId.optional(),
    categoryId: fields.categoryId.optional(),
    allocation: fields.allocation.optional(),
    interval: fields.interval,
    expectedAmountMicros: fields.expectedAmountMicros,
    currency: fields.currency,
    nextDueDate: fields.nextDueDate,
    match: fields.match.optional(),
  })
  .strict();

export const updateRecurringInput = z
  .object({
    version: versionField,
    name: fields.name.optional(),
    counterpartyId: fields.counterpartyId.optional(),
    categoryId: fields.categoryId.optional(),
    allocation: fields.allocation.optional(),
    interval: fields.interval.optional(),
    expectedAmountMicros: fields.expectedAmountMicros.optional(),
    currency: fields.currency.optional(),
    nextDueDate: fields.nextDueDate.optional(),
    match: fields.match.optional(),
    active: z.boolean().optional(),
  })
  .strict();

const MONTHS = { monthly: 1n, quarterly: 3n, yearly: 12n } as const;

/**
 * What the recurring cost amounts to per month, rounded half-even to the
 * decimals of its currency (quarterly divided by 3, yearly by 12).
 */
export function monthlyEquivalent(r: {
  interval: string;
  expectedAmountMicros: bigint;
  currency: string;
}): bigint {
  if (!isCurrency(r.currency)) throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  const months = MONTHS[r.interval as keyof typeof MONTHS];
  if (!months) throw new DomainError("FINANCE_INTERVAL_INVALID", 422);
  // One rounding step from the exact quotient to whole currency units.
  const unit = 10n ** BigInt(6 - CURRENCY_DECIMALS[r.currency]);
  const divisor = months * unit;
  const quotient = r.expectedAmountMicros / divisor;
  const twice = (r.expectedAmountMicros % divisor) * 2n;
  const up = twice > divisor || (twice === divisor && quotient % 2n === 1n);
  return (up ? quotient + 1n : quotient) * unit;
}

async function load(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeRecurring.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

async function assertLinks(
  tx: DbTx,
  scope: Scope,
  links: { counterpartyId?: string | null; categoryId?: string | null },
) {
  if (
    links.counterpartyId &&
    !(await tx.financeCounterparty.findFirst({
      where: { id: links.counterpartyId, projectId: scope.projectId },
      select: { id: true },
    }))
  )
    throw new DomainError("FINANCE_COUNTERPARTY_INVALID", 422);
  if (
    links.categoryId &&
    !(await tx.financeCategory.findFirst({
      where: {
        id: links.categoryId,
        projectId: scope.projectId,
        archivedAt: null,
      },
      select: { id: true },
    }))
  )
    throw new DomainError("FINANCE_CATEGORY_INVALID", 422);
}

const json = (value: unknown) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

export function listRecurring(
  tx: DbTx,
  scope: Scope,
  options: { includeInactive?: boolean } = {},
) {
  return tx.financeRecurring.findMany({
    where: {
      projectId: scope.projectId,
      ...(options.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ nextDueDate: "asc" }, { name: "asc" }],
  });
}

export async function createRecurring(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createRecurringInput.parse(raw);
  await assertLinks(tx, scope, input);
  await assertAllocationTargets(tx, scope, input.allocation);
  const row = await tx.financeRecurring.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: input.name,
      counterpartyId: input.counterpartyId ?? null,
      categoryId: input.categoryId ?? null,
      allocation: input.allocation
        ? (input.allocation as Prisma.InputJsonValue)
        : undefined,
      interval: input.interval,
      expectedAmountMicros: input.expectedAmountMicros,
      currency: input.currency,
      nextDueDate: day(input.nextDueDate),
      match: input.match ? (input.match as Prisma.InputJsonValue) : undefined,
    },
  });
  await audit(tx, scope, "finance.recurring.created", row.id, {
    recurringId: row.id,
  });
  return row;
}

export async function updateRecurring(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, allocation, match, nextDueDate, ...changes } =
    updateRecurringInput.parse(raw);
  await load(tx, scope, id);
  await assertLinks(tx, scope, changes);
  await assertAllocationTargets(tx, scope, allocation);
  const result = await tx.financeRecurring.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: {
      ...changes,
      ...(allocation !== undefined ? { allocation: json(allocation) } : {}),
      ...(match !== undefined ? { match: json(match) } : {}),
      ...(nextDueDate !== undefined ? { nextDueDate: day(nextDueDate) } : {}),
      version: { increment: 1 },
    },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.recurring.updated", id, {
    recurringId: id,
    fields: Object.keys(raw as object).filter((key) => key !== "version"),
  });
  return load(tx, scope, id);
}

/** Switches the recurring cost off; it stays readable. */
export async function archiveRecurring(tx: DbTx, scope: Scope, id: string) {
  const row = await load(tx, scope, id);
  if (!row.active) return row;
  const result = await tx.financeRecurring.updateMany({
    where: { id, projectId: scope.projectId, active: true },
    data: { active: false, version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.recurring.archived", id, { recurringId: id });
  return load(tx, scope, id);
}

/** Hard delete, only for a recurring cost no invoice came from. */
export async function deleteRecurring(tx: DbTx, scope: Scope, id: string) {
  await load(tx, scope, id);
  assertUnreferenced([
    await tx.financeInvoice.count({
      where: { projectId: scope.projectId, recurringId: id },
    }),
  ]);
  await tx.financeRecurring.deleteMany({
    where: { id, projectId: scope.projectId },
  });
  await audit(tx, scope, "finance.recurring.deleted", id, { recurringId: id });
}

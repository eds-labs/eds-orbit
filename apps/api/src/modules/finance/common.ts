import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";

// Small helpers the master-data services share.

/** `YYYY-MM-DD` calendar date. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The row's version the caller read; a mismatch is a conflict. */
export const versionField = z.number().int().min(1);

/** Cost center split in basis points; the parts sum to 10000. */
export const allocationSchema = z
  .array(
    z
      .object({ costCenterId: z.uuid(), bp: z.number().int().min(0).max(10_000) })
      .strict(),
  )
  .min(1)
  .max(50)
  .refine(
    (parts) => parts.reduce((sum, part) => sum + part.bp, 0) === 10_000,
    "Allocation must sum to 10000 basis points",
  )
  .refine(
    (parts) => new Set(parts.map((p) => p.costCenterId)).size === parts.length,
    "Cost centers must be unique",
  );

/** Version-checked updates: zero rows changed means someone else saved first. */
export function assertUpdated(count: number) {
  if (count !== 1) throw new DomainError("VERSION_CONFLICT", 409);
}

/** Refuses a hard delete while anything references the row. */
export function assertUnreferenced(counts: number[]) {
  if (counts.some((count) => count > 0))
    throw new DomainError("FINANCE_IN_USE", 409);
}

// Guards for new postings (booking, payments, manual entries). Archived
// accounts, categories and cost centers take no new postings and answer
// 409 FINANCE_ACCOUNT_ARCHIVED; reversals do not go through these guards,
// so an archived account's earlier postings can still be reversed.

const archived = () => new DomainError("FINANCE_ACCOUNT_ARCHIVED", 409);

/**
 * A live payment account (bank, card or wallet) of the project; an account
 * bound to a currency only takes postings in that currency.
 */
export async function livePaymentAccount(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  id: string,
  currency: string,
) {
  const account = await tx.financeAccount.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!account) throw new DomainError("FINANCE_ACCOUNT_INVALID", 422);
  if (account.archivedAt) throw archived();
  if (!account.paymentAccount)
    throw new DomainError("FINANCE_ACCOUNT_INVALID", 422);
  if (account.currency && account.currency !== currency)
    throw new DomainError("FINANCE_ACCOUNT_CURRENCY_MISMATCH", 422);
  return account;
}

/** Every account exists in the project and is live. */
export async function assertLiveAccounts(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  ids: string[],
) {
  const unique = [...new Set(ids)];
  const rows = await tx.financeAccount.findMany({
    where: { projectId: scope.projectId, id: { in: unique } },
    select: { archivedAt: true },
  });
  if (rows.length !== unique.length)
    throw new DomainError("FINANCE_ACCOUNT_INVALID", 422);
  if (rows.some((row) => row.archivedAt)) throw archived();
}

/**
 * The live categories by id with the account each posts to; the account
 * must be live too.
 */
export async function liveCategories(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  ids: string[],
) {
  const unique = [...new Set(ids)];
  const rows = await tx.financeCategory.findMany({
    where: { projectId: scope.projectId, id: { in: unique } },
    select: { id: true, kind: true, accountId: true, archivedAt: true },
  });
  if (rows.length !== unique.length)
    throw new DomainError("FINANCE_CATEGORY_INVALID", 422);
  if (rows.some((row) => row.archivedAt)) throw archived();
  await assertLiveAccounts(
    tx,
    scope,
    rows.map((row) => row.accountId),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every cost center exists in the project and is live. */
export async function assertLiveCostCenters(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  ids: string[],
) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await tx.financeCostCenter.findMany({
    where: { projectId: scope.projectId, id: { in: unique } },
    select: { archivedAt: true },
  });
  if (rows.length !== unique.length)
    throw new DomainError("ALLOCATION_INVALID", 422);
  if (rows.some((row) => row.archivedAt)) throw archived();
}

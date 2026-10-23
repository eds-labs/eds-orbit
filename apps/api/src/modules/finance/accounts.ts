import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { assertUnreferenced, assertUpdated, versionField } from "./common.ts";
import { SYSTEM_ROLES } from "./ledger/accounts.ts";
import { isCurrency } from "./money.ts";

// The chart of accounts. The code and the type of an account never change
// once created: posted lines depend on what an account is.

const fields = {
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  role: z.enum(SYSTEM_ROLES).nullable(),
  paymentAccount: z.boolean(),
  currency: z.string().refine(isCurrency, "Unknown currency").nullable(),
  externalCode: z.string().trim().min(1).max(40).nullable(),
};

export const createAccountInput = z
  .object({
    code: fields.code,
    name: fields.name,
    type: fields.type,
    role: fields.role.optional(),
    paymentAccount: fields.paymentAccount.optional(),
    currency: fields.currency.optional(),
    externalCode: fields.externalCode.optional(),
  })
  .strict();

export const updateAccountInput = z
  .object({
    version: versionField,
    name: fields.name.optional(),
    paymentAccount: fields.paymentAccount.optional(),
    currency: fields.currency.optional(),
    externalCode: fields.externalCode.optional(),
  })
  .strict();

async function load(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeAccount.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export function listAccounts(
  tx: DbTx,
  scope: Scope,
  options: { includeArchived?: boolean } = {},
) {
  return tx.financeAccount.findMany({
    where: {
      projectId: scope.projectId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { code: "asc" },
  });
}

export async function createAccount(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createAccountInput.parse(raw);
  if (
    await tx.financeAccount.findFirst({
      where: { projectId: scope.projectId, code: input.code },
      select: { id: true },
    })
  )
    throw new DomainError("FINANCE_DUPLICATE", 409);
  if (
    input.role &&
    (await tx.financeAccount.findFirst({
      where: { projectId: scope.projectId, role: input.role, archivedAt: null },
      select: { id: true },
    }))
  )
    throw new DomainError("FINANCE_ROLE_TAKEN", 409);
  const row = await tx.financeAccount.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...input,
    },
  });
  await audit(tx, scope, "finance.account.created", row.id, {
    accountId: row.id,
  });
  return row;
}

export async function updateAccount(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, ...changes } = updateAccountInput.parse(raw);
  await load(tx, scope, id);
  const result = await tx.financeAccount.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: { ...changes, version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.account.updated", id, {
    accountId: id,
    fields: Object.keys(changes),
  });
  return load(tx, scope, id);
}

/** Archived accounts stay readable and keep their history. */
export async function archiveAccount(tx: DbTx, scope: Scope, id: string) {
  const row = await load(tx, scope, id);
  if (row.archivedAt) return row;
  const result = await tx.financeAccount.updateMany({
    where: { id, projectId: scope.projectId, archivedAt: null },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.account.archived", id, { accountId: id });
  return load(tx, scope, id);
}

/** Hard delete, only for an account nothing references. */
export async function deleteAccount(tx: DbTx, scope: Scope, id: string) {
  await load(tx, scope, id);
  const where = { projectId: scope.projectId };
  assertUnreferenced([
    await tx.financeJournalLine.count({ where: { ...where, accountId: id } }),
    await tx.financeCategory.count({ where: { ...where, accountId: id } }),
    await tx.financePayment.count({ where: { ...where, accountId: id } }),
  ]);
  await tx.financeAccount.deleteMany({ where: { id, ...where } });
  await audit(tx, scope, "finance.account.deleted", id, { accountId: id });
}

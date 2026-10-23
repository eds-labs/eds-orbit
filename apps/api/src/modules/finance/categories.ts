import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { assertUnreferenced, assertUpdated, versionField } from "./common.ts";

// Categories group income and expenses; each posts to one account of its
// own kind. A name is unique per kind among live categories.

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["income", "expense"]),
  parentId: z.uuid().nullable(),
  accountId: z.uuid(),
};

export const createCategoryInput = z
  .object({
    name: fields.name,
    kind: fields.kind,
    parentId: fields.parentId.optional(),
    accountId: fields.accountId,
  })
  .strict();

export const updateCategoryInput = z
  .object({
    version: versionField,
    name: fields.name.optional(),
    parentId: fields.parentId.optional(),
    accountId: fields.accountId.optional(),
  })
  .strict();

async function load(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeCategory.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

/** The account must be a live account of the category's kind. */
async function assertAccount(
  tx: DbTx,
  scope: Scope,
  kind: string,
  accountId: string,
) {
  const account = await tx.financeAccount.findFirst({
    where: { id: accountId, projectId: scope.projectId, archivedAt: null },
    select: { type: true },
  });
  if (!account || account.type !== kind)
    throw new DomainError("FINANCE_ACCOUNT_INVALID", 422);
}

/** The parent must be a live category of the same kind, and no cycle. */
async function assertParent(
  tx: DbTx,
  scope: Scope,
  kind: string,
  parentId: string,
  selfId?: string,
) {
  let current: string | null = parentId;
  for (let depth = 0; current && depth < 50; depth += 1) {
    if (current === selfId) throw new DomainError("FINANCE_PARENT_INVALID", 422);
    const parent: { kind: string; parentId: string | null; archivedAt: Date | null } | null =
      await tx.financeCategory.findFirst({
        where: { id: current, projectId: scope.projectId },
        select: { kind: true, parentId: true, archivedAt: true },
      });
    if (!parent || parent.kind !== kind || (depth === 0 && parent.archivedAt))
      throw new DomainError("FINANCE_PARENT_INVALID", 422);
    current = parent.parentId;
  }
}

export function listCategories(
  tx: DbTx,
  scope: Scope,
  options: { includeArchived?: boolean } = {},
) {
  return tx.financeCategory.findMany({
    where: {
      projectId: scope.projectId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}

export async function createCategory(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createCategoryInput.parse(raw);
  if (
    await tx.financeCategory.findFirst({
      where: {
        projectId: scope.projectId,
        name: input.name,
        kind: input.kind,
        archivedAt: null,
      },
      select: { id: true },
    })
  )
    throw new DomainError("FINANCE_DUPLICATE", 409);
  await assertAccount(tx, scope, input.kind, input.accountId);
  if (input.parentId)
    await assertParent(tx, scope, input.kind, input.parentId);
  const row = await tx.financeCategory.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...input,
    },
  });
  await audit(tx, scope, "finance.category.created", row.id, {
    categoryId: row.id,
  });
  return row;
}

export async function updateCategory(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, ...changes } = updateCategoryInput.parse(raw);
  const row = await load(tx, scope, id);
  if (
    changes.name !== undefined &&
    changes.name !== row.name &&
    (await tx.financeCategory.findFirst({
      where: {
        projectId: scope.projectId,
        name: changes.name,
        kind: row.kind,
        archivedAt: null,
        id: { not: id },
      },
      select: { id: true },
    }))
  )
    throw new DomainError("FINANCE_DUPLICATE", 409);
  if (changes.accountId)
    await assertAccount(tx, scope, row.kind, changes.accountId);
  if (changes.parentId)
    await assertParent(tx, scope, row.kind, changes.parentId, id);
  const result = await tx.financeCategory.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: { ...changes, version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.category.updated", id, {
    categoryId: id,
    fields: Object.keys(changes),
  });
  return load(tx, scope, id);
}

export async function archiveCategory(tx: DbTx, scope: Scope, id: string) {
  const row = await load(tx, scope, id);
  if (row.archivedAt) return row;
  const result = await tx.financeCategory.updateMany({
    where: { id, projectId: scope.projectId, archivedAt: null },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.category.archived", id, { categoryId: id });
  return load(tx, scope, id);
}

/** Hard delete, only for a category nothing references. */
export async function deleteCategory(tx: DbTx, scope: Scope, id: string) {
  await load(tx, scope, id);
  const where = { projectId: scope.projectId };
  assertUnreferenced([
    await tx.financeJournalLine.count({ where: { ...where, categoryId: id } }),
    await tx.financeInvoiceLine.count({ where: { ...where, categoryId: id } }),
    await tx.financeRecurring.count({ where: { ...where, categoryId: id } }),
    await tx.financeCategory.count({ where: { ...where, parentId: id } }),
    await tx.financeCounterparty.count({
      where: { ...where, defaultCategoryId: id },
    }),
  ]);
  await tx.financeCategory.deleteMany({ where: { id, ...where } });
  await audit(tx, scope, "finance.category.deleted", id, { categoryId: id });
}

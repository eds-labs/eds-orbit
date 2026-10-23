import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  allocationSchema,
  assertUnreferenced,
  assertUpdated,
  versionField,
} from "./common.ts";
import { assertAllocationTargets } from "./cost-centers.ts";

// Counterparties (vendors and customers). They have no archive state: a
// counterparty stays readable for as long as anything refers to it, and a
// hard delete is refused while anything does.

const LEGAL_SUFFIXES = new Set(["inc", "llc", "ltd", "gmbh", "ag", "bv", "sa"]);

/**
 * The key counterparties are matched by: lowercase, no legal suffix
 * (`inc`, `llc`, `ltd`, `gmbh`, `ag`, `bv`, `sa`), no punctuation or
 * whitespace. "OpenAI, L.L.C." becomes "openai".
 */
export function normalizeCounterpartyName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!))
    tokens.pop();
  return tokens.join("");
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "Invalid domain");

const fields = {
  name: z.string().trim().min(1).max(160),
  taxId: z.string().trim().min(1).max(40).nullable(),
  emailDomains: z
    .array(domain)
    .max(20)
    .refine((d) => new Set(d).size === d.length, "Domains must be unique"),
  defaultCategoryId: z.uuid().nullable(),
  defaultAllocation: allocationSchema.nullable(),
};

export const createCounterpartyInput = z
  .object({
    name: fields.name,
    taxId: fields.taxId.optional(),
    emailDomains: fields.emailDomains.optional(),
    defaultCategoryId: fields.defaultCategoryId.optional(),
    defaultAllocation: fields.defaultAllocation.optional(),
  })
  .strict();

export const updateCounterpartyInput = z
  .object({
    version: versionField,
    name: fields.name.optional(),
    taxId: fields.taxId.optional(),
    emailDomains: fields.emailDomains.optional(),
    defaultCategoryId: fields.defaultCategoryId.optional(),
    defaultAllocation: fields.defaultAllocation.optional(),
  })
  .strict();

async function load(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeCounterparty.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

async function assertCategory(tx: DbTx, scope: Scope, id: string | null | undefined) {
  if (!id) return;
  const found = await tx.financeCategory.findFirst({
    where: { id, projectId: scope.projectId, archivedAt: null },
    select: { id: true },
  });
  if (!found) throw new DomainError("FINANCE_CATEGORY_INVALID", 422);
}

const json = (value: unknown) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

export function listCounterparties(tx: DbTx, scope: Scope) {
  return tx.financeCounterparty.findMany({
    where: { projectId: scope.projectId },
    orderBy: { normalizedName: "asc" },
  });
}

export async function createCounterparty(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createCounterpartyInput.parse(raw);
  const normalizedName = normalizeCounterpartyName(input.name);
  if (!normalizedName) throw new DomainError("FINANCE_NAME_INVALID", 422);
  await assertCategory(tx, scope, input.defaultCategoryId);
  await assertAllocationTargets(tx, scope, input.defaultAllocation);
  const row = await tx.financeCounterparty.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: input.name,
      normalizedName,
      taxId: input.taxId ?? null,
      emailDomains: input.emailDomains ?? [],
      defaultCategoryId: input.defaultCategoryId ?? null,
      defaultAllocation: input.defaultAllocation
        ? (input.defaultAllocation as Prisma.InputJsonValue)
        : undefined,
    },
  });
  await audit(tx, scope, "finance.counterparty.created", row.id, {
    counterpartyId: row.id,
  });
  return row;
}

export async function updateCounterparty(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, defaultAllocation, ...changes } =
    updateCounterpartyInput.parse(raw);
  await load(tx, scope, id);
  await assertCategory(tx, scope, changes.defaultCategoryId);
  await assertAllocationTargets(tx, scope, defaultAllocation);
  let normalizedName: string | undefined;
  if (changes.name !== undefined) {
    normalizedName = normalizeCounterpartyName(changes.name);
    if (!normalizedName) throw new DomainError("FINANCE_NAME_INVALID", 422);
  }
  const result = await tx.financeCounterparty.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: {
      ...changes,
      ...(normalizedName ? { normalizedName } : {}),
      ...(defaultAllocation !== undefined
        ? { defaultAllocation: json(defaultAllocation) }
        : {}),
      version: { increment: 1 },
    },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.counterparty.updated", id, {
    counterpartyId: id,
    fields: Object.keys(raw as object).filter((key) => key !== "version"),
  });
  return load(tx, scope, id);
}

/** Hard delete, only for a counterparty nothing references. */
export async function deleteCounterparty(tx: DbTx, scope: Scope, id: string) {
  await load(tx, scope, id);
  const where = { projectId: scope.projectId, counterpartyId: id };
  assertUnreferenced([
    await tx.financeInvoice.count({ where }),
    await tx.financePayment.count({ where }),
    await tx.financeRecurring.count({ where }),
  ]);
  await tx.financeCounterparty.deleteMany({
    where: { id, projectId: scope.projectId },
  });
  await audit(tx, scope, "finance.counterparty.deleted", id, {
    counterpartyId: id,
  });
}

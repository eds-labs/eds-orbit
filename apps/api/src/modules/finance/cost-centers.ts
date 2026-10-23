import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { assertUnreferenced, assertUpdated, versionField } from "./common.ts";

// Cost centers label spending. A cost center may name an Orbit project of
// the same workspace as a label only; it is not a data link.

const fields = {
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  orbitProjectId: z.uuid().nullable(),
};

export const createCostCenterInput = z
  .object({
    code: fields.code,
    name: fields.name,
    orbitProjectId: fields.orbitProjectId.optional(),
  })
  .strict();

export const updateCostCenterInput = z
  .object({
    version: versionField,
    name: fields.name.optional(),
    orbitProjectId: fields.orbitProjectId.optional(),
  })
  .strict();

async function load(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeCostCenter.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

/**
 * Orbit projects of the workspace are outside this project's row scope, so
 * the check reads them with the control-plane client, filtered to the
 * caller's workspace (the same pattern other platform code uses).
 */
async function assertOrbitProject(scope: Scope, orbitProjectId: string) {
  const found = await authDb.project.findFirst({
    where: { id: orbitProjectId, workspaceId: scope.workspaceId },
    select: { id: true },
  });
  if (!found) throw new DomainError("ORBIT_PROJECT_INVALID", 422);
}

export function listCostCenters(
  tx: DbTx,
  scope: Scope,
  options: { includeArchived?: boolean } = {},
) {
  return tx.financeCostCenter.findMany({
    where: {
      projectId: scope.projectId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { code: "asc" },
  });
}

export async function createCostCenter(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createCostCenterInput.parse(raw);
  if (
    await tx.financeCostCenter.findFirst({
      where: { projectId: scope.projectId, code: input.code },
      select: { id: true },
    })
  )
    throw new DomainError("FINANCE_DUPLICATE", 409);
  if (input.orbitProjectId) await assertOrbitProject(scope, input.orbitProjectId);
  const row = await tx.financeCostCenter.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...input,
    },
  });
  await audit(tx, scope, "finance.cost_center.created", row.id, {
    costCenterId: row.id,
  });
  return row;
}

export async function updateCostCenter(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, ...changes } = updateCostCenterInput.parse(raw);
  await load(tx, scope, id);
  if (changes.orbitProjectId)
    await assertOrbitProject(scope, changes.orbitProjectId);
  const result = await tx.financeCostCenter.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: { ...changes, version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.cost_center.updated", id, {
    costCenterId: id,
    fields: Object.keys(changes),
  });
  return load(tx, scope, id);
}

export async function archiveCostCenter(tx: DbTx, scope: Scope, id: string) {
  const row = await load(tx, scope, id);
  if (row.archivedAt) return row;
  const result = await tx.financeCostCenter.updateMany({
    where: { id, projectId: scope.projectId, archivedAt: null },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  assertUpdated(result.count);
  await audit(tx, scope, "finance.cost_center.archived", id, {
    costCenterId: id,
  });
  return load(tx, scope, id);
}

/** Hard delete, only for a cost center nothing references. */
export async function deleteCostCenter(tx: DbTx, scope: Scope, id: string) {
  await load(tx, scope, id);
  const where = { projectId: scope.projectId };
  const inAllocation = (column: "defaultAllocation" | "allocation") => ({
    ...where,
    [column]: { array_contains: [{ costCenterId: id }] },
  });
  assertUnreferenced([
    await tx.financeJournalLine.count({ where: { ...where, costCenterId: id } }),
    await tx.financeCounterparty.count({
      where: inAllocation("defaultAllocation"),
    }),
    await tx.financeRecurring.count({ where: inAllocation("allocation") }),
    await tx.financeInvoiceLine.count({ where: inAllocation("allocation") }),
  ]);
  await tx.financeCostCenter.deleteMany({ where: { id, ...where } });
  await audit(tx, scope, "finance.cost_center.deleted", id, {
    costCenterId: id,
  });
}

/** Every cost center of an allocation must be a live one of this project. */
export async function assertAllocationTargets(
  tx: DbTx,
  scope: Scope,
  allocation: { costCenterId: string }[] | null | undefined,
) {
  if (!allocation) return;
  const ids = allocation.map((part) => part.costCenterId);
  const live = await tx.financeCostCenter.count({
    where: { projectId: scope.projectId, id: { in: ids }, archivedAt: null },
  });
  if (live !== ids.length) throw new DomainError("ALLOCATION_INVALID", 422);
}

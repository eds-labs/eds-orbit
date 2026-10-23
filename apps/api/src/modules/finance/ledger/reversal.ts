import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import { insertEntry, isoDate } from "./post.ts";
import type { DraftLine, RateSource, Side } from "./posting.ts";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * Reverses a posted entry (spec §7, corrections): a new `reversal` entry
 * with every line's side swapped and the same amounts, rates and base
 * amounts, then the original records `reversedById`. The reason becomes the
 * reversal's memo and stays out of the audit trail. `entryDate` defaults to
 * today (UTC) and may not precede the original. Call inside `scoped()`.
 *
 * Throws 404 FINANCE_ENTRY_NOT_FOUND, 409 FINANCE_REVERSAL_NOT_REVERSIBLE
 * for a reversal, 409 FINANCE_ALREADY_REVERSED for an entry reversed before.
 */
export async function reverseEntry(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId" | "userId">,
  entryId: string,
  reason: string,
  entryDate: string = new Date().toISOString().slice(0, 10),
): Promise<{ id: string; number: string }> {
  const memo = reason.trim();
  if (!memo) throw new DomainError("FINANCE_REASON_REQUIRED", 422);
  const original = UUID.test(entryId)
    ? await tx.financeJournalEntry.findFirst({
        where: { projectId: scope.projectId, id: entryId },
      })
    : null;
  if (!original) throw new DomainError("FINANCE_ENTRY_NOT_FOUND", 404);
  if (original.kind === "reversal")
    throw new DomainError("FINANCE_REVERSAL_NOT_REVERSIBLE", 409);
  if (original.reversedById) throw new DomainError("FINANCE_ALREADY_REVERSED", 409);
  if (isoDate(entryDate) < original.entryDate)
    throw new DomainError("FINANCE_DATE_INVALID", 422);

  const rows = await tx.financeJournalLine.findMany({
    where: { projectId: scope.projectId, entryId: original.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const lines: DraftLine[] = rows.map((row) => ({
    accountId: row.accountId,
    side: (row.side === "debit" ? "credit" : "debit") as Side,
    currency: row.currency,
    amountMicros: row.amountMicros,
    fxRate: row.fxRate.toFixed(),
    rateDate: row.rateDate.toISOString().slice(0, 10),
    rateSource: row.rateSource as RateSource,
    baseAmountMicros: row.baseAmountMicros,
    ...(row.categoryId ? { categoryId: row.categoryId } : {}),
    ...(row.costCenterId ? { costCenterId: row.costCenterId } : {}),
  }));
  const reversal = await insertEntry(tx, scope, {
    kind: "reversal",
    entryDate,
    memo,
    reversalOfId: original.id,
    lines,
  });
  await tx.financeJournalEntry.update({
    where: { id: original.id },
    data: { reversedById: reversal.id },
  });
  await audit(tx, scope, "finance.entry.reversed", reversal.id, {
    kind: "reversal",
    lines: lines.length,
    reversalOfId: original.id,
  });
  return reversal;
}

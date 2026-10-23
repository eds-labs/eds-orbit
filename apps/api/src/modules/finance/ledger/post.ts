import { randomUUID } from "node:crypto";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import { assertBalanced } from "./invariants.ts";
import type { DraftLine } from "./posting.ts";

/** Entry kinds `postEntry` accepts; reversals go through `reverseEntry`. */
export type EntryKind =
  | "invoice"
  | "credit_note"
  | "receipt"
  | "payment"
  | "income"
  | "expense"
  | "contribution"
  | "withdrawal"
  | "transfer"
  | "adjustment";

export type PostEntryInput = {
  kind: EntryKind;
  /** ISO date `YYYY-MM-DD`; its year picks the number sequence. */
  entryDate: string;
  memo?: string;
  documentId?: string;
  sourceType?: string;
  sourceId?: string;
  lines: DraftLine[];
};

type Poster = Pick<Scope, "workspaceId" | "projectId" | "userId">;

const ENTRY_KINDS = new Set<string>([
  "invoice",
  "credit_note",
  "receipt",
  "payment",
  "income",
  "expense",
  "contribution",
  "withdrawal",
  "transfer",
  "adjustment",
]);

/** Parses an ISO calendar date (`YYYY-MM-DD`) to UTC midnight. */
export function isoDate(text: string): Date {
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  )
    throw new DomainError("FINANCE_DATE_INVALID", 422);
  return date;
}

/**
 * The next number of the project's sequence for `year`, `YYYY-000001`.
 * One atomic upsert on "FinanceEntryCounter" ("next" is the next free
 * number); the project advisory lock of `scoped()` serializes postings, and
 * a rolled back posting rolls its increment back, so numbers have no gaps.
 */
async function nextNumber(tx: DbTx, scope: Poster, year: number) {
  const rows = await tx.$queryRaw<{ number: number }[]>`
    INSERT INTO "FinanceEntryCounter" ("workspaceId", "projectId", "year", "next")
    VALUES (${scope.workspaceId}::uuid, ${scope.projectId}::uuid, ${year}, 2)
    ON CONFLICT ("projectId", "year")
      DO UPDATE SET "next" = "FinanceEntryCounter"."next" + 1
    RETURNING "next" - 1 AS "number"`;
  const number = Number(rows[0]!.number);
  if (number > 999_999) throw new DomainError("FINANCE_NUMBER_EXHAUSTED", 409);
  return `${year}-${String(number).padStart(6, "0")}`;
}

/**
 * Inserts a balanced entry and its lines, shared by `postEntry` and
 * `reverseEntry`. The lines follow the entry in a separate statement: the
 * database accepts lines only for an entry inserted earlier in the same
 * transaction.
 */
export async function insertEntry(
  tx: DbTx,
  scope: Poster,
  input: Omit<PostEntryInput, "kind"> & {
    kind: EntryKind | "reversal";
    reversalOfId?: string;
  },
): Promise<{ id: string; number: string }> {
  assertBalanced(input.lines);
  const entryDate = isoDate(input.entryDate);
  const lines = input.lines.map((line) => ({
    ...line,
    rateDate: isoDate(line.rateDate),
  }));
  const number = await nextNumber(tx, scope, entryDate.getUTCFullYear());
  const id = randomUUID();
  await tx.financeJournalEntry.create({
    data: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      number,
      entryDate,
      kind: input.kind,
      memo: input.memo ?? null,
      documentId: input.documentId ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      postedBy: scope.userId,
    },
  });
  await tx.financeJournalLine.createMany({
    data: lines.map((line) => ({
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      entryId: id,
      accountId: line.accountId,
      side: line.side,
      currency: line.currency,
      amountMicros: line.amountMicros,
      fxRate: line.fxRate,
      rateDate: line.rateDate,
      rateSource: line.rateSource,
      baseAmountMicros: line.baseAmountMicros,
      categoryId: line.categoryId ?? null,
      costCenterId: line.costCenterId ?? null,
    })),
  });
  return { id, number };
}

/**
 * Posts a balanced journal entry with the next gap-free number of its
 * year. Call inside `scoped()`; every journal write goes through here or
 * `reverseEntry`. Audits `finance.entry.posted` with the kind and line
 * count only.
 */
export async function postEntry(
  tx: DbTx,
  scope: Poster,
  input: PostEntryInput,
): Promise<{ id: string; number: string }> {
  if (!ENTRY_KINDS.has(input.kind))
    throw new DomainError("FINANCE_ENTRY_KIND_INVALID", 422);
  const entry = await insertEntry(tx, scope, input);
  await audit(tx, scope, "finance.entry.posted", entry.id, {
    kind: input.kind,
    lines: input.lines.length,
  });
  return entry;
}

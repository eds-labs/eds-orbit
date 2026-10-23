import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  assertLiveAccounts,
  assertLiveCostCenters,
  isoDate,
  liveCategories,
  livePaymentAccount,
} from "./common.ts";
import { rateFor } from "./fx.ts";
import { systemAccounts } from "./ledger/accounts.ts";
import { postEntry } from "./ledger/post.ts";
import { postingLines, type PostingInput, type Rate } from "./ledger/posting.ts";
import { CURRENCY_DECIMALS, parseAmount } from "./money.ts";
import { readFinanceSettings } from "./settings.ts";

// Entries a person posts without a document (spec §7): owner contributions
// and withdrawals, transfers between payment accounts and free adjustments.

/** A decimal amount in the entry currency, parsed by parseAmount. */
const amount = z.string().trim().min(1).max(32);

const shared = {
  date: isoDate,
  currency: z.string(),
  memo: z.string().trim().min(1).max(500).optional(),
  /** Base per unit of `currency`, when no stored rate exists for `date`. */
  rateOverride: z.string().optional(),
};

const ownerMove = (kind: "contribution" | "withdrawal") =>
  z
    .object({ kind: z.literal(kind), accountId: z.uuid(), amount, ...shared })
    .strict();

export const manualEntryInput = z.discriminatedUnion("kind", [
  ownerMove("contribution"),
  ownerMove("withdrawal"),
  z
    .object({
      kind: z.literal("transfer"),
      fromAccountId: z.uuid(),
      toAccountId: z.uuid(),
      amount,
      ...shared,
    })
    .strict(),
  z
    .object({
      kind: z.literal("adjustment"),
      lines: z
        .array(
          z
            .object({
              accountId: z.uuid(),
              side: z.enum(["debit", "credit"]),
              amount,
              categoryId: z.uuid().optional(),
              costCenterId: z.uuid().optional(),
            })
            .strict(),
        )
        .min(2)
        .max(100),
      ...shared,
    })
    .strict(),
]);

export type ManualEntryInput = z.input<typeof manualEntryInput>;

/**
 * Posts a manual entry at the rate of its date. Contributions and
 * withdrawals move a payment account against the owner accounts, a
 * transfer moves money between two payment accounts, and an adjustment
 * posts free lines that must balance in its currency (422
 * FINANCE_ENTRY_UNBALANCED). Archived accounts, categories and cost
 * centers are refused (409 FINANCE_ACCOUNT_ARCHIVED). The memo is stored
 * on the entry only; the audit names the kind. Call inside `scoped()`.
 */
export async function postManualEntry(
  tx: DbTx,
  scope: Scope,
  raw: ManualEntryInput,
): Promise<{ entryId: string; number: string }> {
  const input = manualEntryInput.parse(raw);
  const { settings } = await readFinanceSettings(tx, scope);
  const { currency } = input;
  if (!(settings.currencies as string[]).includes(currency))
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  const currencies = { currency, baseCurrency: settings.baseCurrency };

  let posting: PostingInput;
  switch (input.kind) {
    case "contribution":
    case "withdrawal":
      await livePaymentAccount(tx, scope, input.accountId, currency);
      posting = {
        ...currencies,
        kind: input.kind,
        paymentAccountId: input.accountId,
        amountMicros: parseAmount(input.amount, currency),
      };
      break;
    case "transfer":
      if (input.fromAccountId === input.toAccountId)
        throw new DomainError("FINANCE_TRANSFER_INVALID", 422);
      await livePaymentAccount(tx, scope, input.fromAccountId, currency);
      await livePaymentAccount(tx, scope, input.toAccountId, currency);
      posting = {
        ...currencies,
        kind: "transfer",
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amountMicros: parseAmount(input.amount, currency),
      };
      break;
    case "adjustment": {
      await assertLiveAccounts(
        tx,
        scope,
        input.lines.map((line) => line.accountId),
      );
      const categoryIds = input.lines.flatMap((line) =>
        line.categoryId ? [line.categoryId] : [],
      );
      if (categoryIds.length) await liveCategories(tx, scope, categoryIds);
      await assertLiveCostCenters(
        tx,
        scope,
        input.lines.flatMap((line) => (line.costCenterId ? [line.costCenterId] : [])),
      );
      posting = {
        ...currencies,
        kind: "adjustment",
        lines: input.lines.map((line) => ({
          accountId: line.accountId,
          side: line.side,
          amountMicros: parseAmount(line.amount, currency),
          ...(line.categoryId ? { categoryId: line.categoryId } : {}),
          ...(line.costCenterId ? { costCenterId: line.costCenterId } : {}),
        })),
      };
      break;
    }
  }

  const override: Rate | undefined = input.rateOverride
    ? { rate: input.rateOverride, rateDate: input.date, source: "manual" }
    : undefined;
  const rate = await rateFor(
    tx,
    scope,
    currency,
    settings.baseCurrency,
    input.date,
    override,
  );
  const lines = postingLines(
    posting,
    await systemAccounts(tx, scope),
    rate,
    CURRENCY_DECIMALS[settings.baseCurrency],
  );
  const entry = await postEntry(tx, scope, {
    kind: input.kind,
    entryDate: input.date,
    ...(input.memo ? { memo: input.memo } : {}),
    sourceType: "manual",
    lines,
  });
  await audit(tx, scope, "finance.entry.manual", entry.id, { kind: input.kind });
  return { entryId: entry.id, number: entry.number };
}

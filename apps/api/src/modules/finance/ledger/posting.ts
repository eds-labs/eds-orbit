import { DomainError } from "../../../shared.ts";
import {
  CURRENCY_DECIMALS,
  convert,
  isCurrency,
  splitByBasisPoints,
} from "../money.ts";
import type { SystemAccounts } from "./accounts.ts";

// The posting rules of spec §7 as pure functions: a business transaction in
// one currency becomes balanced journal lines in that currency and in the
// base currency. Nothing here reads the database; the caller supplies the
// system accounts and the rate (Task 9 looks rates up).

export type Side = "debit" | "credit";
export type RateSource = "ecb" | "manual" | "document" | "peg" | "identity";

/**
 * Base currency per unit of the transaction currency, as a decimal string
 * (at most 12 fraction digits), with the date it is for and its source.
 */
export type Rate = { rate: string; rateDate: string; source: RateSource };

/** A journal line before insert. Amounts are positive; the side is the sign. */
export type DraftLine = {
  accountId: string;
  side: Side;
  currency: string;
  amountMicros: bigint;
  fxRate: string;
  /** ISO date `YYYY-MM-DD`. */
  rateDate: string;
  rateSource: RateSource;
  baseAmountMicros: bigint;
  categoryId?: string;
  costCenterId?: string;
};

/** Cost center basis points summing to 10000; empty for no cost center. */
export type Allocation = { costCenterId: string; bp: number }[];

/** An invoice, credit note or receipt line. Its gross is amount + tax. */
export type DocumentLine = {
  amountMicros: bigint;
  taxMicros: bigint;
  /** The income or expense account the line's category posts to. */
  categoryAccountId: string;
  categoryId: string;
  allocation: Allocation;
};

/**
 * One invoice a payment settles, in the payment's currency (Phase 1 pays an
 * invoice in its own currency). `invoiceBaseMicros` is the invoice's base
 * amount for `invoiceTotalMicros`; the allocated part of it is pro-rated.
 * To clear an invoice exactly over several partial payments, pass its open
 * amount and open base as total and base.
 */
export type PaymentAllocation = {
  amountMicros: bigint;
  invoiceTotalMicros: bigint;
  invoiceBaseMicros: bigint;
  /** The rate the invoice was posted at, recorded on the settling line. */
  invoiceRate: Rate;
};

/** A free line of a manual adjustment. */
export type AdjustmentLine = {
  accountId: string;
  side: Side;
  amountMicros: bigint;
  categoryId?: string;
  costCenterId?: string;
};

type Currencies = { currency: string; baseCurrency: string };
type DocumentInput = Currencies & {
  direction: "payable" | "receivable";
  lines: DocumentLine[];
};

export type PostingInput =
  | (DocumentInput & { kind: "invoice" | "credit_note" })
  | (DocumentInput & { kind: "receipt"; paymentAccountId: string })
  | (Currencies & {
      kind: "payment";
      direction: "outgoing" | "incoming";
      paymentAccountId: string;
      allocations: PaymentAllocation[];
    })
  | (Currencies & {
      kind: "contribution" | "withdrawal";
      paymentAccountId: string;
      amountMicros: bigint;
    })
  | (Currencies & {
      kind: "transfer";
      fromAccountId: string;
      toAccountId: string;
      amountMicros: bigint;
    })
  | (Currencies & { kind: "adjustment"; lines: AdjustmentLine[] });

const MICRO_DIGITS = 6;
const flip = (side: Side): Side => (side === "debit" ? "credit" : "debit");
const abs = (value: bigint) => (value < 0n ? -value : value);
const sumBy = (lines: DraftLine[], side: Side) =>
  lines
    .filter((line) => line.side === side)
    .reduce((acc, line) => acc + line.baseAmountMicros, 0n);

const positive = (micros: bigint) => {
  if (micros <= 0n) throw new DomainError("FINANCE_AMOUNT_INVALID", 422);
  return micros;
};

/** `base × part / total`, rounded half-even to whole base units. */
const prorate = (base: bigint, part: bigint, total: bigint, decimals: number) => {
  if (part === total) return base;
  const unit = 10n ** BigInt(MICRO_DIGITS - decimals);
  const numerator = base * part;
  const divisor = total * unit;
  let units = numerator / divisor;
  const twice = (numerator % divisor) * 2n;
  if (twice > divisor || (twice === divisor && units % 2n === 1n)) units += 1n;
  return units * unit;
};

/**
 * Debit and credit lines for a business transaction (spec §7).
 *
 * Every line converts its own amount with `rate` (half-even to the base
 * decimals). Splits over cost centers apply to the expense and income lines
 * only; the counter line (payables, receivables, payment account) stays one
 * line without a cost center. Tax is part of each line's gross.
 *
 * Base rounding: when per-line conversion leaves debits and credits apart,
 * the residue goes onto the largest expense or income line (any line for
 * an adjustment), by base amount, earlier line on ties. Only when that line
 * would drop to zero or below, or the residue exceeds one base minor unit
 * per converted line, a `rounding` account line in the base currency takes
 * it instead.
 *
 * Payments: the settled invoices keep their posted base (pro-rated for a
 * partial allocation), the payment account gets the base at the payment's
 * rate, and the difference goes to `fx_gain_loss` on the side that
 * balances the entry (none when it is zero).
 */
export function postingLines(
  input: PostingInput,
  roles: SystemAccounts,
  rate: Rate,
  baseDecimals: number,
): DraftLine[] {
  if (!isCurrency(input.currency) || !isCurrency(input.baseCurrency))
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  if (CURRENCY_DECIMALS[input.baseCurrency] !== baseDecimals)
    throw new DomainError("CURRENCY_DECIMALS_INVALID", 422);
  if (
    input.currency === input.baseCurrency &&
    convert(1_000_000n, rate.rate, MICRO_DIGITS) !== 1_000_000n
  )
    throw new DomainError("FINANCE_RATE_INVALID", 422);
  const decimals = CURRENCY_DECIMALS[input.currency];

  const line = (
    accountId: string,
    side: Side,
    amountMicros: bigint,
    extra: { categoryId?: string; costCenterId?: string } = {},
  ): DraftLine => ({
    accountId,
    side,
    currency: input.currency,
    amountMicros: positive(amountMicros),
    fxRate: rate.rate,
    rateDate: rate.rateDate,
    rateSource: rate.source,
    baseAmountMicros: convert(amountMicros, rate.rate, baseDecimals),
    ...(extra.categoryId ? { categoryId: extra.categoryId } : {}),
    ...(extra.costCenterId ? { costCenterId: extra.costCenterId } : {}),
  });
  // A base-currency line that settles a residue (fx or rounding).
  const baseLine = (accountId: string, side: Side, micros: bigint): DraftLine => ({
    accountId,
    side,
    currency: input.baseCurrency,
    amountMicros: micros,
    fxRate: "1",
    rateDate: rate.rateDate,
    rateSource: "identity",
    baseAmountMicros: micros,
  });

  const balance = (lines: DraftLine[], absorbing: DraftLine[]) => {
    const residue = sumBy(lines, "debit") - sumBy(lines, "credit");
    if (residue === 0n) return lines;
    const amount = abs(residue);
    const heavier: Side = residue > 0n ? "debit" : "credit";
    const unit = 10n ** BigInt(MICRO_DIGITS - baseDecimals);
    const target = absorbing.reduce<DraftLine | undefined>(
      (best, candidate) =>
        !best || candidate.baseAmountMicros > best.baseAmountMicros
          ? candidate
          : best,
      undefined,
    );
    if (target && amount <= unit * BigInt(lines.length)) {
      const adjusted =
        target.side === heavier
          ? target.baseAmountMicros - amount
          : target.baseAmountMicros + amount;
      if (adjusted > 0n)
        return lines.map((l) =>
          l === target ? { ...l, baseAmountMicros: adjusted } : l,
        );
    }
    return [...lines, baseLine(roles.rounding, flip(heavier), amount)];
  };

  switch (input.kind) {
    case "invoice":
    case "credit_note":
    case "receipt": {
      if (input.lines.length === 0)
        throw new DomainError("FINANCE_AMOUNT_INVALID", 422);
      const payable = input.direction === "payable";
      // Expense lines are debits of a payable invoice, income lines credits
      // of a receivable one; a credit note inverts its invoice.
      let categorySide: Side = payable ? "debit" : "credit";
      if (input.kind === "credit_note") categorySide = flip(categorySide);
      const categoryLines: DraftLine[] = [];
      let gross = 0n;
      for (const item of input.lines) {
        if (item.amountMicros < 0n || item.taxMicros < 0n)
          throw new DomainError("FINANCE_AMOUNT_INVALID", 422);
        const total = positive(item.amountMicros + item.taxMicros);
        gross += total;
        const parts =
          item.allocation.length === 0
            ? [{ key: "", micros: total }]
            : splitByBasisPoints(
                total,
                item.allocation.map((a) => ({ key: a.costCenterId, bp: a.bp })),
                decimals,
              );
        for (const part of parts) {
          // A zero-point share of a split gets no line.
          if (part.micros === 0n) continue;
          categoryLines.push(
            line(item.categoryAccountId, categorySide, part.micros, {
              categoryId: item.categoryId,
              costCenterId: part.key || undefined,
            }),
          );
        }
      }
      const counterAccount =
        input.kind === "receipt"
          ? input.paymentAccountId
          : payable
            ? roles.payables
            : roles.receivables;
      const counter = line(counterAccount, flip(categorySide), gross);
      const lines = payable
        ? [...categoryLines, counter]
        : [counter, ...categoryLines];
      return balance(lines, categoryLines);
    }
    case "payment": {
      if (input.allocations.length === 0)
        throw new DomainError("FINANCE_AMOUNT_INVALID", 422);
      const outgoing = input.direction === "outgoing";
      const settleSide: Side = outgoing ? "debit" : "credit";
      const settled: DraftLine[] = input.allocations.map((a) => {
        positive(a.amountMicros);
        positive(a.invoiceBaseMicros);
        if (positive(a.invoiceTotalMicros) < a.amountMicros)
          throw new DomainError("FINANCE_AMOUNT_INVALID", 422);
        return {
          accountId: outgoing ? roles.payables : roles.receivables,
          side: settleSide,
          currency: input.currency,
          amountMicros: a.amountMicros,
          fxRate: a.invoiceRate.rate,
          rateDate: a.invoiceRate.rateDate,
          rateSource: a.invoiceRate.source,
          baseAmountMicros: prorate(
            a.invoiceBaseMicros,
            a.amountMicros,
            a.invoiceTotalMicros,
            baseDecimals,
          ),
        };
      });
      const total = input.allocations.reduce((acc, a) => acc + a.amountMicros, 0n);
      const paid = line(input.paymentAccountId, flip(settleSide), total);
      const lines = outgoing ? [...settled, paid] : [paid, ...settled];
      const difference = sumBy(lines, "debit") - sumBy(lines, "credit");
      if (difference === 0n) return lines;
      return [
        ...lines,
        baseLine(
          roles.fx_gain_loss,
          difference > 0n ? "credit" : "debit",
          abs(difference),
        ),
      ];
    }
    case "contribution":
      return balance(
        [
          line(input.paymentAccountId, "debit", input.amountMicros),
          line(roles.owner_contributions, "credit", input.amountMicros),
        ],
        [],
      );
    case "withdrawal":
      return balance(
        [
          line(roles.owner_draws, "debit", input.amountMicros),
          line(input.paymentAccountId, "credit", input.amountMicros),
        ],
        [],
      );
    case "transfer":
      return balance(
        [
          line(input.toAccountId, "debit", input.amountMicros),
          line(input.fromAccountId, "credit", input.amountMicros),
        ],
        [],
      );
    case "adjustment": {
      const lines = input.lines.map((l) =>
        line(l.accountId, l.side, l.amountMicros, l),
      );
      return balance(lines, lines);
    }
  }
}

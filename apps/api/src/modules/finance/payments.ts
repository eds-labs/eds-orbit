import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { isoDate, livePaymentAccount, versionField } from "./common.ts";
import { rateFor } from "./fx.ts";
import { systemAccounts } from "./ledger/accounts.ts";
import { postEntry } from "./ledger/post.ts";
import { reverseEntry } from "./ledger/reversal.ts";
import {
  postingLines,
  type PaymentAllocation,
  type Rate,
  type RateSource,
} from "./ledger/posting.ts";
import { CURRENCY_DECIMALS } from "./money.ts";
import { readFinanceSettings } from "./settings.ts";

// Payments settle invoices (spec §7). Each allocation settles a share of
// the invoice's open amount and of its open base: the invoice's posted
// base minus what earlier allocations settled (stored per allocation), so
// the payment that clears an invoice leaves its open-item account at zero
// in base, whatever the rates in between were. The difference to the base
// the payment account moves goes to fx gains and losses.

export const paymentInput = z
  .object({
    direction: z.enum(["outgoing", "incoming"]),
    accountId: z.uuid(),
    date: isoDate,
    currency: z.string(),
    amountMicros: z.bigint().positive(),
    reference: z.string().trim().min(1).max(200).optional(),
    counterpartyId: z.uuid().optional(),
    allocations: z
      .array(
        z
          .object({ invoiceId: z.uuid(), amountMicros: z.bigint().positive() })
          .strict(),
      )
      .min(1)
      .max(100),
    /** Base per unit of the payment currency, when no stored rate exists. */
    rateOverride: z.string().optional(),
  })
  .strict();

export type PaymentInput = z.input<typeof paymentInput>;

type InvoiceRow = {
  id: string;
  kind: string;
  direction: string;
  currency: string;
  totalMicros: bigint;
  entryId: string | null;
  creditsInvoiceId: string | null;
};

/**
 * The direction that settles an invoice: money leaves for a payable
 * invoice and arrives for a receivable one. A credit note inverts it, so
 * the only payment it takes is a refund.
 */
export const settlingDirection = (invoice: {
  kind: string;
  direction: string;
}) =>
  (invoice.direction === "payable") !== (invoice.kind === "credit_note")
    ? "outgoing"
    : "incoming";

/** Allocations to an invoice whose payment is not voided. */
export async function liveAllocations(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  invoiceId: string,
) {
  const allocations = await tx.financePaymentAllocation.findMany({
    where: { projectId: scope.projectId, invoiceId },
  });
  if (allocations.length === 0) return allocations;
  const live = new Set(
    (
      await tx.financePayment.findMany({
        where: {
          projectId: scope.projectId,
          id: { in: allocations.map((a) => a.paymentId) },
          voidedAt: null,
        },
        select: { id: true },
      })
    ).map((p) => p.id),
  );
  return allocations.filter((a) => live.has(a.paymentId));
}

type Balance = Omit<PaymentAllocation, "amountMicros">;

/**
 * What is still open on several invoices, in their currencies and in base:
 * the total less live payment allocations and less the live credit notes
 * crediting each (their totals, and their posted open-item base). A credit
 * note that credits an invoice is applied to it in full, so nothing of it
 * is open. With `asOf` (ISO date) only payments dated and credit notes
 * issued on or before it count. Voids carry no date, so a payment voided
 * after `asOf` is treated as never having existed ("live now").
 * A few `IN (...)` queries for the whole batch.
 */
export async function invoiceBalances(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  invoices: InvoiceRow[],
  asOf?: string,
): Promise<Map<string, Balance>> {
  const result = new Map<string, Balance>();
  if (invoices.length === 0) return result;
  const cutoff = asOf ? new Date(`${asOf}T00:00:00.000Z`) : undefined;
  const ids = invoices.map((i) => i.id);
  const plain = invoices.filter((i) => i.kind !== "credit_note");

  const credits = plain.length
    ? await tx.financeInvoice.findMany({
        where: {
          projectId: scope.projectId,
          creditsInvoiceId: { in: plain.map((i) => i.id) },
          kind: "credit_note",
          status: { not: "void" },
          ...(cutoff ? { issueDate: { lte: cutoff } } : {}),
        },
      })
    : [];
  const allocations = await tx.financePaymentAllocation.findMany({
    where: { projectId: scope.projectId, invoiceId: { in: ids } },
  });
  const livePayments = allocations.length
    ? new Set(
        (
          await tx.financePayment.findMany({
            where: {
              projectId: scope.projectId,
              id: { in: [...new Set(allocations.map((a) => a.paymentId))] },
              voidedAt: null,
              ...(cutoff ? { date: { lte: cutoff } } : {}),
            },
            select: { id: true },
          })
        ).map((p) => p.id),
      )
    : new Set<string>();

  const entryIds = [...invoices, ...credits].flatMap((i) =>
    i.entryId ? [i.entryId] : [],
  );
  const lines = entryIds.length
    ? await tx.financeJournalLine.findMany({
        where: {
          projectId: scope.projectId,
          entryId: { in: entryIds },
          categoryId: null,
        },
      })
    : [];
  const counterOf = (
    invoice: Pick<InvoiceRow, "entryId" | "currency" | "totalMicros">,
  ) => {
    const line = invoice.entryId
      ? lines.find(
          (l) =>
            l.entryId === invoice.entryId &&
            l.currency === invoice.currency &&
            l.amountMicros === invoice.totalMicros,
        )
      : undefined;
    if (!line) throw new DomainError("FINANCE_INVOICE_POSTING_INVALID", 409);
    return line;
  };

  for (const invoice of invoices) {
    const counter = counterOf(invoice);
    const invoiceRate: Rate = {
      rate: counter.fxRate.toFixed(),
      rateDate: counter.rateDate.toISOString().slice(0, 10),
      source: counter.rateSource as RateSource,
    };
    if (invoice.kind === "credit_note" && invoice.creditsInvoiceId) {
      result.set(invoice.id, {
        openAmountMicros: 0n,
        openBaseMicros: 0n,
        invoiceRate,
      });
      continue;
    }
    let openAmountMicros = invoice.totalMicros;
    let openBaseMicros = counter.baseAmountMicros;
    for (const a of allocations)
      if (a.invoiceId === invoice.id && livePayments.has(a.paymentId)) {
        openAmountMicros -= a.amountMicros;
        openBaseMicros -= a.baseMicros;
      }
    if (invoice.kind !== "credit_note")
      for (const credit of credits)
        if (credit.creditsInvoiceId === invoice.id) {
          openAmountMicros -= credit.totalMicros;
          openBaseMicros -= counterOf(credit).baseAmountMicros;
        }
    result.set(invoice.id, { openAmountMicros, openBaseMicros, invoiceRate });
  }
  return result;
}

/** What is still open on one invoice; see `invoiceBalances`. */
export async function invoiceBalance(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  invoice: InvoiceRow,
): Promise<Balance> {
  return (await invoiceBalances(tx, scope, [invoice])).get(invoice.id)!;
}

const CLOSE_SOURCE = "invoice_close";
const flip = (side: "debit" | "credit") =>
  side === "debit" ? "credit" : "debit";
const laterOf = (a: string, b: string) => (a > b ? a : b);
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Recomputes an invoice's payment status from its live allocations and
 * credits (`open → partially_paid → paid`, and back after a void). A closed
 * invoice whose open base is not zero, because credits were posted at other
 * rates, gets a base-currency entry between its open-item account and fx
 * gains and losses that zeroes it, dated `date`; reopening reverses that
 * entry. Void invoices are left alone.
 */
export async function refreshInvoiceStatus(
  tx: DbTx,
  scope: Scope,
  invoiceId: string,
  date: string,
) {
  const invoice = await tx.financeInvoice.findFirst({
    where: { projectId: scope.projectId, id: invoiceId },
  });
  if (!invoice || invoice.status === "void") return;
  const balance = await invoiceBalance(tx, scope, invoice);
  const status =
    balance.openAmountMicros <= 0n
      ? "paid"
      : balance.openAmountMicros < invoice.totalMicros
        ? "partially_paid"
        : "open";
  if (status !== invoice.status)
    await tx.financeInvoice.updateMany({
      where: { projectId: scope.projectId, id: invoiceId },
      data: { status, version: { increment: 1 } },
    });
  if (invoice.kind === "credit_note" && invoice.creditsInvoiceId) return;

  const closes = await tx.financeJournalEntry.findMany({
    where: {
      projectId: scope.projectId,
      sourceType: CLOSE_SOURCE,
      sourceId: invoiceId,
      reversedById: null,
    },
  });
  if (status !== "paid") {
    for (const close of closes)
      await reverseEntry(
        tx,
        scope,
        close.id,
        "Invoice reopened",
        laterOf(day(new Date()), day(close.entryDate)),
      );
    return;
  }
  if (closes.length || balance.openBaseMicros === 0n) return;
  const { settings } = await readFinanceSettings(tx, scope);
  const roles = await systemAccounts(tx, scope);
  const openItem =
    invoice.direction === "payable" ? roles.payables : roles.receivables;
  // The open base sits on the invoice's natural side: credit for payables,
  // debit for receivables; the closing line takes it off.
  const natural = invoice.direction === "payable" ? "credit" : "debit";
  const amount = balance.openBaseMicros;
  const side = amount > 0n ? flip(natural) : natural;
  const micros = amount > 0n ? amount : -amount;
  const entryDate = laterOf(date, day(invoice.issueDate));
  const lines = postingLines(
    {
      kind: "adjustment",
      currency: settings.baseCurrency,
      baseCurrency: settings.baseCurrency,
      lines: [
        { accountId: openItem, side, amountMicros: micros },
        {
          accountId: roles.fx_gain_loss,
          side: flip(side),
          amountMicros: micros,
        },
      ],
    },
    roles,
    { rate: "1", rateDate: entryDate, source: "identity" },
    CURRENCY_DECIMALS[settings.baseCurrency],
  );
  await postEntry(tx, scope, {
    kind: "adjustment",
    entryDate,
    sourceType: CLOSE_SOURCE,
    sourceId: invoiceId,
    lines,
  });
}

/**
 * Records a payment allocated to invoices of one counterparty (422
 * PAYMENT_MIXED_COUNTERPARTIES otherwise; the payment records it) and posts
 * it. The allocations must use the whole amount; more than an invoice has
 * open, or than the payment carries, is 422 PAYMENT_OVER_ALLOCATED. All
 * invoices settle the same open-item account (`settles`), in the payment's
 * currency, and the direction must be the one that settles them
 * (`settlingDirection`): a refund, the opposite direction, is accepted only
 * for credit notes. Invoices move `open → partially_paid → paid`. Call
 * inside `scoped()`.
 */
export async function recordPayment(
  tx: DbTx,
  scope: Scope,
  raw: PaymentInput,
): Promise<{ paymentId: string; entryId: string }> {
  const input = paymentInput.parse(raw);
  const { settings } = await readFinanceSettings(tx, scope);
  if (!(settings.currencies as string[]).includes(input.currency))
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  await livePaymentAccount(tx, scope, input.accountId, input.currency);
  const ids = input.allocations.map((a) => a.invoiceId);
  if (new Set(ids).size !== ids.length)
    throw new DomainError("FINANCE_ALLOCATION_INVALID", 422);
  const allocatedTotal = input.allocations.reduce(
    (sum, a) => sum + a.amountMicros,
    0n,
  );
  if (allocatedTotal > input.amountMicros)
    throw new DomainError("PAYMENT_OVER_ALLOCATED", 422);
  if (allocatedTotal < input.amountMicros)
    throw new DomainError("PAYMENT_UNALLOCATED", 422);

  const invoices = await tx.financeInvoice.findMany({
    where: { projectId: scope.projectId, id: { in: ids } },
  });
  if (invoices.length !== ids.length)
    throw new DomainError("FINANCE_INVOICE_NOT_FOUND", 404);
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const counterparties = new Set(invoices.map((i) => i.counterpartyId));
  if (counterparties.size !== 1)
    throw new DomainError("PAYMENT_MIXED_COUNTERPARTIES", 422);
  const counterpartyId = invoices[0]!.counterpartyId;
  if (input.counterpartyId && input.counterpartyId !== counterpartyId)
    throw new DomainError("FINANCE_COUNTERPARTY_INVALID", 422);
  const sides = new Set(invoices.map((i) => i.direction));
  if (sides.size !== 1)
    throw new DomainError("FINANCE_PAYMENT_DIRECTION_INVALID", 422);
  const settles =
    invoices[0]!.direction === "payable" ? "payables" : "receivables";

  const allocations: PaymentAllocation[] = [];
  for (const a of input.allocations) {
    const invoice = byId.get(a.invoiceId)!;
    if (invoice.status === "void")
      throw new DomainError("FINANCE_INVOICE_VOID", 409);
    if (invoice.currency !== input.currency)
      throw new DomainError("FINANCE_CURRENCY_MISMATCH", 422);
    if (settlingDirection(invoice) !== input.direction)
      throw new DomainError("FINANCE_PAYMENT_DIRECTION_INVALID", 422);
    const open = await invoiceBalance(tx, scope, invoice);
    if (a.amountMicros > open.openAmountMicros)
      throw new DomainError("PAYMENT_OVER_ALLOCATED", 422);
    allocations.push({ ...open, amountMicros: a.amountMicros });
  }

  const override: Rate | undefined = input.rateOverride
    ? { rate: input.rateOverride, rateDate: input.date, source: "manual" }
    : undefined;
  const rate = await rateFor(
    tx,
    scope,
    input.currency,
    settings.baseCurrency,
    input.date,
    override,
  );
  const roles = await systemAccounts(tx, scope);
  const lines = postingLines(
    {
      kind: "payment",
      direction: input.direction,
      settles,
      currency: input.currency,
      baseCurrency: settings.baseCurrency,
      paymentAccountId: input.accountId,
      allocations,
    },
    roles,
    rate,
    CURRENCY_DECIMALS[settings.baseCurrency],
  );
  // One settling line per allocation, in allocation order.
  const settled = lines.filter((line) => line.accountId === roles[settles]);

  const paymentId = randomUUID();
  const entry = await postEntry(tx, scope, {
    kind: "payment",
    entryDate: input.date,
    sourceType: "payment",
    sourceId: paymentId,
    lines,
  });
  await tx.financePayment.create({
    data: {
      id: paymentId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      date: new Date(`${input.date}T00:00:00.000Z`),
      direction: input.direction,
      accountId: input.accountId,
      currency: input.currency,
      amountMicros: input.amountMicros,
      reference: input.reference ?? null,
      counterpartyId,
      entryId: entry.id,
    },
  });
  await tx.financePaymentAllocation.createMany({
    data: input.allocations.map((a, index) => ({
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      paymentId,
      invoiceId: a.invoiceId,
      amountMicros: a.amountMicros,
      baseMicros: settled[index]!.baseAmountMicros,
    })),
  });
  for (const a of input.allocations)
    await refreshInvoiceStatus(tx, scope, a.invoiceId, input.date);
  await audit(tx, scope, "finance.payment.recorded", paymentId, {
    paymentId,
    entryId: entry.id,
    direction: input.direction,
    allocations: input.allocations.length,
  });
  return { paymentId, entryId: entry.id };
}

/**
 * The payment of a receipt, which its own posting already settled against
 * the payment account: a payment row on the receipt's entry and one
 * allocation for the whole total, so the receipt reads as paid.
 */
export async function recordReceiptPayment(
  tx: DbTx,
  scope: Scope,
  input: {
    invoiceId: string;
    entryId: string;
    direction: "outgoing" | "incoming";
    accountId: string;
    date: string;
    currency: string;
    amountMicros: bigint;
    baseMicros: bigint;
    counterpartyId: string;
  },
): Promise<string> {
  const paymentId = randomUUID();
  await tx.financePayment.create({
    data: {
      id: paymentId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      date: new Date(`${input.date}T00:00:00.000Z`),
      direction: input.direction,
      accountId: input.accountId,
      currency: input.currency,
      amountMicros: input.amountMicros,
      counterpartyId: input.counterpartyId,
      entryId: input.entryId,
    },
  });
  await tx.financePaymentAllocation.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      paymentId,
      invoiceId: input.invoiceId,
      amountMicros: input.amountMicros,
      baseMicros: input.baseMicros,
    },
  });
  await audit(tx, scope, "finance.payment.recorded", paymentId, {
    paymentId,
    entryId: input.entryId,
    direction: input.direction,
    allocations: 1,
  });
  return paymentId;
}

export const voidPaymentInput = z
  .object({
    version: versionField.optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

/**
 * Voids a payment (spec §7, corrections): reverses its entry (the reason
 * is the reversal's memo, never audited), marks it voided, and recomputes
 * the status of every invoice it was allocated to. A receipt's own payment
 * shares the receipt's entry and is voided only with the receipt (409
 * FINANCE_RECEIPT_PAYMENT).
 */
export async function voidPayment(
  tx: DbTx,
  scope: Scope,
  paymentId: string,
  raw: { version?: number; reason: string },
): Promise<{ reversalId: string }> {
  const { version, reason } = voidPaymentInput.parse(raw);
  const payment = await tx.financePayment.findFirst({
    where: { projectId: scope.projectId, id: paymentId },
  });
  if (!payment) throw new DomainError("FINANCE_PAYMENT_NOT_FOUND", 404);
  if (payment.voidedAt) throw new DomainError("FINANCE_PAYMENT_VOID", 409);
  if (version !== undefined && payment.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (!payment.entryId)
    throw new DomainError("FINANCE_PAYMENT_POSTING_INVALID", 409);
  const ownReceipt = await tx.financeInvoice.count({
    where: { projectId: scope.projectId, entryId: payment.entryId },
  });
  if (ownReceipt) throw new DomainError("FINANCE_RECEIPT_PAYMENT", 409);
  const today = day(new Date());
  const reversal = await reverseEntry(
    tx,
    scope,
    payment.entryId,
    reason,
    laterOf(today, day(payment.date)),
  );
  const updated = await tx.financePayment.updateMany({
    where: {
      projectId: scope.projectId,
      id: paymentId,
      version: payment.version,
    },
    data: { voidedAt: new Date(), version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new DomainError("VERSION_CONFLICT", 409);
  const allocations = await tx.financePaymentAllocation.findMany({
    where: { projectId: scope.projectId, paymentId },
  });
  for (const a of allocations)
    await refreshInvoiceStatus(tx, scope, a.invoiceId, today);
  await audit(tx, scope, "finance.payment.voided", paymentId, {
    paymentId,
    reversalId: reversal.id,
    allocations: allocations.length,
  });
  return { reversalId: reversal.id };
}

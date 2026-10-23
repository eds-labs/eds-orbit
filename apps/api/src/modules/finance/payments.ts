import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { isoDate, livePaymentAccount } from "./common.ts";
import { rateFor } from "./fx.ts";
import { systemAccounts } from "./ledger/accounts.ts";
import { postEntry } from "./ledger/post.ts";
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
};

/**
 * The direction that settles an invoice: money leaves for a payable
 * invoice and arrives for a receivable one. A credit note inverts it, so
 * the only payment it takes is a refund.
 */
export const settlingDirection = (invoice: { kind: string; direction: string }) =>
  (invoice.direction === "payable") !== (invoice.kind === "credit_note")
    ? "outgoing"
    : "incoming";

/** What is still open on an invoice, in its currency and in base. */
async function openItem(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  invoice: InvoiceRow,
): Promise<Omit<PaymentAllocation, "amountMicros">> {
  const allocated = await tx.financePaymentAllocation.findMany({
    where: { projectId: scope.projectId, invoiceId: invoice.id },
    select: { amountMicros: true, baseMicros: true },
  });
  const paid = allocated.reduce((sum, a) => sum + a.amountMicros, 0n);
  const settledBase = allocated.reduce((sum, a) => sum + a.baseMicros, 0n);
  const openAmountMicros = invoice.totalMicros - paid;
  if (openAmountMicros <= 0n || !invoice.entryId)
    throw new DomainError("PAYMENT_OVER_ALLOCATED", 422);
  // The open-item line of the invoice's posting: the only line without a
  // category in the invoice currency carrying its total.
  const counter = (
    await tx.financeJournalLine.findMany({
      where: {
        projectId: scope.projectId,
        entryId: invoice.entryId,
        categoryId: null,
        currency: invoice.currency,
      },
    })
  ).find((line) => line.amountMicros === invoice.totalMicros);
  if (!counter) throw new DomainError("FINANCE_INVOICE_POSTING_INVALID", 409);
  return {
    openAmountMicros,
    openBaseMicros: counter.baseAmountMicros - settledBase,
    invoiceRate: {
      rate: counter.fxRate.toFixed(),
      rateDate: counter.rateDate.toISOString().slice(0, 10),
      source: counter.rateSource as RateSource,
    },
  };
}

/**
 * Records a payment allocated to invoices of one counterparty side and posts
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
  const sides = new Set(invoices.map((i) => i.direction));
  if (sides.size !== 1)
    throw new DomainError("FINANCE_PAYMENT_DIRECTION_INVALID", 422);
  const settles = invoices[0]!.direction === "payable" ? "payables" : "receivables";

  const allocations: PaymentAllocation[] = [];
  for (const a of input.allocations) {
    const invoice = byId.get(a.invoiceId)!;
    if (invoice.status === "void")
      throw new DomainError("FINANCE_INVOICE_VOID", 409);
    if (invoice.currency !== input.currency)
      throw new DomainError("FINANCE_CURRENCY_MISMATCH", 422);
    if (input.counterpartyId && invoice.counterpartyId !== input.counterpartyId)
      throw new DomainError("FINANCE_COUNTERPARTY_INVALID", 422);
    if (settlingDirection(invoice) !== input.direction)
      throw new DomainError("FINANCE_PAYMENT_DIRECTION_INVALID", 422);
    const open = await openItem(tx, scope, invoice);
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
      counterpartyId: input.counterpartyId ?? invoices[0]!.counterpartyId,
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
  for (const [index, a] of input.allocations.entries()) {
    const fullyPaid = a.amountMicros === allocations[index]!.openAmountMicros;
    await tx.financeInvoice.updateMany({
      where: { projectId: scope.projectId, id: a.invoiceId },
      data: {
        status: fullyPaid ? "paid" : "partially_paid",
        version: { increment: 1 },
      },
    });
  }
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

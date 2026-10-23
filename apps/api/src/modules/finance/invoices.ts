import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  allocationSchema,
  assertLiveCostCenters,
  assertUpdated,
  isoDate,
  liveCategories,
  livePaymentAccount,
  versionField,
} from "./common.ts";
import { rateFor } from "./fx.ts";
import { systemAccounts } from "./ledger/accounts.ts";
import { isoDate as calendarDate, postEntry } from "./ledger/post.ts";
import { postingLines, type DocumentLine, type Rate } from "./ledger/posting.ts";
import { reverseEntry } from "./ledger/reversal.ts";
import { CURRENCY_DECIMALS, parseAmount } from "./money.ts";
import {
  recordPayment,
  recordReceiptPayment,
  settlingDirection,
} from "./payments.ts";
import { readFinanceSettings } from "./settings.ts";

// Invoices, credit notes and receipts (spec §7): a confirmed booking
// becomes an invoice with its lines and a posted journal entry. Payment
// status follows the allocations; overdue is derived when read.

/** A decimal amount in the booking currency, parsed by parseAmount. */
const amount = z.string().trim().min(1).max(32);

const bookingLine = z
  .object({
    description: z.string().trim().min(1).max(500),
    amount,
    tax: amount,
    categoryId: z.uuid(),
    // Cost center basis points summing to 10000, or empty for none.
    allocation: z.union([z.tuple([]), allocationSchema]),
  })
  .strict();

/**
 * What a person confirms when booking (the review form). Amounts are
 * decimal strings in `currency`; `rateOverride` is base per unit of
 * `currency`, used when no stored rate exists for `issueDate`. A receipt
 * is already paid and needs `paid`; a credit note may name the invoice it
 * credits.
 */
export const bookingInput = z
  .object({
    kind: z.enum(["invoice", "credit_note", "receipt"]),
    direction: z.enum(["payable", "receivable"]),
    counterpartyId: z.uuid(),
    number: z.string().trim().min(1).max(80).optional(),
    issueDate: isoDate,
    dueDate: isoDate.optional(),
    currency: z.string(),
    creditsInvoiceId: z.uuid().optional(),
    lines: z.array(bookingLine).min(1).max(200),
    paid: z.object({ accountId: z.uuid(), date: isoDate }).strict().optional(),
    rateOverride: z.string().optional(),
  })
  .strict();

export type BookingInput = z.output<typeof bookingInput>;
/** A booking as a client sends it, before validation. */
export type BookingRequest = z.input<typeof bookingInput>;

export const voidInvoiceInput = z
  .object({ version: versionField, reason: z.string().trim().min(1).max(1000) })
  .strict();

const sum = (values: bigint[]) => values.reduce((acc, v) => acc + v, 0n);

/** An invoice the credit note credits: same counterparty, side and currency. */
async function assertCreditTarget(
  tx: DbTx,
  scope: Scope,
  input: BookingInput,
) {
  if (!input.creditsInvoiceId) return;
  if (input.kind !== "credit_note")
    throw new DomainError("FINANCE_CREDIT_INVALID", 422);
  const target = await tx.financeInvoice.findFirst({
    where: { projectId: scope.projectId, id: input.creditsInvoiceId },
  });
  if (
    !target ||
    target.kind === "credit_note" ||
    target.status === "void" ||
    target.counterpartyId !== input.counterpartyId ||
    target.direction !== input.direction ||
    target.currency !== input.currency
  )
    throw new DomainError("FINANCE_CREDIT_INVALID", 422);
}

/**
 * Creates the invoice of a confirmed booking and posts it at the rate of
 * its issue date (spec §7). A receipt posts against the payment account at
 * once and records its payment on the same entry; an invoice or credit
 * note with `paid` posts its payment as a second entry at the payment
 * date's rate. Archived accounts, categories and cost centers are refused
 * (409 FINANCE_ACCOUNT_ARCHIVED). Call inside `scoped()`.
 */
export async function createInvoice(
  tx: DbTx,
  scope: Scope,
  input: BookingInput,
  options: { documentId?: string } = {},
): Promise<{ invoiceId: string; entryId: string; paymentId?: string }> {
  const { settings } = await readFinanceSettings(tx, scope);
  const { currency } = input;
  if (!(settings.currencies as string[]).includes(currency))
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  if (input.kind === "receipt" && !input.paid)
    throw new DomainError("FINANCE_PAYMENT_REQUIRED", 422);
  const issueDate = calendarDate(input.issueDate);
  const dueDate = input.dueDate ? calendarDate(input.dueDate) : null;
  if (dueDate && dueDate < issueDate)
    throw new DomainError("FINANCE_DATE_INVALID", 422);
  const counterparty = await tx.financeCounterparty.findFirst({
    where: { projectId: scope.projectId, id: input.counterpartyId },
    select: { id: true },
  });
  if (!counterparty) throw new DomainError("FINANCE_COUNTERPARTY_INVALID", 422);
  await assertCreditTarget(tx, scope, input);

  const categories = await liveCategories(
    tx,
    scope,
    input.lines.map((line) => line.categoryId),
  );
  const kind = input.direction === "payable" ? "expense" : "income";
  if ([...categories.values()].some((category) => category.kind !== kind))
    throw new DomainError("FINANCE_CATEGORY_INVALID", 422);
  await assertLiveCostCenters(
    tx,
    scope,
    input.lines.flatMap((line) => line.allocation.map((a) => a.costCenterId)),
  );
  if (input.paid)
    await livePaymentAccount(tx, scope, input.paid.accountId, currency);

  const lines = input.lines.map((line) => ({
    ...line,
    amountMicros: parseAmount(line.amount, currency),
    taxMicros: parseAmount(line.tax, currency),
  }));
  const override: Rate | undefined = input.rateOverride
    ? { rate: input.rateOverride, rateDate: input.issueDate, source: "manual" }
    : undefined;
  const rate = await rateFor(
    tx,
    scope,
    currency,
    settings.baseCurrency,
    input.issueDate,
    override,
  );
  const roles = await systemAccounts(tx, scope);
  const documentLines: DocumentLine[] = lines.map((line) => ({
    amountMicros: line.amountMicros,
    taxMicros: line.taxMicros,
    categoryAccountId: categories.get(line.categoryId)!.accountId,
    categoryId: line.categoryId,
    allocation: line.allocation,
  }));
  const common = {
    direction: input.direction,
    currency,
    baseCurrency: settings.baseCurrency,
    lines: documentLines,
  };
  const draft = postingLines(
    input.kind === "receipt"
      ? { ...common, kind: "receipt", paymentAccountId: input.paid!.accountId }
      : { ...common, kind: input.kind },
    roles,
    rate,
    CURRENCY_DECIMALS[settings.baseCurrency],
  );

  const invoiceId = randomUUID();
  const entry = await postEntry(tx, scope, {
    kind: input.kind,
    entryDate: input.issueDate,
    ...(options.documentId ? { documentId: options.documentId } : {}),
    sourceType: "invoice",
    sourceId: invoiceId,
    lines: draft,
  });
  const netMicros = sum(lines.map((line) => line.amountMicros));
  const taxMicros = sum(lines.map((line) => line.taxMicros));
  const totalMicros = netMicros + taxMicros;
  await tx.financeInvoice.create({
    data: {
      id: invoiceId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: input.kind,
      direction: input.direction,
      counterpartyId: input.counterpartyId,
      number: input.number ?? null,
      issueDate,
      dueDate,
      currency,
      netMicros,
      taxMicros,
      totalMicros,
      status: input.kind === "receipt" ? "paid" : "open",
      documentId: options.documentId ?? null,
      creditsInvoiceId: input.creditsInvoiceId ?? null,
      entryId: entry.id,
    },
  });
  await tx.financeInvoiceLine.createMany({
    data: lines.map((line, position) => ({
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      invoiceId,
      position,
      description: line.description,
      amountMicros: line.amountMicros,
      taxMicros: line.taxMicros,
      categoryId: line.categoryId,
      allocation: line.allocation.length
        ? (line.allocation as Prisma.InputJsonValue)
        : undefined,
    })),
  });

  if (!input.paid) return { invoiceId, entryId: entry.id };
  const direction = settlingDirection(input);
  if (input.kind === "receipt") {
    const paymentLine = draft.find(
      (line) => line.accountId === input.paid!.accountId,
    )!;
    const paymentId = await recordReceiptPayment(tx, scope, {
      invoiceId,
      entryId: entry.id,
      direction,
      accountId: input.paid.accountId,
      date: input.paid.date,
      currency,
      amountMicros: totalMicros,
      baseMicros: paymentLine.baseAmountMicros,
      counterpartyId: input.counterpartyId,
    });
    return { invoiceId, entryId: entry.id, paymentId };
  }
  const { paymentId } = await recordPayment(tx, scope, {
    direction,
    accountId: input.paid.accountId,
    date: input.paid.date,
    currency,
    amountMicros: totalMicros,
    counterpartyId: input.counterpartyId,
    allocations: [{ invoiceId, amountMicros: totalMicros }],
  });
  return { invoiceId, entryId: entry.id, paymentId };
}

/**
 * Voids an invoice without payments by reversing its posting (dated today,
 * or the issue date when that is later). The reason is the reversal's memo
 * and stays out of the audit. 409 FINANCE_INVOICE_HAS_PAYMENTS while any
 * payment is allocated to it, FINANCE_INVOICE_CREDITED while a live credit
 * note credits it.
 */
export async function voidInvoice(
  tx: DbTx,
  scope: Scope,
  invoiceId: string,
  raw: { version: number; reason: string },
): Promise<{ reversalId: string }> {
  const { version, reason } = voidInvoiceInput.parse(raw);
  const invoice = await tx.financeInvoice.findFirst({
    where: { projectId: scope.projectId, id: invoiceId },
  });
  if (!invoice) throw new DomainError("FINANCE_INVOICE_NOT_FOUND", 404);
  if (invoice.status === "void")
    throw new DomainError("FINANCE_INVOICE_VOID", 409);
  if (invoice.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const allocations = await tx.financePaymentAllocation.count({
    where: { projectId: scope.projectId, invoiceId },
  });
  if (allocations) throw new DomainError("FINANCE_INVOICE_HAS_PAYMENTS", 409);
  const credits = await tx.financeInvoice.count({
    where: {
      projectId: scope.projectId,
      creditsInvoiceId: invoiceId,
      status: { not: "void" },
    },
  });
  if (credits) throw new DomainError("FINANCE_INVOICE_CREDITED", 409);
  if (!invoice.entryId) throw new DomainError("FINANCE_INVOICE_POSTING_INVALID", 409);

  const today = new Date().toISOString().slice(0, 10);
  const issued = invoice.issueDate.toISOString().slice(0, 10);
  const reversal = await reverseEntry(
    tx,
    scope,
    invoice.entryId,
    reason,
    issued > today ? issued : today,
  );
  const updated = await tx.financeInvoice.updateMany({
    where: { projectId: scope.projectId, id: invoiceId, version },
    data: { status: "void", version: { increment: 1 } },
  });
  assertUpdated(updated.count);
  await audit(tx, scope, "finance.invoice.voided", invoiceId, {
    invoiceId,
    reversalId: reversal.id,
  });
  return { reversalId: reversal.id };
}

export type InvoiceStatusView =
  | "open"
  | "partially_paid"
  | "paid"
  | "void"
  | "overdue";

/**
 * The status to show: an open or partially paid invoice whose due date is
 * before `today` (ISO date or Date, UTC) is overdue. Never stored.
 */
export function invoiceStatusView(
  row: { status: string; dueDate: Date | null },
  today: string | Date,
): InvoiceStatusView {
  const day = typeof today === "string" ? today : today.toISOString().slice(0, 10);
  if (
    (row.status === "open" || row.status === "partially_paid") &&
    row.dueDate &&
    row.dueDate.toISOString().slice(0, 10) < day
  )
    return "overdue";
  return row.status as InvoiceStatusView;
}

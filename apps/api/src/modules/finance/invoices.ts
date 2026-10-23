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
  invoiceBalance,
  liveAllocations,
  recordPayment,
  recordReceiptPayment,
  refreshInvoiceStatus,
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
 * credits, which then counts it against the invoice's open amount.
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
    // A receipt is paid on its issue date; an invoice defaults to it.
    // `rateOverride` is the payment date's rate when that date differs.
    paid: z
      .object({
        accountId: z.uuid(),
        date: isoDate.optional(),
        rateOverride: z.string().optional(),
      })
      .strict()
      .optional(),
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
async function creditTarget(
  tx: DbTx,
  scope: Scope,
  input: BookingInput,
) {
  if (!input.creditsInvoiceId) return null;
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
  return target;
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
  const credited = await creditTarget(tx, scope, input);
  const paidDate = input.paid?.date ?? input.issueDate;
  if (input.kind === "receipt" && paidDate !== input.issueDate)
    throw new DomainError("FINANCE_DATE_INVALID", 422);

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
  const netMicros = sum(lines.map((line) => line.amountMicros));
  const taxMicros = sum(lines.map((line) => line.taxMicros));
  const totalMicros = netMicros + taxMicros;
  // A credit note can take off at most what is still open.
  if (
    credited &&
    totalMicros > (await invoiceBalance(tx, scope, credited)).openAmountMicros
  )
    throw new DomainError("CREDIT_EXCEEDS_OPEN", 422);
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
      // A receipt is paid, a credit note crediting an invoice applied.
      status: input.kind === "receipt" || credited ? "paid" : "open",
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

  if (credited)
    await refreshInvoiceStatus(tx, scope, credited.id, input.issueDate);
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
      date: input.issueDate,
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
    date: paidDate,
    currency,
    amountMicros: totalMicros,
    counterpartyId: input.counterpartyId,
    allocations: [{ invoiceId, amountMicros: totalMicros }],
    // The booking's rate applies when the payment shares the issue date.
    ...(paidDate === input.issueDate
      ? input.rateOverride
        ? { rateOverride: input.rateOverride }
        : {}
      : input.paid.rateOverride
        ? { rateOverride: input.paid.rateOverride }
        : {}),
  });
  return { invoiceId, entryId: entry.id, paymentId };
}

/**
 * Voids an invoice without live payments by reversing its posting (dated
 * today, or the issue date when that is later). A receipt's own payment
 * shares that entry and is voided with it. The reason is the reversal's
 * memo and stays out of the audit. The invoice's document goes back to
 * `needs_review`, so it can be booked again with corrected data; a voided
 * credit note gives its credited invoice's open amount back. 409
 * FINANCE_INVOICE_HAS_PAYMENTS while a live payment is allocated to it,
 * FINANCE_INVOICE_CREDITED while a live credit note credits it.
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
  if (!invoice.entryId) throw new DomainError("FINANCE_INVOICE_POSTING_INVALID", 409);
  // A receipt's own payment is part of its posting, not a separate payment.
  const own =
    invoice.kind === "receipt"
      ? await tx.financePayment.findMany({
          where: {
            projectId: scope.projectId,
            entryId: invoice.entryId,
            voidedAt: null,
          },
          select: { id: true },
        })
      : [];
  const ownIds = new Set(own.map((p) => p.id));
  const payments = (await liveAllocations(tx, scope, invoiceId)).filter(
    (a) => !ownIds.has(a.paymentId),
  );
  if (payments.length) throw new DomainError("FINANCE_INVOICE_HAS_PAYMENTS", 409);
  const credits = await tx.financeInvoice.count({
    where: {
      projectId: scope.projectId,
      creditsInvoiceId: invoiceId,
      status: { not: "void" },
    },
  });
  if (credits) throw new DomainError("FINANCE_INVOICE_CREDITED", 409);

  const today = new Date().toISOString().slice(0, 10);
  const issued = invoice.issueDate.toISOString().slice(0, 10);
  const reversal = await reverseEntry(
    tx,
    scope,
    invoice.entryId,
    reason,
    issued > today ? issued : today,
  );
  if (ownIds.size)
    await tx.financePayment.updateMany({
      where: { projectId: scope.projectId, id: { in: [...ownIds] } },
      data: { voidedAt: new Date(), version: { increment: 1 } },
    });
  const updated = await tx.financeInvoice.updateMany({
    where: { projectId: scope.projectId, id: invoiceId, version },
    data: { status: "void", version: { increment: 1 } },
  });
  assertUpdated(updated.count);
  if (invoice.creditsInvoiceId)
    await refreshInvoiceStatus(tx, scope, invoice.creditsInvoiceId, today);
  await audit(tx, scope, "finance.invoice.voided", invoiceId, {
    invoiceId,
    reversalId: reversal.id,
  });
  if (invoice.documentId) {
    const reopened = await tx.financeDocument.updateMany({
      where: {
        projectId: scope.projectId,
        id: invoice.documentId,
        status: "booked",
      },
      data: { status: "needs_review", version: { increment: 1 } },
    });
    if (reopened.count)
      await audit(tx, scope, "finance.document.reopened", invoice.documentId, {
        invoiceId,
      });
  }
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

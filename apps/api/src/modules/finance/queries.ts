import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { lastArchiveError } from "../../platform/email/archive.ts";
import { isoDate } from "./common.ts";
import { invoiceStatusView } from "./invoices.ts";
import { SYSTEM_ROLES } from "./ledger/accounts.ts";
import { listMailboxBindings } from "./mailboxes.ts";
import { invoiceBalances } from "./payments.ts";

// Read queries behind the finance HTTP API (spec §8). Every query is bound
// to the scope's project; an id of another project is simply not found.
// Lists are bounded by `limit`.

const day = (text: string) => new Date(`${text}T00:00:00.000Z`);
const limit = (max: number) =>
  z.coerce.number().int().min(1).max(max).default(max);
const flag = z.enum(["true", "false"]).transform((v) => v === "true");

/** Whether every system role has a live account (posting needs them all). */
export async function setupStatus(tx: DbTx, scope: Scope) {
  const rows = await tx.financeAccount.findMany({
    where: {
      projectId: scope.projectId,
      role: { in: [...SYSTEM_ROLES] },
      archivedAt: null,
    },
    select: { role: true },
  });
  const present = new Set(rows.map((row) => row.role));
  const missingRoles = SYSTEM_ROLES.filter((role) => !present.has(role));
  return { ready: missingRoles.length === 0, missingRoles };
}

const documentQuery = z
  .object({
    status: z
      .enum([
        "received",
        "needs_review",
        "failed",
        "duplicate",
        "booked",
        "rejected",
      ])
      .optional(),
    limit: limit(200),
  })
  .strict();

/** Documents, newest first, optionally of one status. */
export function listDocuments(tx: DbTx, scope: Scope, raw: unknown) {
  const query = documentQuery.parse(raw ?? {});
  return tx.financeDocument.findMany({
    where: {
      projectId: scope.projectId,
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
}

async function document(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeDocument.findFirst({
    where: { projectId: scope.projectId, id },
  });
  if (!row) throw new DomainError("FINANCE_DOCUMENT_NOT_FOUND", 404);
  return row;
}

/** One document with its correction history and the invoice booked from it. */
export async function documentDetail(tx: DbTx, scope: Scope, id: string) {
  const row = await document(tx, scope, id);
  const [revisions, invoices] = await Promise.all([
    tx.financeDocumentRevision.findMany({
      where: { projectId: scope.projectId, documentId: id },
      orderBy: { version: "asc" },
    }),
    tx.financeInvoice.findMany({
      where: { projectId: scope.projectId, documentId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, kind: true },
    }),
  ]);
  return { ...row, revisions, invoices };
}

/** The stored original of a document. */
export async function documentFile(tx: DbTx, scope: Scope, id: string) {
  const row = await document(tx, scope, id);
  return { fileId: row.fileId, mime: row.mimeType };
}

const entryQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    account: z.uuid().optional(),
    category: z.uuid().optional(),
    costCenter: z.uuid().optional(),
    kind: z.string().trim().min(1).max(40).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: limit(500),
  })
  .strict();

const linesOf = (tx: DbTx, scope: Scope, entryIds: string[]) =>
  tx.financeJournalLine.findMany({
    where: { projectId: scope.projectId, entryId: { in: entryIds } },
    orderBy: [{ entryId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

/**
 * Journal entries, newest first, with their lines. Account, category and
 * cost center match entries with at least one such line; `q` searches the
 * number and memo.
 */
export async function listEntries(tx: DbTx, scope: Scope, raw: unknown) {
  const query = entryQuery.parse(raw ?? {});
  const where: Prisma.FinanceJournalEntryWhereInput = {
    projectId: scope.projectId,
  };
  if (query.from || query.to)
    where.entryDate = {
      ...(query.from ? { gte: day(query.from) } : {}),
      ...(query.to ? { lte: day(query.to) } : {}),
    };
  if (query.kind) where.kind = query.kind;
  if (query.q)
    where.OR = [
      { number: { contains: query.q, mode: "insensitive" } },
      { memo: { contains: query.q, mode: "insensitive" } },
    ];
  if (query.account || query.category || query.costCenter) {
    const matching = await tx.financeJournalLine.findMany({
      where: {
        projectId: scope.projectId,
        ...(query.account ? { accountId: query.account } : {}),
        ...(query.category ? { categoryId: query.category } : {}),
        ...(query.costCenter ? { costCenterId: query.costCenter } : {}),
      },
      select: { entryId: true },
      distinct: ["entryId"],
    });
    where.id = { in: matching.map((line) => line.entryId) };
  }
  const entries = await tx.financeJournalEntry.findMany({
    where,
    orderBy: [{ entryDate: "desc" }, { number: "desc" }],
    take: query.limit,
  });
  const lines = await linesOf(
    tx,
    scope,
    entries.map((entry) => entry.id),
  );
  return entries.map((entry) => ({
    ...entry,
    lines: lines.filter((line) => line.entryId === entry.id),
  }));
}

/** One journal entry with its lines. */
export async function entryDetail(tx: DbTx, scope: Scope, id: string) {
  const entry = await tx.financeJournalEntry.findFirst({
    where: { projectId: scope.projectId, id },
  });
  if (!entry) throw new DomainError("FINANCE_ENTRY_NOT_FOUND", 404);
  // A payment's entry names the invoices the payment was allocated to.
  let paymentInvoices: Array<{ id: string; number: string | null }> = [];
  if (entry.sourceType === "payment" && entry.sourceId) {
    const allocations = await tx.financePaymentAllocation.findMany({
      where: { projectId: scope.projectId, paymentId: entry.sourceId },
      select: { invoiceId: true },
    });
    const invoices = await tx.financeInvoice.findMany({
      where: {
        projectId: scope.projectId,
        id: { in: allocations.map((a) => a.invoiceId) },
      },
      select: { id: true, number: true },
      orderBy: { issueDate: "asc" },
    });
    paymentInvoices = invoices;
  }
  return { ...entry, lines: await linesOf(tx, scope, [id]), paymentInvoices };
}

const invoiceQuery = z
  .object({
    direction: z.enum(["payable", "receivable"]).optional(),
    status: z
      .enum(["open", "partially_paid", "paid", "void", "overdue"])
      .optional(),
    overdue: flag.optional(),
    limit: limit(500),
  })
  .strict();

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Invoices by due date with the status to show (overdue is derived, never
 * stored) and what is still open. `status` filters on the shown status.
 */
export async function listInvoices(tx: DbTx, scope: Scope, raw: unknown) {
  const query = invoiceQuery.parse(raw ?? {});
  const wanted = query.overdue ? "overdue" : query.status;
  const stored =
    wanted === "overdue"
      ? { in: ["open", "partially_paid"] }
      : wanted
        ? { equals: wanted }
        : undefined;
  const invoices = await tx.financeInvoice.findMany({
    where: {
      projectId: scope.projectId,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(stored ? { status: stored } : {}),
      ...(wanted === "overdue" ? { dueDate: { lt: day(today()) } } : {}),
    },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }, { id: "asc" }],
    take: query.limit,
  });
  const balances = await invoiceBalances(tx, scope, invoices);
  const now = today();
  return invoices
    .map((invoice) => ({
      ...invoice,
      displayStatus: invoiceStatusView(invoice, now),
      openAmountMicros: balances.get(invoice.id)?.openAmountMicros ?? null,
    }))
    .filter((invoice) => !wanted || invoice.displayStatus === wanted);
}

/**
 * One invoice with its lines, every allocation (with `voidedAt` of its
 * payment, null while the payment is live) and the open amount.
 */
export async function invoiceDetail(tx: DbTx, scope: Scope, id: string) {
  const invoice = await tx.financeInvoice.findFirst({
    where: { projectId: scope.projectId, id },
  });
  if (!invoice) throw new DomainError("FINANCE_INVOICE_NOT_FOUND", 404);
  const [lines, allocations, balances] = await Promise.all([
    tx.financeInvoiceLine.findMany({
      where: { projectId: scope.projectId, invoiceId: id },
      orderBy: { position: "asc" },
    }),
    tx.financePaymentAllocation.findMany({
      where: { projectId: scope.projectId, invoiceId: id },
      orderBy: { createdAt: "asc" },
    }),
    invoiceBalances(tx, scope, [invoice]),
  ]);
  const payments = allocations.length
    ? await tx.financePayment.findMany({
        where: {
          projectId: scope.projectId,
          id: { in: allocations.map((a) => a.paymentId) },
        },
        select: { id: true, voidedAt: true },
      })
    : [];
  const voided = new Map(payments.map((p) => [p.id, p.voidedAt]));
  return {
    ...invoice,
    displayStatus: invoiceStatusView(invoice, today()),
    openAmountMicros: balances.get(id)?.openAmountMicros ?? null,
    lines,
    allocations: allocations.map((a) => ({
      ...a,
      voidedAt: voided.get(a.paymentId) ?? null,
    })),
  };
}

/** The project's exports, newest first. */
export function listExports(tx: DbTx, scope: Scope) {
  return tx.financeExport.findMany({
    where: { projectId: scope.projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

/** The stored file of an export. */
export async function exportFile(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeExport.findFirst({
    where: { projectId: scope.projectId, id },
  });
  if (!row) throw new DomainError("FINANCE_EXPORT_NOT_FOUND", 404);
  return { fileId: row.fileId };
}

const rateQuery = z.object({ date: isoDate.optional() }).strict();

/** Stored per-EUR rates of one day, or the latest 200 without a date. */
export function listFxRates(tx: DbTx, scope: Scope, raw: unknown) {
  const { date } = rateQuery.parse(raw ?? {});
  return tx.financeFxRate.findMany({
    where: {
      projectId: scope.projectId,
      ...(date ? { date: day(date) } : {}),
    },
    orderBy: [{ date: "desc" }, { currency: "asc" }, { source: "asc" }],
    take: 200,
  });
}

/** The finance mailbox bindings with their mailbox's latest archive error. */
export async function mailboxesView(tx: DbTx, scope: Scope) {
  const bindings = await listMailboxBindings(tx, scope);
  const items = [];
  for (const binding of bindings)
    items.push({
      ...binding,
      lastArchiveError: await lastArchiveError(
        tx,
        scope,
        binding.emailConnectionId,
      ),
    });
  return items;
}

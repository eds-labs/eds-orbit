import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, canonical, data, DomainError } from "../../shared.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { allocationSchema, assertUpdated, isoDate, versionField } from "./common.ts";
import { EXTRACTION_SCHEMA_VERSION } from "./extraction/schema.ts";
import type { Normalized } from "./extraction/validate.ts";
import { FINANCE_EXTRACT } from "./intake/documents.ts";
import {
  dedupeKeys,
  duplicateCheck,
  type DedupeKeys,
} from "./intake/duplicates.ts";
import { archiveMailWhenDone } from "./intake/mail.ts";
import { bookingInput, createInvoice, type BookingRequest } from "./invoices.ts";
import { isCurrency, parseAmount } from "./money.ts";
import { readFinanceSettings } from "./settings.ts";

// Human review of finance documents (spec §6, §7): a person corrects the
// draft, decides on possible duplicates, rejects, retries a failed
// extraction, or books the document. Booking is the step where a draft
// becomes an invoice with posted journal entries. Every action checks the
// document version (409 VERSION_CONFLICT) and is audited without content.

export type DocumentView = Prisma.FinanceDocumentGetPayload<object>;

const EDITABLE = ["needs_review", "failed"];
const REJECTABLE = ["received", "needs_review", "failed", "duplicate"];
const POSSIBLE_DUPLICATE = "possible_duplicate";
/** Draft fields whose change can make the document a duplicate. */
const DEDUPE_FIELDS = [
  "counterpartyId",
  "number",
  "totalMicros",
  "currency",
  "issueDate",
];

const decimal = z.string().trim().min(1).max(32);

/**
 * A correction of the stored draft; omitted fields stay as they are, null
 * clears one. Amounts are decimal strings in the draft's currency.
 */
export const draftPatch = z
  .object({
    docType: z.enum(["invoice", "receipt", "credit_note", "other"]).optional(),
    direction: z.enum(["payable", "receivable"]).optional(),
    counterpartyId: z.uuid().nullable().optional(),
    number: z.string().trim().max(80).nullable().optional(),
    issueDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    currency: z.string().trim().nullable().optional(),
    net: decimal.nullable().optional(),
    tax: decimal.nullable().optional(),
    total: decimal.nullable().optional(),
    lines: z
      .array(
        z
          .object({
            description: z.string().trim().max(500),
            amount: decimal.nullable(),
            tax: decimal.nullable(),
            categoryId: z.uuid().nullable().optional(),
            allocation: allocationSchema.nullable().optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();

export type DraftPatch = z.input<typeof draftPatch>;

/** The stored draft (the extraction JSON, micros as strings). */
type Stored = Record<string, unknown> & {
  counterpartyId?: string | null;
  counterparty?: { name?: string; normalizedName?: string };
  number?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  totalMicros?: string | null;
  netMicros?: string | null;
  taxMicros?: string | null;
  confidence?: number;
  dedupe?: DedupeKeys;
  suggestion?: { counterpartyId?: string };
  extractionAttempt?: number;
};

const unique = (flags: string[]) => [...new Set(flags)];
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function loadDocument(tx: DbTx, scope: Scope, id: string) {
  const doc = await tx.financeDocument.findFirst({
    where: { projectId: scope.projectId, id },
  });
  if (!doc) throw new DomainError("FINANCE_DOCUMENT_NOT_FOUND", 404);
  return doc;
}

function assertVersion(doc: { version: number }, version: number) {
  if (doc.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
}

/** Moves a document on, guarded by its version and current status. */
async function moveDocument(
  tx: DbTx,
  scope: Scope,
  doc: DocumentView,
  data: Prisma.FinanceDocumentUpdateManyMutationInput,
) {
  const updated = await tx.financeDocument.updateMany({
    where: {
      projectId: scope.projectId,
      id: doc.id,
      version: doc.version,
      status: doc.status,
    },
    data: { ...data, version: { increment: 1 } },
  });
  assertUpdated(updated.count);
}

/**
 * Asks for the mail archive when the document's mail is now done
 * (`archiveMailWhenDone`). A refused request never undoes the review
 * action; the mail stays in the inbox.
 */
async function archiveWhenDone(tx: DbTx, scope: Scope, doc: DocumentView) {
  if (doc.source !== "email" || !doc.inboundEmailId || !doc.mailboxId || !doc.messageId)
    return;
  try {
    await archiveMailWhenDone(tx, scope, {
      inboundEmailId: doc.inboundEmailId,
      mailboxId: doc.mailboxId,
      messageId: doc.messageId,
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
}

/** The stored draft read back as a normalized extraction for duplicateCheck. */
function asNormalized(stored: Stored, normalizedName: string): Normalized {
  const micros = (value: string | null | undefined) =>
    value === null || value === undefined ? null : BigInt(value);
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    docType: "invoice",
    direction: "unknown",
    counterparty: {
      name: stored.counterparty?.name ?? "",
      normalizedName,
      taxId: null,
      email: null,
    },
    number: stored.number ?? null,
    issueDate: stored.issueDate ?? null,
    dueDate: stored.dueDate ?? null,
    currency: stored.currency ?? null,
    netMicros: micros(stored.netMicros),
    taxMicros: micros(stored.taxMicros),
    totalMicros: micros(stored.totalMicros),
    paid: false,
    paymentMethod: null,
    lines: [],
    confidence: stored.confidence ?? 0,
    flags: [],
  };
}

/**
 * Applies a person's correction to a draft in `needs_review` or `failed`.
 * Changed fields are recorded as a revision (before/after) under the new
 * version. A change of counterparty, number, total, currency or issue date
 * recomputes the dedupe keys and re-runs the duplicate check; a match only
 * sets `possible_duplicate` (the status stays), which blocks booking until
 * `markNotDuplicate` or rejection.
 */
export async function updateDraft(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  version: number,
  raw: DraftPatch,
): Promise<DocumentView> {
  const patch = draftPatch.parse(raw);
  const doc = await loadDocument(tx, scope, documentId);
  if (!EDITABLE.includes(doc.status))
    throw new DomainError("FINANCE_DOCUMENT_NOT_EDITABLE", 409);
  assertVersion(doc, version);
  const before = (doc.extraction ?? {}) as Stored;

  const next: Record<string, unknown> = {};
  if (patch.currency !== undefined) {
    const code = patch.currency ? patch.currency.toUpperCase() : null;
    if (code !== null && !isCurrency(code))
      throw new DomainError("CURRENCY_UNSUPPORTED", 422);
    next.currency = code;
  }
  const currency = (
    "currency" in next ? next.currency : before.currency ?? null
  ) as string | null;
  const money = (text: string | null) => {
    if (text === null) return null;
    if (!currency) throw new DomainError("FINANCE_CURRENCY_REQUIRED", 422);
    return parseAmount(text, currency).toString();
  };
  let counterparty: { name: string; normalizedName: string } | null = null;
  if (patch.counterpartyId) {
    counterparty = await tx.financeCounterparty.findFirst({
      where: { projectId: scope.projectId, id: patch.counterpartyId },
      select: { name: true, normalizedName: true },
    });
    if (!counterparty)
      throw new DomainError("FINANCE_COUNTERPARTY_INVALID", 422);
  }
  if (patch.docType !== undefined) next.docType = patch.docType;
  if (patch.direction !== undefined) next.direction = patch.direction;
  if (patch.counterpartyId !== undefined) next.counterpartyId = patch.counterpartyId;
  if (patch.number !== undefined) next.number = patch.number || null;
  if (patch.issueDate !== undefined) next.issueDate = patch.issueDate;
  if (patch.dueDate !== undefined) next.dueDate = patch.dueDate;
  if (patch.net !== undefined) next.netMicros = money(patch.net);
  if (patch.tax !== undefined) next.taxMicros = money(patch.tax);
  if (patch.total !== undefined) next.totalMicros = money(patch.total);
  if (patch.lines !== undefined)
    next.lines = patch.lines.map((line) => ({
      description: line.description,
      amountMicros: money(line.amount),
      taxMicros: money(line.tax),
      categoryId: line.categoryId ?? null,
      allocation: line.allocation ?? null,
    }));

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(next))
    if (canonical(before[key] ?? null) !== canonical(value))
      changes[key] = { before: before[key] ?? null, after: value };
  const fields = Object.keys(changes).sort();
  if (fields.length === 0) return doc;

  const draft: Stored = { ...before, ...next };
  let flags = doc.flags;
  if (fields.some((field) => DEDUPE_FIELDS.includes(field))) {
    // The person's counterparty wins over the extracted one.
    const counterpartyId =
      "counterpartyId" in draft
        ? (draft.counterpartyId ?? null)
        : (before.dedupe?.counterpartyId ?? null);
    if (!counterparty && counterpartyId)
      counterparty = await tx.financeCounterparty.findFirst({
        where: { projectId: scope.projectId, id: counterpartyId },
        select: { name: true, normalizedName: true },
      });
    const normalizedName =
      counterparty?.normalizedName ??
      before.dedupe?.normalizedName ??
      before.counterparty?.normalizedName ??
      "";
    const n = asNormalized(draft, normalizedName);
    draft.dedupe = dedupeKeys(n, counterpartyId);
    const { settings } = await readFinanceSettings(tx, scope);
    const duplicate = await duplicateCheck(tx, scope, doc.id, n, {
      counterpartyId,
      windowDays: settings.duplicateWindowDays,
    });
    const match = duplicate.duplicateOfId ?? duplicate.possible;
    if (match) {
      flags = unique([...flags, POSSIBLE_DUPLICATE]);
      draft.possibleDuplicateOfId = match;
    }
  }

  await moveDocument(tx, scope, doc, {
    extraction: json(draft),
    flags,
    ...(patch.docType ? { docType: patch.docType } : {}),
  });
  await tx.financeDocumentRevision.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      documentId: doc.id,
      version: doc.version + 1,
      actorUserId: scope.userId,
      changes: json(changes),
    },
  });
  await audit(tx, scope, "finance.document.edited", doc.id, { fields });
  return loadDocument(tx, scope, doc.id);
}

/**
 * Books a document in `needs_review` whose `possible_duplicate` flag is
 * cleared: creates the invoice and its posting (and the payment when
 * `paid` is set) from what the person confirmed, marks the document
 * `booked` and, with `archiveAfter` "booked", asks for the mail archive.
 * The version check inside the project lock books a document at most once.
 */
export async function bookDocument(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  raw: { version: number; booking: BookingRequest },
): Promise<{ invoiceId: string; entryId: string; paymentId?: string }> {
  const version = versionField.parse(raw.version);
  const booking = bookingInput.parse(raw.booking);
  const doc = await loadDocument(tx, scope, documentId);
  assertVersion(doc, version);
  if (doc.status !== "needs_review")
    throw new DomainError("FINANCE_DOCUMENT_NOT_REVIEWABLE", 409);
  if (doc.flags.includes(POSSIBLE_DUPLICATE))
    throw new DomainError("FINANCE_POSSIBLE_DUPLICATE", 409);
  await moveDocument(tx, scope, doc, { status: "booked", docType: booking.kind });
  const result = await createInvoice(tx, scope, booking, { documentId: doc.id });
  await audit(tx, scope, "finance.document.booked", doc.id, {
    invoiceId: result.invoiceId,
    entryId: result.entryId,
    ...(result.paymentId ? { paymentId: result.paymentId } : {}),
    kind: booking.kind,
    lines: booking.lines.length,
  });
  const { settings } = await readFinanceSettings(tx, scope);
  if (settings.archiveAfter === "booked") await archiveWhenDone(tx, scope, doc);
  return result;
}

export const rejectInput = z
  .object({ version: versionField, reason: z.string().trim().min(1).max(1000) })
  .strict();

/**
 * Rejects a document that is not booked. The reason is stored on the
 * document and never in the audit; the mail is archived when this was the
 * last document of it finance waited for.
 */
export async function rejectDocument(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  raw: { version: number; reason: string },
): Promise<DocumentView> {
  const { version, reason } = rejectInput.parse(raw);
  const doc = await loadDocument(tx, scope, documentId);
  assertVersion(doc, version);
  if (!REJECTABLE.includes(doc.status))
    throw new DomainError("FINANCE_DOCUMENT_NOT_REVIEWABLE", 409);
  await moveDocument(tx, scope, doc, {
    status: "rejected",
    rejectionReason: reason,
  });
  await audit(tx, scope, "finance.document.rejected", doc.id, {
    from: doc.status,
  });
  await archiveWhenDone(tx, scope, doc);
  return loadDocument(tx, scope, doc.id);
}

/**
 * A person's decision that a document is not a duplicate: clears the
 * `possible_duplicate` flag, or turns a semantic `duplicate` back into
 * `needs_review` without its link. An exact copy (same content as a live
 * document) stays a duplicate (409 FINANCE_EXACT_DUPLICATE).
 */
export async function markNotDuplicate(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  raw: { version: number },
): Promise<DocumentView> {
  const version = versionField.parse(raw.version);
  const doc = await loadDocument(tx, scope, documentId);
  assertVersion(doc, version);
  const flags = doc.flags.filter((flag) => flag !== POSSIBLE_DUPLICATE);
  const extraction = doc.extraction
    ? json({ ...(doc.extraction as Stored), possibleDuplicateOfId: null })
    : undefined;
  if (doc.status === "duplicate") {
    const live = await tx.financeDocument.count({
      where: {
        projectId: scope.projectId,
        sha256: doc.sha256,
        id: { not: doc.id },
        status: { notIn: ["rejected", "duplicate"] },
      },
    });
    if (live) throw new DomainError("FINANCE_EXACT_DUPLICATE", 409);
    await moveDocument(tx, scope, doc, {
      status: "needs_review",
      duplicateOfId: null,
      flags,
      ...(extraction ? { extraction } : {}),
    });
  } else if (
    EDITABLE.includes(doc.status) &&
    doc.flags.includes(POSSIBLE_DUPLICATE)
  ) {
    await moveDocument(tx, scope, doc, {
      flags,
      ...(extraction ? { extraction } : {}),
    });
  } else throw new DomainError("FINANCE_NOT_DUPLICATE", 409);
  await audit(tx, scope, "finance.document.not_duplicate", doc.id, {
    from: doc.status,
  });
  return loadDocument(tx, scope, doc.id);
}

const extractKey = (documentId: string, attempt: number) =>
  attempt ? `finance-extract:${documentId}:${attempt}` : `finance-extract:${documentId}`;

/**
 * Runs extraction again under a new job (`finance-extract:<id>:<n>`, the
 * attempt counter kept in the extraction metadata). Allowed for a `failed`
 * document, which goes back to `received`, and for one still in
 * `received` whose current job ended `blocked_dependency` or `failed`;
 * otherwise 409 FINANCE_EXTRACTION_RUNNING.
 */
export async function retryExtraction(
  tx: DbTx,
  scope: Scope,
  documentId: string,
): Promise<DocumentView> {
  const doc = await loadDocument(tx, scope, documentId);
  const stored = (doc.extraction ?? {}) as Stored;
  const attempt = Number(stored.extractionAttempt ?? 0);
  if (doc.status === "received") {
    const job = await tx.entity.findFirst({
      where: {
        projectId: scope.projectId,
        kind: "jobs",
        data: { path: ["idempotencyKey"], equals: extractKey(doc.id, attempt) },
      },
    });
    const ended =
      !job || ["blocked_dependency", "failed"].includes(String(data(job).status));
    if (!ended) throw new DomainError("FINANCE_EXTRACTION_RUNNING", 409);
  } else if (doc.status !== "failed")
    throw new DomainError("FINANCE_EXTRACTION_RUNNING", 409);
  const next = attempt + 1;
  await moveDocument(tx, scope, doc, {
    status: "received",
    flags: doc.flags.filter((flag) => flag !== "extraction_failed"),
    extraction: json({ ...stored, extractionAttempt: next }),
  });
  await enqueue(tx, scope, FINANCE_EXTRACT, doc.id, extractKey(doc.id, next));
  await audit(tx, scope, "finance.extraction.retried", doc.id, {
    attempt: next,
  });
  return loadDocument(tx, scope, doc.id);
}

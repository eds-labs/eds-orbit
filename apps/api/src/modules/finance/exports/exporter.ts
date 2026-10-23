import { createHash, randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import {
  maxFileBytes,
  readFile,
  storeFile,
} from "../../../platform/files/files.ts";
import { isoDate } from "../common.ts";
import { formatMicros } from "../money.ts";
import { readFinanceSettings } from "../settings.ts";
import { csvFile, csvRow } from "./csv.ts";
import {
  safeNamePart,
  storedZip,
  uniqueEntryName,
  ZIP_MAX_ENTRIES,
  type ZipEntry,
} from "./zip.ts";
import { yearOverviewExporter } from "./year.ts";

/** Inclusive ISO dates (`YYYY-MM-DD`). */
export type ExportPeriod = { from: string; to: string };

export type FinanceExporter = {
  id: string;
  label: string;
  build(
    tx: DbTx,
    scope: Scope,
    period: ExportPeriod,
  ): Promise<{
    /** Or a function that assembles them after the transaction. */
    bytes: Uint8Array | (() => Promise<Uint8Array>);
    mime: string;
    name: string;
    rowCount: number;
  }>;
};

/** 413 EXPORT_TOO_LARGE; the message tells the user to export less. */
const tooLarge = () =>
  Object.assign(new DomainError("EXPORT_TOO_LARGE", 413), {
    message: "EXPORT_TOO_LARGE: export a shorter period",
  });

// Uncompressed receipts allowed in one ZIP; keeps memory bounded.
export const ZIP_SOURCE_LIMIT = 200 * 1024 * 1024;
const CHUNK = 500;
const day = (date: Date) => date.toISOString().slice(0, 10);
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK)
    out.push(items.slice(i, i + CHUNK));
  return out;
}

const JOURNAL_COLUMNS = [
  "entry_number",
  "entry_date",
  "kind",
  "account_code",
  "account_name",
  "side",
  "currency",
  "amount",
  "fx_rate",
  "rate_date",
  "rate_source",
  "base_currency",
  "base_amount",
  "category",
  "cost_center",
  "counterparty",
  "document_number",
  "document_id",
  "memo",
];

/** Booked invoices by document id, with the counterparty name. */
async function invoiceContext(
  tx: DbTx,
  scope: Scope,
  where: { documentIds?: string[]; entryIds?: string[] },
) {
  const invoices = [];
  for (const ids of chunks(where.documentIds ?? []))
    invoices.push(
      ...(await tx.financeInvoice.findMany({
        where: {
          projectId: scope.projectId,
          status: { not: "void" },
          documentId: { in: ids },
        },
      })),
    );
  for (const ids of chunks(where.entryIds ?? []))
    invoices.push(
      ...(await tx.financeInvoice.findMany({
        where: {
          projectId: scope.projectId,
          status: { not: "void" },
          entryId: { in: ids },
        },
      })),
    );
  const counterpartyIds = [
    ...new Set(
      invoices.flatMap((i) => (i.counterpartyId ? [i.counterpartyId] : [])),
    ),
  ];
  const names = new Map<string, string>();
  for (const ids of chunks(counterpartyIds))
    for (const c of await tx.financeCounterparty.findMany({
      where: { projectId: scope.projectId, id: { in: ids } },
      select: { id: true, name: true },
    }))
      names.set(c.id, c.name);
  return { invoices, names };
}

/** Every posted line of the entries dated in the period, one row each. */
async function buildJournal(tx: DbTx, scope: Scope, period: ExportPeriod) {
  const { settings } = await readFinanceSettings(tx, scope);
  const entries = (
    await tx.financeJournalEntry.findMany({
      where: {
        projectId: scope.projectId,
        status: "posted",
        entryDate: { gte: at(period.from), lte: at(period.to) },
      },
    })
  ).sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

  const lines: Awaited<ReturnType<typeof tx.financeJournalLine.findMany>> = [];
  for (const ids of chunks(entries.map((e) => e.id)))
    lines.push(
      ...(await tx.financeJournalLine.findMany({
        where: { projectId: scope.projectId, entryId: { in: ids } },
      })),
    );
  const byEntry = new Map<string, typeof lines>();
  for (const line of lines)
    byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);

  const ids = (pick: (l: (typeof lines)[number]) => string | null) => [
    ...new Set(lines.flatMap((l) => (pick(l) ? [pick(l)!] : []))),
  ];
  const accounts = new Map<string, { code: string; name: string }>();
  const categories = new Map<string, { name: string }>();
  const centers = new Map<string, { name: string }>();
  for (const part of chunks(ids((l) => l.accountId)))
    for (const r of await tx.financeAccount.findMany({
      where: { projectId: scope.projectId, id: { in: part } },
    }))
      accounts.set(r.id, r);
  for (const part of chunks(ids((l) => l.categoryId)))
    for (const r of await tx.financeCategory.findMany({
      where: { projectId: scope.projectId, id: { in: part } },
    }))
      categories.set(r.id, r);
  for (const part of chunks(ids((l) => l.costCenterId)))
    for (const r of await tx.financeCostCenter.findMany({
      where: { projectId: scope.projectId, id: { in: part } },
    }))
      centers.set(r.id, r);
  const { invoices, names } = await invoiceContext(tx, scope, {
    documentIds: entries.flatMap((e) => (e.documentId ? [e.documentId] : [])),
    entryIds: entries.map((e) => e.id),
  });
  const byDocument = new Map(
    invoices.flatMap((i) => (i.documentId ? [[i.documentId, i] as const] : [])),
  );
  const byInvoiceEntry = new Map(
    invoices.flatMap((i) => (i.entryId ? [[i.entryId, i] as const] : [])),
  );

  const rows = [csvRow(JOURNAL_COLUMNS)];
  let rowCount = 0;
  for (const entry of entries) {
    const invoice =
      (entry.documentId ? byDocument.get(entry.documentId) : undefined) ??
      byInvoiceEntry.get(entry.id);
    const ordered = [...(byEntry.get(entry.id) ?? [])].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
    for (const line of ordered) {
      const account = accounts.get(line.accountId);
      rows.push(
        csvRow([
          entry.number,
          day(entry.entryDate),
          entry.kind,
          account?.code ?? null,
          account?.name ?? null,
          line.side,
          line.currency,
          formatMicros(line.amountMicros, line.currency),
          line.fxRate.toFixed(12),
          day(line.rateDate),
          line.rateSource,
          settings.baseCurrency,
          formatMicros(line.baseAmountMicros, settings.baseCurrency),
          line.categoryId
            ? (categories.get(line.categoryId)?.name ?? null)
            : null,
          line.costCenterId
            ? (centers.get(line.costCenterId)?.name ?? null)
            : null,
          invoice?.counterpartyId
            ? (names.get(invoice.counterpartyId) ?? null)
            : null,
          invoice?.number ?? null,
          entry.documentId,
          entry.memo,
        ]),
      );
      rowCount += 1;
    }
  }
  return {
    bytes: csvFile(rows),
    mime: "text/csv",
    name: `finance-journal_${period.from}_${period.to}.csv`,
    rowCount,
  };
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/xml": "xml",
  "message/rfc822": "eml",
};
const NAME_MAX = 120;

/**
 * The originals of documents booked with an issue date in the period, plus
 * documents still in review (folder `pending/`), with an `index.csv`.
 */
async function buildDocuments(tx: DbTx, scope: Scope, period: ExportPeriod) {
  const invoices = await tx.financeInvoice.findMany({
    where: {
      projectId: scope.projectId,
      status: { not: "void" },
      documentId: { not: null },
      issueDate: { gte: at(period.from), lte: at(period.to) },
    },
    orderBy: [{ issueDate: "asc" }, { number: "asc" }, { id: "asc" }],
  });
  const booked = new Map<
    string,
    { id: string; fileId: string; mimeType: string }
  >();
  for (const ids of chunks(invoices.map((i) => i.documentId!)))
    for (const d of await tx.financeDocument.findMany({
      where: { projectId: scope.projectId, status: "booked", id: { in: ids } },
    }))
      booked.set(d.id, d);
  const pending = await tx.financeDocument.findMany({
    where: {
      projectId: scope.projectId,
      status: "needs_review",
      createdAt: {
        gte: at(period.from),
        lt: new Date(at(period.to).getTime() + 86_400_000),
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const counterpartyNames = new Map<string, string>();
  for (const ids of chunks([
    ...new Set(
      invoices.flatMap((i) => (i.counterpartyId ? [i.counterpartyId] : [])),
    ),
  ]))
    for (const c of await tx.financeCounterparty.findMany({
      where: { projectId: scope.projectId, id: { in: ids } },
      select: { id: true, name: true },
    }))
      counterpartyNames.set(c.id, c.name);
  const entryNumbers = new Map<string, string>();
  for (const ids of chunks(
    invoices.flatMap((i) => (i.entryId ? [i.entryId] : [])),
  ))
    for (const e of await tx.financeJournalEntry.findMany({
      where: { projectId: scope.projectId, id: { in: ids } },
      select: { id: true, number: true },
    }))
      entryNumbers.set(e.id, e.number);

  type Item = {
    documentId: string;
    fileId: string;
    mime: string;
    date: string;
    base: string;
    folder: string;
    entryNumber: string | null;
    total: string | null;
    currency: string | null;
  };
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const i of invoices) {
    const doc = booked.get(i.documentId!);
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    const counterparty = i.counterpartyId
      ? (counterpartyNames.get(i.counterpartyId) ?? "unknown")
      : "unknown";
    items.push({
      documentId: doc.id,
      fileId: doc.fileId,
      mime: doc.mimeType,
      date: day(i.issueDate),
      base: `${day(i.issueDate)}_${counterparty}_${i.number ?? "no-number"}`,
      folder: "",
      entryNumber: i.entryId ? (entryNumbers.get(i.entryId) ?? null) : null,
      total: formatMicros(i.totalMicros, i.currency),
      currency: i.currency,
    });
  }
  for (const d of pending)
    if (!seen.has(d.id)) {
      seen.add(d.id);
      items.push({
        documentId: d.id,
        fileId: d.fileId,
        mime: d.mimeType,
        date: day(d.createdAt),
        base: `${day(d.createdAt)}_needs-review_${d.id.slice(0, 8)}`,
        folder: "pending/",
        entryNumber: null,
        total: null,
        currency: null,
      });
    }
  if (items.length + 1 > ZIP_MAX_ENTRIES)
    throw new DomainError("EXPORT_TOO_LARGE", 413);

  // Names and sizes from the database only; no file is read yet.
  const sizes = new Map<string, number>();
  for (const ids of chunks(items.map((i) => i.fileId)))
    for (const f of await tx.file.findMany({
      where: { id: { in: ids }, projectId: scope.projectId, deletedAt: null },
      select: { id: true, size: true },
    }))
      sizes.set(f.id, f.size);
  const taken = new Set<string>(["index.csv"]);
  const planned = items.map((item) => {
    const extension = EXTENSIONS[item.mime] ?? "bin";
    const base = safeNamePart(item.base).slice(
      0,
      NAME_MAX - extension.length - 1,
    );
    const name = uniqueEntryName(`${item.folder}${base}.${extension}`, taken);
    return { item, name, size: sizes.get(item.fileId) ?? 0 };
  });
  assertZipFits(
    planned.map((p) => ({ size: p.size, nameLength: p.name.length })),
    Math.min(ZIP_SOURCE_LIMIT, maxFileBytes()),
  );

  // The files are read after the transaction (readFile opens its own).
  const assemble = async () => {
    const entries: ZipEntry[] = [];
    const index = [
      csvRow([
        "entry_name",
        "document_id",
        "entry_number",
        "total",
        "currency",
      ]),
    ];
    for (const { item, name } of planned) {
      const { bytes } = await readFile(scope, item.fileId);
      entries.push({ name, bytes, date: at(item.date) });
      index.push(
        csvRow([
          name,
          item.documentId,
          item.entryNumber,
          item.total,
          item.currency,
        ]),
      );
    }
    entries.push({
      name: "index.csv",
      bytes: csvFile(index),
      date: at(period.to),
    });
    return storedZip(entries);
  };
  return {
    bytes: assemble,
    mime: "application/zip",
    name: `finance-documents_${period.from}_${period.to}.zip`,
    rowCount: items.length,
  };
}

/**
 * 413 EXPORT_TOO_LARGE unless the sources, the ZIP headers and a bound for
 * `index.csv` fit in `limit` bytes. Checked before any file is read.
 */
export function assertZipFits(
  entries: { size: number; nameLength: number }[],
  limit: number,
) {
  // Per entry: local header 30 + central header 46 + the name twice, plus
  // an index row (name, id, number, amounts) of at most name + 160 bytes.
  let total = 22 + 3 + 100 + 8;
  for (const e of entries)
    total += e.size + 76 + 2 * e.nameLength + e.nameLength + 160;
  if (total > limit) throw tooLarge();
}

const journalExporter: FinanceExporter = {
  id: "journal_csv",
  label: "Journal (CSV)",
  build: buildJournal,
};
const documentsExporter: FinanceExporter = {
  id: "documents_zip",
  label: "Receipts (ZIP)",
  build: buildDocuments,
};

/** The exporters by id; later formats (DATEV) register themselves here. */
export const financeExporters = new Map<string, FinanceExporter>(
  [journalExporter, documentsExporter, yearOverviewExporter].map((e) => [
    e.id,
    e,
  ]),
);

function validPeriod({ from, to }: ExportPeriod) {
  const valid = (d: string) =>
    isoDate.safeParse(d).success &&
    new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) === d;
  if (!valid(from) || !valid(to) || from > to)
    throw new DomainError("EXPORT_PERIOD_INVALID", 422);
}

/**
 * Builds the export in a read transaction, stores the file (its own
 * transactions, so outside the first), then records the export and its
 * content-free audit event.
 */
export async function createExport(
  scope: Scope,
  input: { kind: string; from: string; to: string; userId: string },
) {
  const exporter = financeExporters.get(input.kind);
  if (!exporter) throw new DomainError("EXPORT_KIND_UNKNOWN", 422);
  const period = { from: input.from, to: input.to };
  validPeriod(period);
  const built = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    exporter.build(tx, scope, period),
  );
  const bytes =
    typeof built.bytes === "function" ? await built.bytes() : built.bytes;
  if (bytes.byteLength > maxFileBytes()) throw tooLarge();
  const file = await storeFile(scope, {
    moduleId: "finance",
    bytes,
    mime: built.mime,
    name: built.name,
    // Derived from the books and rebuilt on demand: never retention-locked
    // (final review I4), unlike the originals it is made of.
  });
  const id = randomUUID();
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await tx.financeExport.create({
      data: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: exporter.id,
        periodStart: at(period.from),
        periodEnd: at(period.to),
        fileId: file.id,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rowCount: built.rowCount,
        createdBy: input.userId,
      },
    });
    await audit(
      tx,
      { ...scope, userId: input.userId },
      "finance.export.created",
      id,
      {
        kind: exporter.id,
        rowCount: built.rowCount,
      },
    );
  });
  return { id, fileId: file.id };
}

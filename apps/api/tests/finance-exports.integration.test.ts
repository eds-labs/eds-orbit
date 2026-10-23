import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  readFile,
  setObjectStoreForTests,
} from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { listCategories } from "../src/modules/finance/categories.ts";
import { createCounterparty } from "../src/modules/finance/counterparties.ts";
import { createExport } from "../src/modules/finance/exports/exporter.ts";
import { ingestDocument } from "../src/modules/finance/intake/documents.ts";
import type { BookingRequest } from "../src/modules/finance/invoices.ts";
import { reverseEntry } from "../src/modules/finance/ledger/reversal.ts";
import { postManualEntry } from "../src/modules/finance/manual-entries.ts";
import { bookDocument } from "../src/modules/finance/review.ts";
import { applyFinanceTemplate } from "../src/modules/finance/setup.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const ENV = {
  ORBIT_FINANCE: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};

/** The stored entries of a ZIP written by storedZip (method 0). */
function unzip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true);
    const name = Buffer.from(
      zip.subarray(pos + 30, pos + 30 + nameLength),
    ).toString("utf8");
    const start = pos + 30 + nameLength;
    out.set(name, zip.subarray(start, start + size));
    pos = start + size;
  }
  return out;
}
const text = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("utf8").replace(/^﻿/, "");
const lines = (bytes: Uint8Array) =>
  text(bytes)
    .split("\r\n")
    .filter((l) => l !== "");

describe.skipIf(!enabled)("finance exports", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const previous: Record<string, string | undefined> = {};
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const scope = () => project.owner;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope().workspaceId, scope().projectId, fn);
  const year = new Date().getUTCFullYear();
  const pdf = () =>
    Buffer.concat([
      readFileSync(new URL("./fixtures/finance/invoice.pdf", import.meta.url)),
      Buffer.from(`%${randomUUID()}\n`),
    ]);

  let software = "";
  let counterpartyId = "";
  const accounts: Record<string, string> = {};

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    project = await createPackageProject({ name: "Synthetic finance exports" });
    await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          moduleId: "finance",
          enabled: true,
          moduleVersion: "1.0.0",
          settings: {},
        },
      });
      await applyFinanceTemplate(tx, scope());
      const categories = await listCategories(tx, scope());
      software = categories.find((c) => c.name === "Software & SaaS")!.id;
      for (const row of await tx.financeAccount.findMany())
        accounts[row.code] = row.id;
      counterpartyId = (
        await createCounterparty(tx, scope(), { name: "Acme =GmbH/Co" })
      ).id;
    });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setObjectStoreForTests(null);
    await project?.cleanup();
    await closeDatabase();
  });

  const exportFile = async (kind: string, from: string, to: string) => {
    const made = await createExport(scope(), {
      kind,
      from,
      to,
      userId: scope().userId,
    });
    return { ...made, ...(await readFile(scope(), made.fileId)) };
  };

  it("journal csv for a month lists every line once with base amounts", async () => {
    const post = (date: string, amount: string, memo?: string) =>
      run((tx) =>
        postManualEntry(tx, scope(), {
          kind: "adjustment",
          date,
          currency: "USD",
          memo,
          lines: [
            {
              accountId: accounts["6000"]!,
              side: "debit",
              amount,
              categoryId: software,
            },
            { accountId: accounts["1000"]!, side: "credit", amount },
          ],
        } as Parameters<typeof postManualEntry>[2]),
      );
    const first = await post("2025-03-05", "12.50", "=cmd|' /C calc'!A0");
    await post("2025-03-20", "7.00");
    await post("2025-04-01", "99.00");
    await run((tx) =>
      reverseEntry(tx, scope(), first.entryId, "Mistake", "2025-03-25"),
    );
    const { file, bytes, rowCount } = await (async () => {
      const made = await exportFile("journal_csv", "2025-03-01", "2025-03-31");
      const row = await run((tx) =>
        tx.financeExport.findUniqueOrThrow({ where: { id: made.id } }),
      );
      return { file: made.file, bytes: made.bytes, rowCount: row.rowCount };
    })();
    expect(file).toMatchObject({
      mime: "text/csv",
      name: "finance-journal_2025-03-01_2025-03-31.csv",
    });
    expect(file.retainUntil!.getUTCFullYear()).toBe(year + 10);
    const rows = lines(bytes);
    expect(rows[0]).toBe(
      "entry_number,entry_date,kind,account_code,account_name,side,currency,amount,fx_rate,rate_date,rate_source,base_currency,base_amount,category,cost_center,counterparty,document_number,document_id,memo",
    );
    // Three entries (two postings and one reversal) with two lines each.
    expect(rows).toHaveLength(1 + 6);
    expect(rowCount).toBe(6);
    expect(rows.filter((r) => r.includes(",reversal,"))).toHaveLength(2);
    expect(
      rows.some((r) => r.includes(",debit,USD,12.50,1.000000000000,")),
    ).toBe(true);
    expect(rows.some((r) => r.includes(",USD,12.50,1.000000000000,"))).toBe(
      true,
    );
    expect(rows.join("\n")).toContain(",USD,12.50,");
    expect(rows.join("\n")).toContain("'=cmd|");
    expect(rows.join("\n")).not.toContain("99.00");
    // The audit event carries counts only.
    const event = await run((tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: "finance.export.created" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(event.metadata).toEqual({ kind: "journal_csv", rowCount: 6 });
  });

  it("documents zip contains originals named <date>_<counterparty>_<number>.<ext>", async () => {
    const book = async (number: string) => {
      const id = (
        await ingestDocument(scope(), {
          source: "upload",
          bytes: pdf(),
          mime: "application/pdf",
        })
      ).id;
      const { version } = await run((tx) =>
        tx.financeDocument.findUniqueOrThrow({ where: { id } }),
      );
      await run((tx) =>
        bookDocument(tx, scope(), id, {
          version,
          booking: {
            kind: "invoice",
            direction: "payable",
            counterpartyId,
            number,
            issueDate: `${year}-02-03`,
            dueDate: `${year}-03-03`,
            currency: "USD",
            lines: [
              {
                description: "y",
                amount: "50.00",
                tax: "0.00",
                categoryId: software,
                allocation: [],
              },
            ],
          } as BookingRequest,
        }),
      );
      return id;
    };
    const bookedId = await book("ZIP/1");
    await book("ZIP/1");
    const pendingId = (
      await ingestDocument(scope(), {
        source: "upload",
        bytes: pdf(),
        mime: "application/pdf",
      })
    ).id;

    const { file, bytes } = await exportFile(
      "documents_zip",
      `${year}-01-01`,
      `${year}-12-31`,
    );
    expect(file).toMatchObject({ mime: "application/zip" });
    const zip = unzip(bytes);
    const names = [...zip.keys()];
    expect(names).toContain(`${year}-02-03_Acme__GmbH_Co_ZIP_1.pdf`);
    expect(names).toContain(`${year}-02-03_Acme__GmbH_Co_ZIP_1-2.pdf`);
    const pending = names.find((n) => n.startsWith("pending/"))!;
    expect(pending).toMatch(/\.pdf$/);
    expect(names.every((n) => /^[A-Za-z0-9._/-]+$/.test(n))).toBe(true);
    expect(
      Buffer.from(
        zip.get(`${year}-02-03_Acme__GmbH_Co_ZIP_1.pdf`)!.subarray(0, 5),
      ).toString(),
    ).toBe("%PDF-");
    const index = lines(zip.get("index.csv")!);
    expect(index[0]).toBe("entry_name,document_id,entry_number,total,currency");
    expect(
      index.some((r) => r.includes(bookedId) && r.includes(",50.00,USD")),
    ).toBe(true);
    expect(index.some((r) => r.includes(pendingId))).toBe(true);
  });

  it("year overview needs exactly one calendar year", async () => {
    const { bytes } = await exportFile(
      "year_overview",
      `${year}-01-01`,
      `${year}-12-31`,
    );
    const body = text(bytes);
    expect(body).toContain("Category by month");
    expect(body).toContain("Cost centers");
    expect(body).toContain(`Open items at ${year}-12-31`);
    expect(body).toContain("\r\n\r\nCost centers");
    expect(body).toContain("ZIP/1");
    await expect(
      createExport(scope(), {
        kind: "year_overview",
        from: `${year}-01-01`,
        to: `${year}-06-30`,
        userId: scope().userId,
      }),
    ).rejects.toMatchObject({ status: 422, code: "EXPORT_PERIOD_INVALID" });
  });

  it("rejects unknown kinds and reversed periods", async () => {
    const base = { from: "2025-01-01", to: "2025-01-31", userId: "u" };
    await expect(
      createExport(scope(), { ...base, kind: "datev" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createExport(scope(), {
        ...base,
        kind: "journal_csv",
        from: "2025-02-01",
      }),
    ).rejects.toMatchObject({ status: 422, code: "EXPORT_PERIOD_INVALID" });
  });
});

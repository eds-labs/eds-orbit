import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list, update } from "../src/shared.ts";
import { CONNECTION_KIND } from "../src/platform/connections/connections.ts";
import { INBOUND_KIND } from "../src/platform/email/send.ts";
import {
  setObjectStoreForTests,
  storeFile,
} from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { archiveAccount } from "../src/modules/finance/accounts.ts";
import { listCategories } from "../src/modules/finance/categories.ts";
import { createCostCenter } from "../src/modules/finance/cost-centers.ts";
import { createCounterparty } from "../src/modules/finance/counterparties.ts";
import { setManualRate } from "../src/modules/finance/fx.ts";
import {
  ingestDocument,
  recordDocument,
} from "../src/modules/finance/intake/documents.ts";
import {
  invoiceStatusView,
  voidInvoice,
  type BookingRequest,
} from "../src/modules/finance/invoices.ts";
import { systemAccounts } from "../src/modules/finance/ledger/accounts.ts";
import { bindMailbox } from "../src/modules/finance/mailboxes.ts";
import { postManualEntry } from "../src/modules/finance/manual-entries.ts";
import { recordPayment, voidPayment } from "../src/modules/finance/payments.ts";
import {
  bookDocument,
  markNotDuplicate,
  rejectDocument,
  retryExtraction,
  updateDraft,
} from "../src/modules/finance/review.ts";
import {
  readFinanceSettings,
  writeFinanceSettings,
} from "../src/modules/finance/settings.ts";
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
const pdf = () =>
  Buffer.concat([
    readFileSync(new URL("./fixtures/finance/invoice.pdf", import.meta.url)),
    Buffer.from(`%${randomUUID()}\n`),
  ]);

/**
 * Review and booking: documents become invoices with posted entries,
 * payments settle them (with fx differences and refunds), invoices are
 * voided by reversal, and manual entries post directly. Extraction is off,
 * so every upload lands in needs_review without a model call.
 */
describe.skipIf(!enabled)("finance booking", () => {
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
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "succeeded";
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };
  const doc = (id: string) =>
    run((tx) => tx.financeDocument.findUniqueOrThrow({ where: { id } }));
  const upload = async () =>
    (
      await ingestDocument(scope(), {
        source: "upload",
        bytes: pdf(),
        mime: "application/pdf",
      })
    ).id;
  const invoice = (id: string) =>
    run((tx) => tx.financeInvoice.findUniqueOrThrow({ where: { id } }));
  const lines = (entryId: string) =>
    run((tx) => tx.financeJournalLine.findMany({ where: { entryId } }));
  const audits = (action: string, resourceId?: string) =>
    run((tx) =>
      tx.auditEvent.findMany({
        where: { action, ...(resourceId ? { resourceId } : {}) },
      }),
    );

  let counterpartyId = "";
  let otherCounterpartyId = "";
  let expenseCategory = "";
  let incomeCategory = "";
  let costCenters: string[] = [];
  const accounts: Record<string, string> = {};

  const booking = (over: Record<string, unknown> = {}): BookingRequest =>
    ({
    kind: "invoice",
    direction: "payable",
    counterpartyId,
    number: `INV-${randomUUID().slice(0, 8)}`,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    currency: "USD",
    lines: [
      {
        description: "Service",
        amount: "100.00",
        tax: "19.00",
        categoryId: expenseCategory,
        allocation: [],
      },
    ],
    ...over,
    }) as BookingRequest;
  /** Uploads a document and books it. */
  const book = async (over: Record<string, unknown> = {}) => {
    const id = await upload();
    const { version } = await doc(id);
    const result = await run((tx) =>
      bookDocument(tx, scope(), id, { version, booking: booking(over) }),
    );
    return { documentId: id, ...result };
  };
  const pay = (input: Record<string, unknown>) =>
    run((tx) =>
      recordPayment(tx, scope(), {
        direction: "outgoing",
        accountId: accounts.bank,
        currency: "USD",
        ...input,
      } as Parameters<typeof recordPayment>[2]),
    );
  /** Net base (debits minus credits) on an account over some entries. */
  const netBase = async (accountId: string, entryIds: string[]) =>
    (
      await run((tx) =>
        tx.financeJournalLine.findMany({
          where: { accountId, entryId: { in: entryIds } },
        }),
      )
    ).reduce(
      (sum, l) =>
        sum + (l.side === "debit" ? l.baseAmountMicros : -l.baseAmountMicros),
      0n,
    );
  const rate = (date: string, perEur: string) =>
    run((tx) =>
      setManualRate(tx, scope(), { date, currency: "USD", perEur }),
    );

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    project = await createPackageProject({ name: "Synthetic finance booking" });
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
      expenseCategory = categories.find((c) => c.name === "Software & SaaS")!.id;
      incomeCategory = categories.find((c) => c.kind === "income")!.id;
      counterpartyId = (
        await createCounterparty(tx, scope(), { name: "Acme GmbH" })
      ).id;
      otherCounterpartyId = (
        await createCounterparty(tx, scope(), { name: "Globex LLC" })
      ).id;
      costCenters = [
        (await createCostCenter(tx, scope(), { code: "OPS", name: "Ops" })).id,
        (await createCostCenter(tx, scope(), { code: "MKT", name: "Marketing" }))
          .id,
      ];
      const rows = await tx.financeAccount.findMany();
      const byCode = (code: string) => rows.find((r) => r.code === code)!.id;
      accounts.bank = byCode("1000");
      accounts.card = byCode("1100");
      accounts.expenses = byCode("6000");
      accounts.revenue = byCode("4000");
      Object.assign(accounts, await systemAccounts(tx, scope()));
    });
    // USD per EUR on the September dates the EUR tests use.
    await rate("2026-09-01", "1.10");
    await rate("2026-09-10", "1.20");
    await rate("2026-09-20", "1.05");
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setObjectStoreForTests(null);
    await project?.cleanup();
    await closeDatabase();
  });

  it("books a payable invoice and leaves it open", async () => {
    const result = await book({
      lines: [
        {
          description: "Service",
          amount: "100.00",
          tax: "19.00",
          categoryId: expenseCategory,
          allocation: [
            { costCenterId: costCenters[0], bp: 6000 },
            { costCenterId: costCenters[1], bp: 4000 },
          ],
        },
      ],
    });
    expect(result.paymentId).toBeUndefined();
    const row = await invoice(result.invoiceId);
    expect(row).toMatchObject({
      status: "open",
      kind: "invoice",
      direction: "payable",
      netMicros: 100_000_000n,
      taxMicros: 19_000_000n,
      totalMicros: 119_000_000n,
      entryId: result.entryId,
      documentId: result.documentId,
    });
    expect(invoiceStatusView(row, "2026-10-15")).toBe("open");
    const posted = await lines(result.entryId);
    expect(
      posted
        .filter((l) => l.accountId === accounts.expenses)
        .map((l) => [l.side, l.amountMicros, l.costCenterId])
        .sort(),
    ).toEqual(
      [
        ["debit", 71_400_000n, costCenters[0]],
        ["debit", 47_600_000n, costCenters[1]],
      ].sort(),
    );
    expect(
      posted.find((l) => l.accountId === accounts.payables),
    ).toMatchObject({ side: "credit", amountMicros: 119_000_000n });
    const document = await doc(result.documentId);
    expect(document).toMatchObject({ status: "booked", docType: "invoice" });
    const invoiceLines = await run((tx) =>
      tx.financeInvoiceLine.findMany({ where: { invoiceId: result.invoiceId } }),
    );
    expect(invoiceLines).toHaveLength(1);
    const [booked] = await audits("finance.document.booked", result.documentId);
    expect(booked!.metadata).toEqual({
      invoiceId: result.invoiceId,
      entryId: result.entryId,
      kind: "invoice",
      lines: 1,
    });
    // Booked documents are no longer reviewable.
    expect(
      await failure(
        run((tx) =>
          bookDocument(tx, scope(), result.documentId, {
            version: document.version,
            booking: booking(),
          }),
        ),
      ),
    ).toBe("FINANCE_DOCUMENT_NOT_REVIEWABLE");
  });

  it("books a paid receipt with payment in one go", async () => {
    const result = await book({
      kind: "receipt",
      dueDate: undefined,
      paid: { accountId: accounts.card },
    });
    expect(result.paymentId).toBeDefined();
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    const posted = await lines(result.entryId);
    expect(posted.map((l) => [l.accountId, l.side, l.amountMicros]).sort()).toEqual(
      [
        [accounts.expenses, "debit", 119_000_000n],
        [accounts.card, "credit", 119_000_000n],
      ].sort(),
    );
    const payment = await run((tx) =>
      tx.financePayment.findUniqueOrThrow({ where: { id: result.paymentId! } }),
    );
    expect(payment).toMatchObject({
      direction: "outgoing",
      accountId: accounts.card,
      amountMicros: 119_000_000n,
      entryId: result.entryId,
    });
    // One posting for the document: the receipt is its own payment.
    expect(
      await run((tx) =>
        tx.financeJournalEntry.count({ where: { documentId: result.documentId } }),
      ),
    ).toBe(1);
    expect(payment.date.toISOString().slice(0, 10)).toBe("2026-10-01");
    // A receipt is paid on its issue date.
    expect(
      await failure(
        book({
          kind: "receipt",
          paid: { accountId: accounts.card, date: "2026-10-02" },
        }),
      ),
    ).toBe("FINANCE_DATE_INVALID");
    // A receipt without payment details is refused.
    expect(
      await failure(book({ kind: "receipt", number: undefined })),
    ).toBe("FINANCE_PAYMENT_REQUIRED");
  });

  it("books a paid invoice with a separate payment entry", async () => {
    const result = await book({
      paid: { accountId: accounts.bank, date: "2026-10-03" },
    });
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    const payment = await run((tx) =>
      tx.financePayment.findUniqueOrThrow({ where: { id: result.paymentId! } }),
    );
    expect(payment.entryId).not.toBe(result.entryId);
    expect(
      await netBase(accounts.payables, [result.entryId, payment.entryId!]),
    ).toBe(0n);
  });

  it("a document is booked at most once under concurrency", async () => {
    const id = await upload();
    const { version } = await doc(id);
    const attempt = () =>
      run((tx) => bookDocument(tx, scope(), id, { version, booking: booking() }));
    const outcomes = await Promise.allSettled([attempt(), attempt()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toMatchObject({ status: 409 });
    expect(
      await run((tx) => tx.financeJournalEntry.count({ where: { documentId: id } })),
    ).toBe(1);
    expect(
      await run((tx) => tx.financeInvoice.count({ where: { documentId: id } })),
    ).toBe(1);
  });

  it("refuses booking while possible_duplicate is set", async () => {
    const id = await upload();
    await run((tx) =>
      tx.financeDocument.update({
        where: { id },
        data: { flags: ["ai_off", "possible_duplicate"] },
      }),
    );
    const flagged = await doc(id);
    expect(
      await failure(
        run((tx) =>
          bookDocument(tx, scope(), id, {
            version: flagged.version,
            booking: booking(),
          }),
        ),
      ),
    ).toBe("FINANCE_POSSIBLE_DUPLICATE");
    const cleared = await run((tx) =>
      markNotDuplicate(tx, scope(), id, { version: flagged.version }),
    );
    expect(cleared.flags).toEqual(["ai_off"]);
    expect(cleared.version).toBe(flagged.version + 1);
    expect(await audits("finance.document.not_duplicate", id)).toHaveLength(1);
    await run((tx) =>
      bookDocument(tx, scope(), id, {
        version: cleared.version,
        booking: booking(),
      }),
    );
    expect((await doc(id)).status).toBe("booked");

    // A duplicate goes back to review without its link.
    const original = await upload();
    const copy = await upload();
    await run((tx) =>
      tx.financeDocument.update({
        where: { id: copy },
        data: { status: "duplicate", duplicateOfId: original },
      }),
    );
    const restored = await run(async (tx) =>
      markNotDuplicate(tx, scope(), copy, {
        version: (await tx.financeDocument.findUniqueOrThrow({ where: { id: copy } }))
          .version,
      }),
    );
    expect(restored).toMatchObject({ status: "needs_review", duplicateOfId: null });
  });

  it("draft edits are versioned with revision history", async () => {
    const number = `R-${randomUUID().slice(0, 8)}`;
    const first = await upload();
    const edited = await run((tx) =>
      updateDraft(tx, scope(), first, 1, {
        counterpartyId,
        number,
        currency: "USD",
        total: "50.00",
        issueDate: "2026-10-05",
      }),
    );
    expect(edited.version).toBe(2);
    expect(edited.status).toBe("needs_review");
    const revisions = await run((tx) =>
      tx.financeDocumentRevision.findMany({ where: { documentId: first } }),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      version: 2,
      actorUserId: scope().userId,
    });
    expect(revisions[0]!.changes).toMatchObject({
      number: { before: null, after: number },
      totalMicros: { before: null, after: "50000000" },
      counterpartyId: { before: null, after: counterpartyId },
    });
    const [audit] = await audits("finance.document.edited", first);
    expect(audit!.metadata).toEqual({
      fields: ["counterpartyId", "currency", "issueDate", "number", "totalMicros"],
    });
    // The stale version is refused.
    expect(
      await failure(
        run((tx) => updateDraft(tx, scope(), first, 1, { number: "X-1" })),
      ),
    ).toBe("VERSION_CONFLICT");

    // A second document edited to the same counterparty and number is only
    // flagged; a person decides.
    const second = await upload();
    const flagged = await run((tx) =>
      updateDraft(tx, scope(), second, 1, {
        counterpartyId,
        number: ` ${number.toLowerCase()} `,
        currency: "USD",
        total: "50.00",
        issueDate: "2026-10-05",
      }),
    );
    expect(flagged.status).toBe("needs_review");
    expect(flagged.flags).toContain("possible_duplicate");
    expect(flagged.extraction).toMatchObject({
      dedupe: { counterpartyId, numberKey: number.toLowerCase() },
      possibleDuplicateOfId: first,
    });
    expect(
      await failure(
        run((tx) =>
          bookDocument(tx, scope(), second, {
            version: flagged.version,
            booking: booking(),
          }),
        ),
      ),
    ).toBe("FINANCE_POSSIBLE_DUPLICATE");
  });

  it("partial then full payment updates status and posts fx difference", async () => {
    const result = await book({
      issueDate: "2026-09-01",
      dueDate: "2026-09-30",
      currency: "EUR",
      lines: [
        {
          description: "Hosting",
          amount: "100.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    const first = await pay({
      date: "2026-09-10",
      currency: "EUR",
      amountMicros: 40_000_000n,
      allocations: [{ invoiceId: result.invoiceId, amountMicros: 40_000_000n }],
    });
    expect((await invoice(result.invoiceId)).status).toBe("partially_paid");
    const firstLines = await lines(first.entryId);
    // 40 of 110.00 open base is 44.00; the bank pays 48.00: a 4.00 loss.
    expect(firstLines.find((l) => l.accountId === accounts.payables)).toMatchObject(
      { side: "debit", baseAmountMicros: 44_000_000n },
    );
    expect(firstLines.find((l) => l.accountId === accounts.bank)).toMatchObject({
      side: "credit",
      baseAmountMicros: 48_000_000n,
    });
    expect(
      firstLines.find((l) => l.accountId === accounts.fx_gain_loss),
    ).toMatchObject({ side: "debit", baseAmountMicros: 4_000_000n });

    const second = await pay({
      date: "2026-09-20",
      currency: "EUR",
      amountMicros: 60_000_000n,
      allocations: [{ invoiceId: result.invoiceId, amountMicros: 60_000_000n }],
    });
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    const secondLines = await lines(second.entryId);
    // The remaining 66.00 base is settled; the bank pays 63.00: a 3.00 gain.
    expect(
      secondLines.find((l) => l.accountId === accounts.fx_gain_loss),
    ).toMatchObject({ side: "credit", baseAmountMicros: 3_000_000n });
    expect(
      await netBase(accounts.payables, [
        result.entryId,
        first.entryId,
        second.entryId,
      ]),
    ).toBe(0n);
    const [recorded] = await audits("finance.payment.recorded", first.paymentId);
    expect(recorded!.metadata).toEqual({
      paymentId: first.paymentId,
      entryId: first.entryId,
      direction: "outgoing",
      allocations: 1,
    });
    // Nothing is open any more.
    expect(
      await failure(
        pay({
          date: "2026-09-20",
          currency: "EUR",
          amountMicros: 1_000_000n,
          allocations: [{ invoiceId: result.invoiceId, amountMicros: 1_000_000n }],
        }),
      ),
    ).toBe("PAYMENT_OVER_ALLOCATED");
  });

  it("three partial payments at different rates close the open base exactly", async () => {
    await rate("2026-08-03", "1.1111");
    await rate("2026-08-10", "1.2");
    await rate("2026-08-17", "1.3");
    await rate("2026-08-24", "0.9");
    const result = await book({
      issueDate: "2026-08-03",
      currency: "EUR",
      lines: [
        {
          description: "Licence",
          amount: "100.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    const entries = [result.entryId];
    const parts: [string, bigint][] = [
      ["2026-08-10", 33_330_000n],
      ["2026-08-17", 33_330_000n],
      ["2026-08-24", 33_340_000n],
    ];
    for (const [date, amountMicros] of parts) {
      const paid = await pay({
        date,
        currency: "EUR",
        amountMicros,
        allocations: [{ invoiceId: result.invoiceId, amountMicros }],
      });
      entries.push(paid.entryId);
    }
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    const allocations = await run((tx) =>
      tx.financePaymentAllocation.findMany({
        where: { invoiceId: result.invoiceId },
      }),
    );
    expect(allocations.reduce((s, a) => s + a.baseMicros, 0n)).toBe(111_110_000n);
    expect(await netBase(accounts.payables, entries)).toBe(0n);
  });

  it("refunds settle credit notes in the opposite direction", async () => {
    // A refund received for a payable credit note settles payables.
    const vendorCredit = await book({
      kind: "credit_note",
      lines: [
        {
          description: "Refund",
          amount: "20.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    expect(
      await failure(
        pay({
          direction: "outgoing",
          date: "2026-10-04",
          amountMicros: 20_000_000n,
          allocations: [
            { invoiceId: vendorCredit.invoiceId, amountMicros: 20_000_000n },
          ],
        }),
      ),
    ).toBe("FINANCE_PAYMENT_DIRECTION_INVALID");
    const received = await pay({
      direction: "incoming",
      date: "2026-10-04",
      amountMicros: 20_000_000n,
      allocations: [
        { invoiceId: vendorCredit.invoiceId, amountMicros: 20_000_000n },
      ],
    });
    expect((await invoice(vendorCredit.invoiceId)).status).toBe("paid");
    const receivedLines = await lines(received.entryId);
    expect(
      receivedLines.map((l) => [l.accountId, l.side]).sort(),
    ).toEqual(
      [
        [accounts.bank, "debit"],
        [accounts.payables, "credit"],
      ].sort(),
    );
    expect(
      await netBase(accounts.payables, [vendorCredit.entryId, received.entryId]),
    ).toBe(0n);

    // A refund paid for a receivable credit note settles receivables.
    const customerCredit = await book({
      kind: "credit_note",
      direction: "receivable",
      lines: [
        {
          description: "Goodwill",
          amount: "30.00",
          tax: "0",
          categoryId: incomeCategory,
          allocation: [],
        },
      ],
    });
    const paid = await pay({
      direction: "outgoing",
      date: "2026-10-04",
      amountMicros: 30_000_000n,
      allocations: [
        { invoiceId: customerCredit.invoiceId, amountMicros: 30_000_000n },
      ],
    });
    expect(
      (await lines(paid.entryId)).map((l) => [l.accountId, l.side]).sort(),
    ).toEqual(
      [
        [accounts.receivables, "debit"],
        [accounts.bank, "credit"],
      ].sort(),
    );
    expect(
      await netBase(accounts.receivables, [customerCredit.entryId, paid.entryId]),
    ).toBe(0n);

    // A normal invoice cannot be "refunded".
    const plain = await book();
    expect(
      await failure(
        pay({
          direction: "incoming",
          date: "2026-10-04",
          amountMicros: 10_000_000n,
          allocations: [{ invoiceId: plain.invoiceId, amountMicros: 10_000_000n }],
        }),
      ),
    ).toBe("FINANCE_PAYMENT_DIRECTION_INVALID");
  });

  it("checks credit note references and payment allocations", async () => {
    const original = await book();
    expect(
      await failure(
        book({
          kind: "credit_note",
          counterpartyId: otherCounterpartyId,
          creditsInvoiceId: original.invoiceId,
        }),
      ),
    ).toBe("FINANCE_CREDIT_INVALID");
    const credit = await book({
      kind: "credit_note",
      creditsInvoiceId: original.invoiceId,
    });
    expect((await invoice(credit.invoiceId)).creditsInvoiceId).toBe(
      original.invoiceId,
    );
    expect(
      await failure(
        pay({
          date: "2026-10-04",
          amountMicros: 200_000_000n,
          allocations: [
            { invoiceId: original.invoiceId, amountMicros: 200_000_000n },
          ],
        }),
      ),
    ).toBe("PAYMENT_OVER_ALLOCATED");
    expect(
      await failure(
        pay({
          date: "2026-10-04",
          amountMicros: 50_000_000n,
          allocations: [
            { invoiceId: original.invoiceId, amountMicros: 60_000_000n },
          ],
        }),
      ),
    ).toBe("PAYMENT_OVER_ALLOCATED");
  });

  it("voids a booked receipt and books its document again", async () => {
    const result = await book({
      kind: "receipt",
      paid: { accountId: accounts.card },
    });
    // The receipt's own payment is voided only with the receipt.
    expect(
      await failure(
        run((tx) =>
          voidPayment(tx, scope(), result.paymentId!, { reason: "Wrong" }),
        ),
      ),
    ).toBe("FINANCE_RECEIPT_PAYMENT");
    const before = await invoice(result.invoiceId);
    const { reversalId } = await run((tx) =>
      voidInvoice(tx, scope(), result.invoiceId, {
        version: before.version,
        reason: "Wrong amount",
      }),
    );
    expect((await invoice(result.invoiceId)).status).toBe("void");
    const payment = await run((tx) =>
      tx.financePayment.findUniqueOrThrow({ where: { id: result.paymentId! } }),
    );
    expect(payment.voidedAt).not.toBeNull();
    expect(
      await run((tx) =>
        tx.financeJournalEntry.count({ where: { reversalOfId: result.entryId } }),
      ),
    ).toBe(1);
    expect(await netBase(accounts.card, [result.entryId, reversalId])).toBe(0n);
    const reopened = await doc(result.documentId);
    expect(reopened.status).toBe("needs_review");
    expect(
      await audits("finance.document.reopened", result.documentId),
    ).toHaveLength(1);
    const again = await run((tx) =>
      bookDocument(tx, scope(), result.documentId, {
        version: reopened.version,
        booking: booking({
          kind: "receipt",
          paid: { accountId: accounts.card },
          lines: [
            {
              description: "Service",
              amount: "90.00",
              tax: "0",
              categoryId: expenseCategory,
              allocation: [],
            },
          ],
        }),
      }),
    );
    expect(again.invoiceId).not.toBe(result.invoiceId);
    expect(await invoice(again.invoiceId)).toMatchObject({
      status: "paid",
      totalMicros: 90_000_000n,
      documentId: result.documentId,
    });
    expect((await doc(result.documentId)).status).toBe("booked");
  });

  it("voids a payment and then the invoice", async () => {
    const result = await book();
    const paid = await pay({
      date: "2026-10-05",
      amountMicros: 119_000_000n,
      allocations: [{ invoiceId: result.invoiceId, amountMicros: 119_000_000n }],
    });
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    const { reversalId } = await run((tx) =>
      voidPayment(tx, scope(), paid.paymentId, { reason: "Bounced" }),
    );
    expect((await invoice(result.invoiceId)).status).toBe("open");
    expect(await netBase(accounts.bank, [paid.entryId, reversalId])).toBe(0n);
    const [audit] = await audits("finance.payment.voided", paid.paymentId);
    expect(audit!.metadata).toEqual({
      paymentId: paid.paymentId,
      reversalId,
      allocations: 1,
    });
    expect(
      await failure(
        run((tx) =>
          voidPayment(tx, scope(), paid.paymentId, { reason: "Again" }),
        ),
      ),
    ).toBe("FINANCE_PAYMENT_VOID");
    const row = await invoice(result.invoiceId);
    await run((tx) =>
      voidInvoice(tx, scope(), result.invoiceId, {
        version: row.version,
        reason: "Cancelled",
      }),
    );
    expect((await invoice(result.invoiceId)).status).toBe("void");
  });

  it("recomputes the status after a voided partial payment", async () => {
    const result = await book({
      issueDate: "2026-09-01",
      currency: "EUR",
      lines: [
        {
          description: "Hosting",
          amount: "100.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    const part = (date: string, amountMicros: bigint) =>
      pay({
        date,
        currency: "EUR",
        amountMicros,
        allocations: [{ invoiceId: result.invoiceId, amountMicros }],
      });
    const first = await part("2026-09-10", 40_000_000n);
    const second = await part("2026-09-20", 30_000_000n);
    const entries = [result.entryId, first.entryId, second.entryId];
    const cancel = async (paymentId: string) =>
      entries.push(
        (
          await run((tx) =>
            voidPayment(tx, scope(), paymentId, { reason: "Returned" }),
          )
        ).reversalId,
      );
    await cancel(second.paymentId);
    expect((await invoice(result.invoiceId)).status).toBe("partially_paid");
    await cancel(first.paymentId);
    expect((await invoice(result.invoiceId)).status).toBe("open");
    // The whole amount is open again and settles the whole base.
    const full = await part("2026-09-20", 100_000_000n);
    entries.push(full.entryId);
    expect((await invoice(result.invoiceId)).status).toBe("paid");
    expect(await netBase(accounts.payables, entries)).toBe(0n);
  });

  it("a fully credited invoice is paid with its base closed", async () => {
    // Same rate: the credit note's base matches, no closing entry.
    const plain = await book();
    const credit = await book({
      kind: "credit_note",
      creditsInvoiceId: plain.invoiceId,
    });
    expect((await invoice(plain.invoiceId)).status).toBe("paid");
    expect((await invoice(credit.invoiceId)).status).toBe("paid");
    expect(await netBase(accounts.payables, [plain.entryId, credit.entryId])).toBe(
      0n,
    );
    const closes = (invoiceId: string) =>
      run((tx) =>
        tx.financeJournalEntry.findMany({
          where: { sourceType: "invoice_close", sourceId: invoiceId },
        }),
      );
    expect(await closes(plain.invoiceId)).toHaveLength(0);
    expect(
      await failure(
        book({ kind: "credit_note", creditsInvoiceId: plain.invoiceId }),
      ),
    ).toBe("CREDIT_EXCEEDS_OPEN");

    // Different rates: 110.00 posted, 120.00 credited; a 10.00 closing entry.
    const foreign = {
      currency: "EUR",
      lines: [
        {
          description: "Hosting",
          amount: "100.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    };
    const eur = await book({ ...foreign, issueDate: "2026-09-01" });
    const eurCredit = await book({
      ...foreign,
      kind: "credit_note",
      issueDate: "2026-09-10",
      creditsInvoiceId: eur.invoiceId,
    });
    expect((await invoice(eur.invoiceId)).status).toBe("paid");
    const [close] = await closes(eur.invoiceId);
    expect(close).toBeDefined();
    const closeLines = await lines(close!.id);
    expect(
      closeLines.find((l) => l.accountId === accounts.fx_gain_loss),
    ).toMatchObject({ side: "debit", baseAmountMicros: 10_000_000n, currency: "USD" });
    expect(
      await netBase(accounts.payables, [eur.entryId, eurCredit.entryId, close!.id]),
    ).toBe(0n);

    // Voiding the credit note reopens the invoice and reverses the closing.
    const creditRow = await invoice(eurCredit.invoiceId);
    const voided = await run((tx) =>
      voidInvoice(tx, scope(), eurCredit.invoiceId, {
        version: creditRow.version,
        reason: "Issued in error",
      }),
    );
    expect((await invoice(eur.invoiceId)).status).toBe("open");
    const reversed = await run((tx) =>
      tx.financeJournalEntry.findUniqueOrThrow({ where: { id: close!.id } }),
    );
    expect(reversed.reversedById).not.toBeNull();
    expect(
      await netBase(accounts.payables, [
        eur.entryId,
        eurCredit.entryId,
        voided.reversalId,
        close!.id,
        reversed.reversedById!,
      ]),
    ).toBe(110_000_000n * -1n);
  });

  it("a partial credit leaves the rest payable", async () => {
    const eur = await book({
      issueDate: "2026-09-01",
      currency: "EUR",
      lines: [
        {
          description: "Hosting",
          amount: "100.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    const credit = await book({
      kind: "credit_note",
      issueDate: "2026-09-10",
      currency: "EUR",
      creditsInvoiceId: eur.invoiceId,
      lines: [
        {
          description: "Discount",
          amount: "30.00",
          tax: "0",
          categoryId: expenseCategory,
          allocation: [],
        },
      ],
    });
    expect((await invoice(eur.invoiceId)).status).toBe("partially_paid");
    expect(
      await failure(
        pay({
          date: "2026-09-20",
          currency: "EUR",
          amountMicros: 80_000_000n,
          allocations: [{ invoiceId: eur.invoiceId, amountMicros: 80_000_000n }],
        }),
      ),
    ).toBe("PAYMENT_OVER_ALLOCATED");
    const paid = await pay({
      date: "2026-09-20",
      currency: "EUR",
      amountMicros: 70_000_000n,
      allocations: [{ invoiceId: eur.invoiceId, amountMicros: 70_000_000n }],
    });
    expect((await invoice(eur.invoiceId)).status).toBe("paid");
    // 110.00 posted - 36.00 credited = 74.00 settled; the bank pays 73.50.
    const paidLines = await lines(paid.entryId);
    expect(paidLines.find((l) => l.accountId === accounts.payables)).toMatchObject(
      { baseAmountMicros: 74_000_000n },
    );
    expect(
      await netBase(accounts.payables, [eur.entryId, credit.entryId, paid.entryId]),
    ).toBe(0n);
  });

  it("refuses a payment across counterparties", async () => {
    const a = await book();
    const b = await book({ counterpartyId: otherCounterpartyId });
    expect(
      await failure(
        pay({
          date: "2026-10-05",
          amountMicros: 238_000_000n,
          allocations: [
            { invoiceId: a.invoiceId, amountMicros: 119_000_000n },
            { invoiceId: b.invoiceId, amountMicros: 119_000_000n },
          ],
        }),
      ),
    ).toBe("PAYMENT_MIXED_COUNTERPARTIES");
  });

  it("a paid invoice uses the booking's manual rate on its issue date", async () => {
    const result = await book({
      issueDate: "2025-02-03",
      currency: "EUR",
      rateOverride: "1.25",
      paid: { accountId: accounts.bank },
    });
    const payment = await run((tx) =>
      tx.financePayment.findUniqueOrThrow({ where: { id: result.paymentId! } }),
    );
    const paymentLines = await lines(payment.entryId!);
    expect(paymentLines.every((l) => l.accountId !== accounts.fx_gain_loss)).toBe(
      true,
    );
    expect(
      paymentLines.find((l) => l.accountId === accounts.bank),
    ).toMatchObject({ baseAmountMicros: 148_750_000n });
    // A later payment date needs its own rate.
    expect(
      await failure(
        book({
          issueDate: "2025-02-03",
          currency: "EUR",
          rateOverride: "1.25",
          paid: { accountId: accounts.bank, date: "2025-02-04" },
        }),
      ),
    ).toBe("FX_RATE_MISSING");
    const later = await book({
      issueDate: "2025-02-03",
      currency: "EUR",
      rateOverride: "1.25",
      paid: { accountId: accounts.bank, date: "2025-02-04", rateOverride: "1.30" },
    });
    expect((await invoice(later.invoiceId)).status).toBe("paid");
  });

  it("overdue is derived from due date", () => {
    const due = new Date("2026-10-01T00:00:00Z");
    expect(invoiceStatusView({ status: "open", dueDate: due }, "2026-10-02")).toBe(
      "overdue",
    );
    expect(
      invoiceStatusView({ status: "partially_paid", dueDate: due }, "2026-10-02"),
    ).toBe("overdue");
    expect(invoiceStatusView({ status: "open", dueDate: due }, "2026-10-01")).toBe(
      "open",
    );
    expect(invoiceStatusView({ status: "paid", dueDate: due }, "2026-12-01")).toBe(
      "paid",
    );
    expect(invoiceStatusView({ status: "void", dueDate: due }, "2026-12-01")).toBe(
      "void",
    );
    expect(invoiceStatusView({ status: "open", dueDate: null }, "2030-01-01")).toBe(
      "open",
    );
  });

  it("void reverses the posting", async () => {
    // A dedicated expense account, archived after booking: the reversal
    // still posts to it.
    const { accountId, categoryId } = await run(async (tx) => {
      const account = await tx.financeAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          code: `69${randomUUID().slice(0, 4)}`,
          name: "Temporary expenses",
          type: "expense",
        },
      });
      const category = await tx.financeCategory.create({
        data: {
          id: randomUUID(),
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          name: "Temporary",
          kind: "expense",
          accountId: account.id,
        },
      });
      return { accountId: account.id, categoryId: category.id };
    });
    const result = await book({
      lines: [
        {
          description: "Temp",
          amount: "10.00",
          tax: "0",
          categoryId,
          allocation: [],
        },
      ],
    });
    await run((tx) => archiveAccount(tx, scope(), accountId));
    const before = await invoice(result.invoiceId);
    const voided = await run((tx) =>
      voidInvoice(tx, scope(), result.invoiceId, {
        version: before.version,
        reason: "Booked twice",
      }),
    );
    const row = await invoice(result.invoiceId);
    expect(row.status).toBe("void");
    const reversal = await run((tx) =>
      tx.financeJournalEntry.findUniqueOrThrow({
        where: { id: voided.reversalId },
      }),
    );
    expect(reversal).toMatchObject({
      kind: "reversal",
      reversalOfId: result.entryId,
    });
    expect(await netBase(accountId, [result.entryId, reversal.id])).toBe(0n);
    const [audit] = await audits("finance.invoice.voided", result.invoiceId);
    expect(audit!.metadata).toEqual({
      invoiceId: result.invoiceId,
      reversalId: reversal.id,
    });
    expect(JSON.stringify(audit!.metadata)).not.toContain("twice");
    // A booking can no longer use the archived account.
    expect(
      await failure(
        book({
          lines: [
            {
              description: "Temp",
              amount: "10.00",
              tax: "0",
              categoryId,
              allocation: [],
            },
          ],
        }),
      ),
    ).toBe("FINANCE_ACCOUNT_ARCHIVED");

    // An invoice with payments is not voided.
    const paid = await book({
      paid: { accountId: accounts.bank, date: "2026-10-03" },
    });
    const paidRow = await invoice(paid.invoiceId);
    expect(
      await failure(
        run((tx) =>
          voidInvoice(tx, scope(), paid.invoiceId, {
            version: paidRow.version,
            reason: "No",
          }),
        ),
      ),
    ).toBe("FINANCE_INVOICE_HAS_PAYMENTS");
  });

  it("withdrawal posts to owner draws", async () => {
    const withdrawal = await run((tx) =>
      postManualEntry(tx, scope(), {
        kind: "withdrawal",
        accountId: accounts.bank,
        date: "2026-10-06",
        currency: "USD",
        amount: "50.00",
        memo: "Private",
      }),
    );
    expect(
      (await lines(withdrawal.entryId))
        .map((l) => [l.accountId, l.side, l.amountMicros])
        .sort(),
    ).toEqual(
      [
        [accounts.owner_draws, "debit", 50_000_000n],
        [accounts.bank, "credit", 50_000_000n],
      ].sort(),
    );
    const [audit] = await audits("finance.entry.manual", withdrawal.entryId);
    expect(audit!.metadata).toEqual({ kind: "withdrawal" });

    const contribution = await run((tx) =>
      postManualEntry(tx, scope(), {
        kind: "contribution",
        accountId: accounts.bank,
        date: "2026-10-06",
        currency: "USD",
        amount: "500.00",
      }),
    );
    expect(
      (await lines(contribution.entryId)).find(
        (l) => l.accountId === accounts.owner_contributions,
      ),
    ).toMatchObject({ side: "credit", amountMicros: 500_000_000n });
    const transfer = await run((tx) =>
      postManualEntry(tx, scope(), {
        kind: "transfer",
        fromAccountId: accounts.bank,
        toAccountId: accounts.card,
        date: "2026-10-06",
        currency: "USD",
        amount: "25.00",
      }),
    );
    expect(
      (await lines(transfer.entryId)).map((l) => [l.accountId, l.side]).sort(),
    ).toEqual(
      [
        [accounts.card, "debit"],
        [accounts.bank, "credit"],
      ].sort(),
    );
    const adjustment = (credit: string) =>
      run((tx) =>
        postManualEntry(tx, scope(), {
          kind: "adjustment",
          date: "2026-10-06",
          currency: "USD",
          lines: [
            { accountId: accounts.expenses, side: "debit", amount: "5.00" },
            { accountId: accounts.bank, side: "credit", amount: credit },
          ],
        }),
      );
    expect(await failure(adjustment("4.00"))).toBe("FINANCE_ENTRY_UNBALANCED");
    expect((await adjustment("5.00")).entryId).toBeDefined();

    // Archived payment accounts take no new postings.
    const archived = await run(async (tx) => {
      const account = await tx.financeAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          code: `10${randomUUID().slice(0, 4)}`,
          name: "Closed bank",
          type: "asset",
          paymentAccount: true,
        },
      });
      await archiveAccount(tx, scope(), account.id);
      return account.id;
    });
    expect(
      await failure(
        run((tx) =>
          postManualEntry(tx, scope(), {
            kind: "withdrawal",
            accountId: archived,
            date: "2026-10-06",
            currency: "USD",
            amount: "1.00",
          }),
        ),
      ),
    ).toBe("FINANCE_ACCOUNT_ARCHIVED");
    expect(
      await failure(
        book({ paid: { accountId: archived, date: "2026-10-03" } }),
      ),
    ).toBe("FINANCE_ACCOUNT_ARCHIVED");
  });

  it("foreign currency on a date without rate needs a manual rate", async () => {
    const id = await upload();
    const { version } = await doc(id);
    const foreign = booking({ issueDate: "2025-01-15", currency: "EUR" });
    expect(
      await failure(
        run((tx) => bookDocument(tx, scope(), id, { version, booking: foreign })),
      ),
    ).toBe("FX_RATE_MISSING");
    expect((await doc(id)).status).toBe("needs_review");
    const result = await run((tx) =>
      bookDocument(tx, scope(), id, {
        version,
        booking: { ...foreign, rateOverride: "1.08" },
      }),
    );
    const posted = await lines(result.entryId);
    expect(posted.every((l) => l.fxRate.toFixed() === "1.08")).toBe(true);
    expect(posted.every((l) => l.rateSource === "manual")).toBe(true);
    expect(posted.find((l) => l.accountId === accounts.payables)).toMatchObject({
      amountMicros: 119_000_000n,
      baseAmountMicros: 128_520_000n,
    });
  });

  it("rejects a document with a reason kept out of the audit", async () => {
    const id = await upload();
    const rejected = await run((tx) =>
      rejectDocument(tx, scope(), id, {
        version: 1,
        reason: "Private purchase",
      }),
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      rejectionReason: "Private purchase",
    });
    const [audit] = await audits("finance.document.rejected", id);
    expect(JSON.stringify(audit!.metadata)).not.toContain("Private");
    expect(
      await failure(
        run((tx) =>
          bookDocument(tx, scope(), id, {
            version: rejected.version,
            booking: booking(),
          }),
        ),
      ),
    ).toBe("FINANCE_DOCUMENT_NOT_REVIEWABLE");
  });

  it("retries extraction under a new attempt key", async () => {
    const setAi = async (value: "on" | "off") => {
      const now = await run((tx) => readFinanceSettings(tx, scope()));
      await run((tx) =>
        writeFinanceSettings(tx, scope(), now.version, { aiExtraction: value }),
      );
    };
    const job = async (key: string) =>
      (await run((tx) => list(tx, scope(), "jobs"))).find(
        (j) => data(j).idempotencyKey === key,
      );
    // A retry is a paid call: it needs the project's AI consent.
    await setAi("on");
    try {
      const id = await upload();
      expect((await doc(id)).status).toBe("received");
      expect(await job(`finance-extract:${id}`)).toBeDefined();
      // The first job is still queued.
      expect(await failure(run((tx) => retryExtraction(tx, scope(), id)))).toBe(
        "FINANCE_EXTRACTION_RUNNING",
      );
      const first = (await job(`finance-extract:${id}`))!;
      await run((tx) =>
        update(tx, scope(), first, { ...data(first), status: "blocked_dependency" }),
      );
      await run((tx) => retryExtraction(tx, scope(), id));
      expect(await job(`finance-extract:${id}:1`)).toBeDefined();
      expect((await doc(id)).extraction).toMatchObject({ extractionAttempt: 1 });
      expect(await failure(run((tx) => retryExtraction(tx, scope(), id)))).toBe(
        "FINANCE_EXTRACTION_RUNNING",
      );
      // A failed document goes back to received.
      await run((tx) =>
        tx.financeDocument.update({ where: { id }, data: { status: "failed" } }),
      );
      const retried = await run((tx) => retryExtraction(tx, scope(), id));
      expect(retried.status).toBe("received");
      expect(await job(`finance-extract:${id}:2`)).toBeDefined();
    } finally {
      await setAi("off");
    }
    // Without consent nothing is started, not even for a waiting document.
    const waiting = await upload();
    expect(
      await failure(run((tx) => retryExtraction(tx, scope(), waiting))),
    ).toBe("FINANCE_AI_OFF");
  });

  it("requests the mail archive on booking when archiveAfter is booked", async () => {
    const settings = await run((tx) => readFinanceSettings(tx, scope()));
    await run((tx) =>
      writeFinanceSettings(tx, scope(), settings.version, {
        archiveAfter: "booked",
      }),
    );
    try {
      const { connectionId, mailboxId } = await run(async (tx) => {
        const connection = await create(tx, scope(), CONNECTION_KIND, {
          provider: "email",
          fromAddress: `${randomUUID()}@example.invalid`,
        });
        const mailbox = await bindMailbox(tx, scope(), {
          emailConnectionId: connection.id,
        });
        return { connectionId: connection.id, mailboxId: mailbox.id };
      });
      const messageId = `<${randomUUID()}@store.example>`;
      const inboundId = await run(
        async (tx) =>
          (
            await create(tx, scope(), INBOUND_KIND, {
              connectionId,
              uid: 9,
              uidValidity: "1",
              messageId,
              automatic: false,
              unreadable: false,
            })
          ).id,
      );
      const stored = await storeFile(scope(), {
        moduleId: "finance",
        bytes: pdf(),
        mime: "application/pdf",
      });
      const { id } = await recordDocument(scope(), stored, {
        source: "email",
        mime: "application/pdf",
        mailboxId,
        inboundEmailId: inboundId,
        messageId,
      });
      const archiveJobs = async () =>
        (await run((tx) => list(tx, scope(), "jobs"))).filter(
          (j) =>
            data(j).topic === "email_archive" &&
            data(j).resourceId === inboundId,
        );
      expect(await archiveJobs()).toHaveLength(0);
      const { version } = await doc(id);
      await run((tx) =>
        bookDocument(tx, scope(), id, { version, booking: booking() }),
      );
      expect(await archiveJobs()).toHaveLength(1);
    } finally {
      const now = await run((tx) => readFinanceSettings(tx, scope()));
      await run((tx) =>
        writeFinanceSettings(tx, scope(), now.version, {
          archiveAfter: "extracted",
        }),
      );
    }
  });
});

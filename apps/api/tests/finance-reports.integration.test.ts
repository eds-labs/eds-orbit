import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import {
  createCategory,
  listCategories,
} from "../src/modules/finance/categories.ts";
import { createCostCenter } from "../src/modules/finance/cost-centers.ts";
import { createCounterparty } from "../src/modules/finance/counterparties.ts";
import { ingestDocument } from "../src/modules/finance/intake/documents.ts";
import {
  createInvoice,
  type BookingRequest,
} from "../src/modules/finance/invoices.ts";
import { reverseEntry } from "../src/modules/finance/ledger/reversal.ts";
import { postManualEntry } from "../src/modules/finance/manual-entries.ts";
import { recordPayment, voidPayment } from "../src/modules/finance/payments.ts";
import { createRecurring } from "../src/modules/finance/recurring.ts";
import {
  costReport,
  financeSummary,
  yearOverview,
} from "../src/modules/finance/reports.ts";
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

/** Reports over posted lines: months, reversals, cost centers, categories. */
describe.skipIf(!enabled)("finance reports", () => {
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

  let counterpartyId = "";
  let software = "";
  let ai = "";
  let aiChild = "";
  let revenue = "";
  let centers: string[] = [];
  const accounts: Record<string, string> = {};

  const adjust = (
    date: string,
    side: "debit" | "credit",
    categoryId: string,
    accountCode: string,
    amount: string,
    costCenterId?: string,
  ) =>
    run((tx) =>
      postManualEntry(tx, scope(), {
        kind: "adjustment",
        date,
        currency: "USD",
        lines: [
          {
            accountId: accounts[accountCode]!,
            side,
            amount,
            categoryId,
            costCenterId,
          },
          {
            accountId: accounts.bank!,
            side: side === "debit" ? "credit" : "debit",
            amount,
          },
        ],
      } as Parameters<typeof postManualEntry>[2]),
    );
  const expense = (
    date: string,
    categoryId: string,
    amount: string,
    cc?: string,
  ) => adjust(date, "debit", categoryId, "6000", amount, cc);
  const income = (date: string, amount: string) =>
    adjust(date, "credit", revenue, "4000", amount);

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    project = await createPackageProject({ name: "Synthetic finance reports" });
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
      const byName = (n: string) => categories.find((c) => c.name === n)!;
      software = byName("Software & SaaS").id;
      ai = byName("AI services").id;
      revenue = byName("Revenue").id;
      const rows = await tx.financeAccount.findMany();
      for (const code of ["1000", "4000", "6000"])
        accounts[code] = rows.find((r) => r.code === code)!.id;
      accounts.bank = accounts["1000"]!;
      aiChild = (
        await createCategory(tx, scope(), {
          name: "Model tokens",
          kind: "expense",
          parentId: ai,
          accountId: byName("AI services").accountId,
        })
      ).id;
      counterpartyId = (
        await createCounterparty(tx, scope(), { name: "Acme GmbH" })
      ).id;
      centers = [
        (await createCostCenter(tx, scope(), { code: "OPS", name: "Ops" })).id,
        (
          await createCostCenter(tx, scope(), {
            code: "MKT",
            name: "Marketing",
          })
        ).id,
      ];
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

  it("monthly income, expense and result", async () => {
    await income("2025-01-10", "500.00");
    await income("2025-03-05", "200.00");
    await expense("2025-01-20", software, "120.50");
    await expense("2025-02-02", software, "30.00");
    const summary = await run((tx) =>
      financeSummary(tx, scope(), { from: "2025-01-01", to: "2025-03-31" }),
    );
    expect(summary.baseCurrency).toBe("USD");
    expect(summary.months).toEqual([
      {
        month: "2025-01",
        incomeMicros: "500000000",
        expenseMicros: "120500000",
        resultMicros: "379500000",
      },
      {
        month: "2025-02",
        incomeMicros: "0",
        expenseMicros: "30000000",
        resultMicros: "-30000000",
      },
      {
        month: "2025-03",
        incomeMicros: "200000000",
        expenseMicros: "0",
        resultMicros: "200000000",
      },
    ]);
    expect(summary.byCategory[0]).toMatchObject({
      id: software,
      name: "Software & SaaS",
    });
    expect(summary.byCategory[0]!.months.map((m) => m.expenseMicros)).toEqual([
      "120500000",
      "30000000",
      "0",
    ]);
    expect(summary.byCostCenter).toEqual([
      { id: null, name: null, expenseMicros: "150500000" },
    ]);
  });

  it("reversed entries net to zero", async () => {
    const posted = await expense("2025-04-10", software, "80.00");
    await run((tx) =>
      reverseEntry(tx, scope(), posted.entryId, "Mistake", "2025-05-02"),
    );
    const summary = await run((tx) =>
      financeSummary(tx, scope(), { from: "2025-04-01", to: "2025-05-31" }),
    );
    // The original stays in its month; the reversal lands in its own.
    expect(summary.months.map((m) => m.expenseMicros)).toEqual([
      "80000000",
      "-80000000",
    ]);
    const whole = await run((tx) =>
      costReport(tx, scope(), {
        from: "2025-04-01",
        to: "2025-05-31",
        groupBy: "month",
        kind: "expense",
      }),
    );
    expect(whole.totalMicros).toBe("0");
  });

  it("cost center split counts proportionally", async () => {
    const result = await run((tx) =>
      createInvoice(tx, scope(), {
        kind: "invoice",
        direction: "payable",
        counterpartyId,
        number: "CC-1",
        issueDate: "2025-06-10",
        dueDate: "2025-07-10",
        currency: "USD",
        lines: [
          {
            description: "Shared tool",
            amount: "100.00",
            tax: "0.00",
            categoryId: software,
            allocation: [
              { costCenterId: centers[0], bp: 6000 },
              { costCenterId: centers[1], bp: 4000 },
            ],
          },
        ],
      } as BookingRequest as never),
    );
    expect(result.entryId).toBeDefined();
    await expense("2025-06-12", software, "10.00");
    const summary = await run((tx) =>
      financeSummary(tx, scope(), { from: "2025-06-01", to: "2025-06-30" }),
    );
    expect(summary.byCostCenter).toEqual([
      { id: centers[0], name: "Ops", expenseMicros: "60000000" },
      { id: centers[1], name: "Marketing", expenseMicros: "40000000" },
      { id: null, name: null, expenseMicros: "10000000" },
    ]);
    const report = await run((tx) =>
      costReport(tx, scope(), {
        from: "2025-06-01",
        to: "2025-06-30",
        groupBy: "costCenter",
        costCenter: "ops",
        kind: "expense",
      }),
    );
    expect(report.matchedCostCenters).toEqual(["Ops"]);
    expect(report.rows).toEqual([
      { id: centers[0], name: "Ops", totalMicros: "60000000" },
    ]);
  });

  it("category filter includes children", async () => {
    await expense("2025-07-01", ai, "40.00");
    await expense("2025-07-02", aiChild, "25.00");
    await expense("2025-07-03", software, "7.00");
    const range = {
      from: "2025-07-01",
      to: "2025-07-31",
      kind: "expense" as const,
    };
    const report = await run((tx) =>
      costReport(tx, scope(), {
        ...range,
        groupBy: "category",
        category: "AI",
      }),
    );
    expect(report.matched.sort()).toEqual(["AI services", "Model tokens"]);
    expect(report.totalMicros).toBe("65000000");
    expect(report.rows).toEqual([
      { id: ai, name: "AI services", totalMicros: "65000000" },
    ]);
    const unfiltered = await run((tx) =>
      costReport(tx, scope(), { ...range, groupBy: "category" }),
    );
    expect(unfiltered.rows.map((r) => r.totalMicros)).toEqual([
      "65000000",
      "7000000",
    ]);
    const none = await run((tx) =>
      costReport(tx, scope(), {
        ...range,
        groupBy: "category",
        category: "Nope",
      }),
    );
    expect(none).toMatchObject({ matched: [], totalMicros: "0", rows: [] });
    const inMonths = await run((tx) =>
      costReport(tx, scope(), {
        ...range,
        groupBy: "month",
        category: "software",
      }),
    );
    expect(inMonths.rows).toEqual([
      { month: "2025-07", totalMicros: "7000000" },
    ]);
  });

  it("empty period returns zero months, not missing ones", async () => {
    const summary = await run((tx) =>
      financeSummary(tx, scope(), { from: "2020-01-15", to: "2020-04-02" }),
    );
    expect(summary.months).toHaveLength(4);
    expect(
      summary.months.every(
        (m) => m.incomeMicros === "0" && m.expenseMicros === "0",
      ),
    ).toBe(true);
    expect(summary.byCategory).toEqual([]);
    expect(summary.byCostCenter).toEqual([]);
  });

  const bookInvoice = (number: string, over: Record<string, unknown> = {}) =>
    run((tx) =>
      createInvoice(tx, scope(), {
        kind: "invoice",
        direction: "payable",
        counterpartyId,
        number,
        issueDate: "2025-08-01",
        dueDate: "2025-08-15",
        currency: "USD",
        lines: [
          {
            description: "x",
            amount: "100.00",
            tax: "0.00",
            categoryId: software,
            allocation: [],
          },
        ],
        ...over,
      } as BookingRequest as never),
    );
  const pay = (invoiceId: string, date: string, amountMicros: bigint) =>
    run((tx) =>
      recordPayment(tx, scope(), {
        direction: "outgoing",
        accountId: accounts.bank!,
        date,
        currency: "USD",
        amountMicros,
        allocations: [{ invoiceId, amountMicros }],
      }),
    );
  const position = async () => {
    const s = await run((tx) =>
      financeSummary(tx, scope(), { from: "2025-08-01", to: "2025-08-31" }),
    );
    return {
      open: BigInt(s.open.totalMicros),
      openCount: s.open.count,
      overdue: BigInt(s.overdue.totalMicros),
      overdueCount: s.overdue.count,
      summary: s,
    };
  };

  it("open and overdue figures in base, recurring at today's rate", async () => {
    const before = await position();
    const past = await bookInvoice("OPEN-PAST");
    await bookInvoice("OPEN-FUTURE", { dueDate: "2999-01-01" });
    await pay(past.invoiceId, "2025-08-20", 30_000_000n);
    await run(async (tx) => {
      await createRecurring(tx, scope(), {
        name: "Plan",
        interval: "yearly",
        expectedAmountMicros: "120000000",
        currency: "USD",
        nextDueDate: "2999-01-01",
      });
      await createRecurring(tx, scope(), {
        name: "Euro plan",
        interval: "monthly",
        expectedAmountMicros: "10000000",
        currency: "EUR",
        nextDueDate: "2999-01-01",
      });
    });
    const after = await position();
    expect(after.openCount - before.openCount).toBe(2);
    expect(after.open - before.open).toBe(170_000_000n);
    expect(after.overdueCount - before.overdueCount).toBe(1);
    expect(after.overdue - before.overdue).toBe(70_000_000n);
    expect(
      BigInt(after.summary.recurringMonthlyMicros) -
        BigInt(before.summary.recurringMonthlyMicros),
    ).toBe(10_000_000n);
    expect(
      after.summary.recurringMissingRate - before.summary.recurringMissingRate,
    ).toBe(1);
  });

  it("open figures honour credit notes and voided payments", async () => {
    const before = await position();
    const target = await bookInvoice("OPEN-CREDIT");
    await bookInvoice("CN-1", {
      kind: "credit_note",
      creditsInvoiceId: target.invoiceId,
      lines: [
        {
          description: "credit",
          amount: "20.00",
          tax: "0.00",
          categoryId: software,
          allocation: [],
        },
      ],
    });
    let now = await position();
    expect(now.open - before.open).toBe(80_000_000n);
    expect(now.overdue - before.overdue).toBe(80_000_000n);
    expect(now.openCount - before.openCount).toBe(1);
    const payment = await pay(target.invoiceId, "2025-08-20", 30_000_000n);
    now = await position();
    expect(now.open - before.open).toBe(50_000_000n);
    await run((tx) =>
      voidPayment(tx, scope(), payment.paymentId, { reason: "Bounced" }),
    );
    now = await position();
    expect(now.open - before.open).toBe(80_000_000n);
    expect(now.overdue - before.overdue).toBe(80_000_000n);
  });

  it("year overview open items are as of 31 December", async () => {
    const partial = await bookInvoice("ASOF-PARTIAL", {
      issueDate: "2030-11-01",
      dueDate: "2030-12-01",
    });
    await pay(partial.invoiceId, "2030-12-01", 30_000_000n);
    const paidLater = await bookInvoice("ASOF-LATE", {
      issueDate: "2030-11-02",
      dueDate: "2030-12-02",
    });
    await pay(paidLater.invoiceId, "2031-01-15", 100_000_000n);
    await bookInvoice("ASOF-NEXT", {
      issueDate: "2031-02-01",
      dueDate: "2031-03-01",
    });
    const open = (await run((tx) => yearOverview(tx, scope(), 2030))).open;
    expect(open.map((o) => [o.number, o.openMicros, o.openBaseMicros])).toEqual(
      expect.arrayContaining([
        ["ASOF-PARTIAL", "70000000", "70000000"],
        ["ASOF-LATE", "100000000", "100000000"],
      ]),
    );
    expect(open.some((o) => o.number === "ASOF-NEXT")).toBe(false);
    const next = (await run((tx) => yearOverview(tx, scope(), 2031))).open;
    expect(next.some((o) => o.number === "ASOF-LATE")).toBe(false);
    expect(next.some((o) => o.number === "ASOF-NEXT")).toBe(true);
  });

  it("year overview lists categories, cost centers and booked documents", async () => {
    const id = (
      await ingestDocument(scope(), {
        source: "upload",
        bytes: Buffer.concat([
          readFileSync(
            new URL("./fixtures/finance/invoice.pdf", import.meta.url),
          ),
          Buffer.from(`%${randomUUID()}\n`),
        ]),
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
          number: "YEAR-1",
          issueDate: "2026-02-03",
          dueDate: "2026-03-03",
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
    const overview = await run((tx) => yearOverview(tx, scope(), 2026));
    expect(overview.months).toHaveLength(12);
    const row = overview.categories.find(
      (c) => c.id === software && c.kind === "expense",
    )!;
    expect(row.months[1]).toEqual({
      month: "2026-02",
      amountMicros: "50000000",
    });
    expect(row.totalMicros).toBe("50000000");
    expect(overview.documents).toEqual([
      expect.objectContaining({
        id,
        number: "YEAR-1",
        issueDate: "2026-02-03",
        counterparty: "Acme GmbH",
        currency: "USD",
        totalMicros: "50000000",
        totalBaseMicros: "50000000",
        entryNumber: expect.any(String),
      }),
    ]);
    expect(overview.open.some((o) => o.number === "YEAR-1")).toBe(true);
    const empty = await run((tx) => yearOverview(tx, scope(), 2019));
    expect(empty.documents).toEqual([]);
  });
});

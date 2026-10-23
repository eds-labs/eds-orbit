import { describe, expect, it } from "vitest";
import type { SystemAccounts } from "../src/modules/finance/ledger/accounts.ts";
import { assertBalanced } from "../src/modules/finance/ledger/invariants.ts";
import {
  postingLines,
  type DraftLine,
  type PostingInput,
  type Rate,
} from "../src/modules/finance/ledger/posting.ts";

const roles: SystemAccounts = {
  payables: "acc-payables",
  receivables: "acc-receivables",
  owner_contributions: "acc-contributions",
  owner_draws: "acc-draws",
  fx_gain_loss: "acc-fx",
  rounding: "acc-rounding",
};
const BANK = "acc-bank";
const WALLET = "acc-wallet";
const SOFTWARE = "acc-software";
const SALES = "acc-sales";

const identity: Rate = { rate: "1", rateDate: "2026-10-23", source: "identity" };
const eurAt = (rate: string, rateDate = "2026-10-23"): Rate => ({
  rate,
  rateDate,
  source: "ecb",
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return null;
};

/** Account, side, original and base amount (and cost center) per line. */
const shape = (lines: DraftLine[]) =>
  lines.map((l) => [
    l.accountId,
    l.side,
    l.amountMicros,
    l.baseAmountMicros,
    l.costCenterId ?? null,
  ]);
const sum = (lines: DraftLine[], side: "debit" | "credit") =>
  lines
    .filter((l) => l.side === side)
    .reduce((acc, l) => acc + l.baseAmountMicros, 0n);

const payableInvoice: PostingInput = {
  kind: "invoice",
  direction: "payable",
  currency: "USD",
  baseCurrency: "USD",
  lines: [
    {
      amountMicros: 100_000_000n,
      taxMicros: 19_000_000n,
      categoryAccountId: SOFTWARE,
      categoryId: "cat-software",
      allocation: [
        { costCenterId: "cc-a", bp: 6000 },
        { costCenterId: "cc-b", bp: 4000 },
      ],
    },
  ],
};

// One case per row of the posting table in spec §7.
const cases: {
  name: string;
  input: PostingInput;
  rate: Rate;
  expected: unknown[][];
}[] = [
  {
    name: "payable invoice split 60/40 over two cost centers",
    input: payableInvoice,
    rate: identity,
    expected: [
      [SOFTWARE, "debit", 71_400_000n, 71_400_000n, "cc-a"],
      [SOFTWARE, "debit", 47_600_000n, 47_600_000n, "cc-b"],
      [roles.payables, "credit", 119_000_000n, 119_000_000n, null],
    ],
  },
  {
    name: "receivable invoice credits income per line",
    input: {
      kind: "invoice",
      direction: "receivable",
      currency: "EUR",
      baseCurrency: "USD",
      lines: [
        {
          amountMicros: 200_000_000n,
          taxMicros: 0n,
          categoryAccountId: SALES,
          categoryId: "cat-sales",
          allocation: [],
        },
        {
          amountMicros: 50_000_000n,
          taxMicros: 0n,
          categoryAccountId: SALES,
          categoryId: "cat-sales",
          allocation: [],
        },
      ],
    },
    rate: eurAt("1.1"),
    expected: [
      [roles.receivables, "debit", 250_000_000n, 275_000_000n, null],
      [SALES, "credit", 200_000_000n, 220_000_000n, null],
      [SALES, "credit", 50_000_000n, 55_000_000n, null],
    ],
  },
  {
    name: "credit note inverts its invoice",
    input: { ...payableInvoice, kind: "credit_note" },
    rate: identity,
    expected: [
      [SOFTWARE, "credit", 71_400_000n, 71_400_000n, "cc-a"],
      [SOFTWARE, "credit", 47_600_000n, 47_600_000n, "cc-b"],
      [roles.payables, "debit", 119_000_000n, 119_000_000n, null],
    ],
  },
  {
    name: "USDC receipt uses the peg",
    input: {
      kind: "receipt",
      direction: "payable",
      currency: "USDC",
      baseCurrency: "USD",
      paymentAccountId: WALLET,
      lines: [
        {
          amountMicros: 12_345_678n,
          taxMicros: 0n,
          categoryAccountId: SOFTWARE,
          categoryId: "cat-software",
          allocation: [],
        },
      ],
    },
    rate: { rate: "1.000000", rateDate: "2026-10-23", source: "peg" },
    expected: [
      [SOFTWARE, "debit", 12_345_678n, 12_350_000n, null],
      [WALLET, "credit", 12_345_678n, 12_350_000n, null],
    ],
  },
  {
    name: "outgoing payment debits payables and credits the payment account",
    input: {
      kind: "payment",
      direction: "outgoing",
      currency: "USD",
      baseCurrency: "USD",
      paymentAccountId: BANK,
      allocations: [
        {
          amountMicros: 119_000_000n,
          invoiceTotalMicros: 119_000_000n,
          invoiceBaseMicros: 119_000_000n,
          invoiceRate: identity,
        },
      ],
    },
    rate: identity,
    expected: [
      [roles.payables, "debit", 119_000_000n, 119_000_000n, null],
      [BANK, "credit", 119_000_000n, 119_000_000n, null],
    ],
  },
  {
    name: "incoming payment debits the payment account and credits receivables",
    input: {
      kind: "payment",
      direction: "incoming",
      currency: "USD",
      baseCurrency: "USD",
      paymentAccountId: BANK,
      allocations: [
        {
          amountMicros: 30_000_000n,
          invoiceTotalMicros: 30_000_000n,
          invoiceBaseMicros: 30_000_000n,
          invoiceRate: identity,
        },
      ],
    },
    rate: identity,
    expected: [
      [BANK, "debit", 30_000_000n, 30_000_000n, null],
      [roles.receivables, "credit", 30_000_000n, 30_000_000n, null],
    ],
  },
  {
    name: "contribution uses the owner contributions account",
    input: {
      kind: "contribution",
      currency: "USD",
      baseCurrency: "USD",
      paymentAccountId: BANK,
      amountMicros: 5_000_000_000n,
    },
    rate: identity,
    expected: [
      [BANK, "debit", 5_000_000_000n, 5_000_000_000n, null],
      [roles.owner_contributions, "credit", 5_000_000_000n, 5_000_000_000n, null],
    ],
  },
  {
    name: "withdrawal uses the owner draws account",
    input: {
      kind: "withdrawal",
      currency: "USD",
      baseCurrency: "USD",
      paymentAccountId: BANK,
      amountMicros: 800_000_000n,
    },
    rate: identity,
    expected: [
      [roles.owner_draws, "debit", 800_000_000n, 800_000_000n, null],
      [BANK, "credit", 800_000_000n, 800_000_000n, null],
    ],
  },
  {
    name: "transfer debits the target and credits the source account",
    input: {
      kind: "transfer",
      currency: "USDC",
      baseCurrency: "USD",
      fromAccountId: BANK,
      toAccountId: WALLET,
      amountMicros: 1_000_000_000n,
    },
    rate: { rate: "1.000000", rateDate: "2026-10-23", source: "peg" },
    expected: [
      [WALLET, "debit", 1_000_000_000n, 1_000_000_000n, null],
      [BANK, "credit", 1_000_000_000n, 1_000_000_000n, null],
    ],
  },
];

describe("postingLines", () => {
  it.each(cases)("$name", ({ input, rate, expected }) => {
    const lines = postingLines(input, roles, rate, 2);
    expect(shape(lines)).toEqual(expected);
    expect(sum(lines, "debit")).toBe(sum(lines, "credit"));
    expect(() => assertBalanced(lines)).not.toThrow();
    for (const line of lines) {
      expect(line.currency === input.currency || line.currency === "USD").toBe(true);
      expect(line.fxRate).toBe(rate.rate);
      expect(line.rateSource).toBe(rate.source);
    }
  });

  it("records category ids on expense and income lines only", () => {
    const lines = postingLines(payableInvoice, roles, identity, 2);
    expect(lines.map((l) => l.categoryId ?? null)).toEqual([
      "cat-software",
      "cat-software",
      null,
    ]);
  });

  it("EUR invoice paid later at a different rate posts fx_gain_loss", () => {
    const invoice = postingLines(
      {
        kind: "invoice",
        direction: "payable",
        currency: "EUR",
        baseCurrency: "USD",
        lines: [
          {
            amountMicros: 100_000_000n,
            taxMicros: 0n,
            categoryAccountId: SOFTWARE,
            categoryId: "cat-software",
            allocation: [],
          },
        ],
      },
      roles,
      eurAt("1.10", "2026-10-01"),
      2,
    );
    const invoiceBase = invoice.find((l) => l.accountId === roles.payables)!
      .baseAmountMicros;
    expect(invoiceBase).toBe(110_000_000n);

    const payment = (amountMicros: bigint, rate: string) =>
      postingLines(
        {
          kind: "payment",
          direction: "outgoing",
          currency: "EUR",
          baseCurrency: "USD",
          paymentAccountId: BANK,
          allocations: [
            {
              amountMicros,
              invoiceTotalMicros: 100_000_000n,
              invoiceBaseMicros: invoiceBase,
              invoiceRate: eurAt("1.10", "2026-10-01"),
            },
          ],
        },
        roles,
        eurAt(rate, "2026-10-20"),
        2,
      );

    // Full payment at a higher rate: a loss, debited.
    const loss = payment(100_000_000n, "1.12");
    expect(shape(loss)).toEqual([
      [roles.payables, "debit", 100_000_000n, 110_000_000n, null],
      [BANK, "credit", 100_000_000n, 112_000_000n, null],
      [roles.fx_gain_loss, "debit", 2_000_000n, 2_000_000n, null],
    ]);
    // The payables line keeps the invoice's rate; the fx line is in base.
    expect(loss[0]!.fxRate).toBe("1.10");
    expect(loss[2]!).toMatchObject({ currency: "USD", rateSource: "identity", fxRate: "1" });
    assertBalanced(loss);

    // Partial payment: the invoice base is pro-rated by allocated / total.
    const partial = payment(40_000_000n, "1.12");
    expect(shape(partial)).toEqual([
      [roles.payables, "debit", 40_000_000n, 44_000_000n, null],
      [BANK, "credit", 40_000_000n, 44_800_000n, null],
      [roles.fx_gain_loss, "debit", 800_000n, 800_000n, null],
    ]);

    // A lower rate is a gain, credited.
    const gain = payment(100_000_000n, "1.05");
    expect(shape(gain)).toEqual([
      [roles.payables, "debit", 100_000_000n, 110_000_000n, null],
      [BANK, "credit", 100_000_000n, 105_000_000n, null],
      [roles.fx_gain_loss, "credit", 5_000_000n, 5_000_000n, null],
    ]);

    // The same rate adds no fx line.
    expect(payment(100_000_000n, "1.10")).toHaveLength(2);
  });

  const eurInvoice = (amountMicros: bigint, allocation: { costCenterId: string; bp: number }[]): PostingInput => ({
    kind: "invoice",
    direction: "payable",
    currency: "EUR",
    baseCurrency: "USD",
    lines: [
      {
        amountMicros,
        taxMicros: 0n,
        categoryAccountId: SOFTWARE,
        categoryId: "cat-software",
        allocation,
      },
    ],
  });

  it("puts a base rounding residue on the largest expense line", () => {
    // 1.01 EUR split 50/50 → 0.51 + 0.50; at 1.5 → 0.765 → 0.76 and 0.75
    // (half-even), but the payables total 1.515 → 1.52: the 0.01 residue
    // goes onto the largest expense line.
    const lines = postingLines(
      eurInvoice(1_010_000n, [
        { costCenterId: "cc-a", bp: 5000 },
        { costCenterId: "cc-b", bp: 5000 },
      ]),
      roles,
      eurAt("1.5"),
      2,
    );
    expect(shape(lines)).toEqual([
      [SOFTWARE, "debit", 510_000n, 770_000n, "cc-a"],
      [SOFTWARE, "debit", 500_000n, 750_000n, "cc-b"],
      [roles.payables, "credit", 1_010_000n, 1_520_000n, null],
    ]);
    assertBalanced(lines);
  });

  it("uses the rounding account when the largest line cannot absorb the residue", () => {
    // 0.03 EUR in three parts of 0.01; at 1.5 each 0.015 → 0.02 (0.06), the
    // payables total 0.045 → 0.04. Taking 0.02 off a 0.02 line would leave a
    // zero line, so a rounding line balances the entry.
    const lines = postingLines(
      eurInvoice(30_000n, [
        { costCenterId: "cc-a", bp: 3334 },
        { costCenterId: "cc-b", bp: 3333 },
        { costCenterId: "cc-c", bp: 3333 },
      ]),
      roles,
      eurAt("1.5"),
      2,
    );
    expect(shape(lines)).toEqual([
      [SOFTWARE, "debit", 10_000n, 20_000n, "cc-a"],
      [SOFTWARE, "debit", 10_000n, 20_000n, "cc-b"],
      [SOFTWARE, "debit", 10_000n, 20_000n, "cc-c"],
      [roles.payables, "credit", 30_000n, 40_000n, null],
      [roles.rounding, "credit", 20_000n, 20_000n, null],
    ]);
    expect(lines[4]!).toMatchObject({ currency: "USD", fxRate: "1", rateSource: "identity" });
    assertBalanced(lines);
  });

  it("rejects non-positive amounts and an invalid allocation", () => {
    expect(
      code(() =>
        postingLines(
          {
            kind: "contribution",
            currency: "USD",
            baseCurrency: "USD",
            paymentAccountId: BANK,
            amountMicros: -1_000_000n,
          },
          roles,
          identity,
          2,
        ),
      ),
    ).toBe("FINANCE_AMOUNT_INVALID");
    expect(
      code(() =>
        postingLines(
          {
            ...payableInvoice,
            lines: [
              { ...payableInvoice.lines[0]!, allocation: [{ costCenterId: "cc-a", bp: 5000 }] },
            ],
          } as PostingInput,
          roles,
          identity,
          2,
        ),
      ),
    ).toBe("ALLOCATION_INVALID");
  });

  it("requires the identity rate for the base currency", () => {
    expect(
      code(() => postingLines(payableInvoice, roles, eurAt("1.1"), 2)),
    ).toBe("FINANCE_RATE_INVALID");
  });
});

describe("assertBalanced", () => {
  const line = (side: "debit" | "credit", base: bigint): DraftLine => ({
    accountId: BANK,
    side,
    currency: "USD",
    amountMicros: base,
    fxRate: "1",
    rateDate: "2026-10-23",
    rateSource: "identity",
    baseAmountMicros: base,
  });

  it("accepts balanced lines", () => {
    expect(() =>
      assertBalanced([line("debit", 5n), line("debit", 5n), line("credit", 10n)]),
    ).not.toThrow();
  });

  it("rejects unbalanced, single-line and non-positive lines", () => {
    expect(code(() => assertBalanced([line("debit", 5n), line("credit", 6n)]))).toBe(
      "FINANCE_ENTRY_UNBALANCED",
    );
    expect(code(() => assertBalanced([line("debit", 5n)]))).toBe(
      "FINANCE_ENTRY_UNBALANCED",
    );
    expect(code(() => assertBalanced([line("debit", 0n), line("credit", 0n)]))).toBe(
      "FINANCE_ENTRY_UNBALANCED",
    );
  });
});

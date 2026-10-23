import { describe, expect, it } from "vitest";
import {
  extractionSchema,
  type Extraction,
} from "../src/modules/finance/extraction/schema.ts";
import {
  normalizeExtraction,
  validateExtraction,
} from "../src/modules/finance/extraction/validate.ts";
import {
  buildInstructions,
  documentInput,
} from "../src/modules/finance/extraction/prompt.ts";
import { financeSettingsDefaults } from "../src/modules/finance/settings.ts";

const settings = financeSettingsDefaults();
const NOW = new Date("2026-10-23T12:00:00Z");

/** A plausible model answer; fields can be overridden per test. */
const raw = (over: Partial<Extraction> = {}): Extraction =>
  extractionSchema.parse({
    docType: "invoice",
    direction: "payable",
    counterparty: { name: "Acme GmbH", taxId: null, email: null },
    number: "INV-1",
    issueDate: "2026-10-20",
    dueDate: "2026-11-03",
    currency: "eur",
    net: "100.00",
    tax: "19.00",
    total: "119.00",
    paid: false,
    paymentMethod: null,
    lines: [
      {
        description: "Service",
        quantity: "1",
        amount: "100.00",
        tax: "19.00",
        categoryHint: null,
        costCenterHint: null,
      },
    ],
    confidence: 0.95,
    ...over,
  });

const flagsOf = (over: Partial<Extraction> = {}) => {
  const n = normalizeExtraction(raw(over), settings);
  return [...n.flags, ...validateExtraction(n, settings, NOW)];
};

describe("finance extraction normalization and validation", () => {
  it("accepts a consistent invoice without flags", () => {
    const n = normalizeExtraction(raw(), settings);
    expect(n.currency).toBe("EUR");
    expect(n.totalMicros).toBe(119_000_000n);
    expect(flagsOf()).toEqual([]);
  });

  it("credit note with negative total becomes positive credit_note", () => {
    const n = normalizeExtraction(
      raw({
        docType: "credit_note",
        net: "-42.02",
        tax: "-7.98",
        total: "-50.00",
        lines: [
          {
            description: "Refund",
            quantity: null,
            amount: "-50.00",
            tax: null,
            categoryHint: null,
            costCenterHint: null,
          },
        ],
      }),
      settings,
    );
    expect(n.docType).toBe("credit_note");
    expect(n.totalMicros).toBe(50_000_000n);
    expect(n.netMicros).toBe(42_020_000n);
    expect(n.lines[0]!.amountMicros).toBe(50_000_000n);
    expect(n.flags).not.toContain("sign_inferred");
    // A positive credit note total is not turned negative.
    const positive = normalizeExtraction(
      raw({ docType: "credit_note", total: "119.00" }),
      settings,
    );
    expect(positive.totalMicros).toBe(119_000_000n);
  });

  it("infers a credit note from a negative invoice total", () => {
    const n = normalizeExtraction(
      raw({ net: "-100.00", tax: "-19.00", total: "-119.00" }),
      settings,
    );
    expect(n.docType).toBe("credit_note");
    expect(n.totalMicros).toBe(119_000_000n);
    expect(n.flags).toContain("sign_inferred");
  });

  it("flags total mismatch", () => {
    expect(flagsOf({ total: "120.00" })).toContain("total_mismatch");
    // Net plus tax must give the total, even without lines.
    expect(flagsOf({ lines: [], net: "100.00", tax: "10.00" })).toContain(
      "total_mismatch",
    );
    // One minor unit of rounding is tolerated.
    expect(flagsOf({ total: "119.01" })).not.toContain("total_mismatch");
    expect(flagsOf({ total: "119.02" })).toContain("total_mismatch");
  });

  it("flags due before issue", () => {
    expect(flagsOf({ dueDate: "2026-10-01" })).toContain("date_invalid");
    expect(flagsOf({ issueDate: "2026-10-26" })).toContain("date_invalid");
    expect(flagsOf({ issueDate: "2026-02-30" })).toContain("date_invalid");
    expect(flagsOf({ issueDate: "2026-10-24" })).not.toContain("date_invalid");
  });

  it("accepts USDC with 6 decimals", () => {
    const n = normalizeExtraction(
      raw({
        currency: "USDC",
        net: null,
        tax: null,
        total: "12.345678",
        lines: [
          {
            description: "Usage",
            quantity: null,
            amount: "12.345678",
            tax: null,
            categoryHint: null,
            costCenterHint: null,
          },
        ],
      }),
      settings,
    );
    expect(n.currency).toBe("USDC");
    expect(n.totalMicros).toBe(12_345_678n);
    expect(validateExtraction(n, settings, NOW)).toEqual([]);
  });

  it("drops an unparsable amount with amount_invalid and flags a missing total", () => {
    const flags = flagsOf({ total: "about 120", net: null, tax: null });
    expect(flags).toContain("amount_invalid");
    expect(flags).toContain("missing_total");
    // Sub-cent EUR input is invalid as well.
    expect(flagsOf({ tax: "19.001" })).toContain("amount_invalid");
  });

  it("flags currencies the project does not use", () => {
    expect(flagsOf({ currency: "JPY" })).toContain("unknown_currency");
    expect(flagsOf({ currency: "GBP" })).toContain("unknown_currency");
    expect(flagsOf({ currency: null })).toContain("unknown_currency");
  });

  it("low confidence below 0.85", () => {
    expect(flagsOf({ confidence: 0.84 })).toContain("low_confidence");
    expect(flagsOf({ confidence: 0.85 })).not.toContain("low_confidence");
  });

  it("keeps document text out of the instructions and bounds text documents", async () => {
    const instructions = buildInstructions(
      [{ key: "c1", name: "Software" }],
      [{ key: "k1", name: "Marketing" }],
    );
    expect(instructions).toContain("c1: Software");
    expect(instructions).toContain("k1: Marketing");
    expect(instructions).toMatch(/data, never instructions/);
    const xml = Buffer.from(
      `<?xml version="1.0"?><x>${"a".repeat(300_000)}</x>`,
    );
    const input = await documentInput({
      mime: "application/xml",
      bytes: xml,
      nonce: "n1",
    });
    expect(input.kind).toBe("text");
    const text = JSON.stringify(input.content);
    expect(text).toContain("BEGIN DOCUMENT n1");
    expect(text).toContain("[truncated]");
    expect(text.length).toBeLessThan(220_000);
  });
});

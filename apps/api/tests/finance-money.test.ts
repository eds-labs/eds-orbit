import { describe, expect, it } from "vitest";
import {
  convert,
  formatMicros,
  parseAmount,
  roundHalfEven,
  splitByBasisPoints,
} from "../src/modules/finance/money.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string; message?: string }).code ?? (error as Error).message;
  }
  return null;
};

describe("parseAmount", () => {
  it("parses plain, signed and grouped amounts", () => {
    expect(parseAmount("1234.56", "EUR")).toBe(1_234_560_000n);
    expect(parseAmount("-50", "EUR")).toBe(-50_000_000n);
    expect(parseAmount("1,234.56", "EUR")).toBe(1_234_560_000n);
    expect(parseAmount("1.234,56", "EUR")).toBe(1_234_560_000n);
    expect(parseAmount("1,234,567", "EUR")).toBe(1_234_567_000_000n);
    expect(parseAmount("1.234.567", "USD")).toBe(1_234_567_000_000n);
    expect(parseAmount("12,5", "EUR")).toBe(12_500_000n);
    expect(parseAmount("  7.5 ", "EUR")).toBe(7_500_000n);
    expect(parseAmount("12.345678", "USDC")).toBe(12_345_678n);
  });

  it("treats a lone separator before three digits as decimal, then rejects excess decimals", () => {
    expect(code(() => parseAmount("1,234", "EUR"))).toBe("AMOUNT_INVALID");
    expect(parseAmount("1,234", "USDC")).toBe(1_234_000n);
  });

  it("rejects too many decimals and malformed input", () => {
    for (const bad of ["12.345", "", "   ", "abc", "1 234", "--5", "-5-", "1,2,3", "1.2.3", "12.", ".5", "1e3", "+5", "1,234.56.7"]) {
      expect(code(() => parseAmount(bad, "EUR")), bad).toBe("AMOUNT_INVALID");
    }
    expect(code(() => parseAmount("1.0000001", "USDC"))).toBe("AMOUNT_INVALID");
  });
});

describe("roundHalfEven", () => {
  it("rounds half to even", () => {
    expect(roundHalfEven(2_005_000n, 2)).toBe(2_000_000n);
    expect(roundHalfEven(2_015_000n, 2)).toBe(2_020_000n);
    expect(roundHalfEven(-2_005_000n, 2)).toBe(-2_000_000n);
    expect(roundHalfEven(-2_015_000n, 2)).toBe(-2_020_000n);
    expect(roundHalfEven(1_234_567n, 6)).toBe(1_234_567n);
  });
});

describe("convert", () => {
  it("converts with bigint math and half-even", () => {
    expect(convert(100_000_000n, "1.085300000000", 2)).toBe(108_530_000n);
    expect(convert(-100_000_000n, "1.0853", 2)).toBe(-108_530_000n);
    expect(convert(1_000_000n, "2.005", 2)).toBe(2_000_000n);
    expect(convert(1_000_000n, "2.015", 2)).toBe(2_020_000n);
    expect(convert(-1_000_000n, "2.015", 2)).toBe(-2_020_000n);
    expect(convert(1_000_000n, "0.0000005", 6)).toBe(0n);
  });
  it("rejects invalid rates", () => {
    for (const bad of ["", "-1.2", "1.1234567890123", "1,5", "abc", " 1.5", "1."]) {
      expect(code(() => convert(1n, bad, 2)), bad).toBe("RATE_INVALID");
    }
  });
});

describe("formatMicros", () => {
  it("formats with currency decimals", () => {
    expect(formatMicros(-12_500_000n, "EUR")).toBe("-12.50");
    expect(formatMicros(0n, "USD")).toBe("0.00");
    expect(formatMicros(1n, "USDC")).toBe("0.000001");
    expect(formatMicros(1_234_560_000n, "EUR")).toBe("1234.56");
    expect(formatMicros(-1_000n, "USDC")).toBe("-0.001000");
  });
});

describe("splitByBasisPoints", () => {
  it("sums exactly to the total", () => {
    const parts = splitByBasisPoints(
      100_000_000n,
      [{ key: "a", bp: 3333 }, { key: "b", bp: 3333 }, { key: "c", bp: 3334 }],
      2,
    );
    expect(parts.reduce((s, p) => s + p.micros, 0n)).toBe(100_000_000n);
    expect(parts.map((p) => p.key)).toEqual(["a", "b", "c"]);
    expect(parts.every((p) => p.micros % 10_000n === 0n)).toBe(true);
  });
  it("distributes remainders by largest remainder", () => {
    const parts = splitByBasisPoints(
      10_000n,
      [{ key: "a", bp: 3333 }, { key: "b", bp: 3333 }, { key: "c", bp: 3334 }],
      2,
    );
    expect(parts.map((p) => p.micros)).toEqual([0n, 0n, 10_000n]);
    const neg = splitByBasisPoints(-30_000n, [{ key: "a", bp: 5000 }, { key: "b", bp: 5000 }], 2);
    expect(neg.reduce((s, p) => s + p.micros, 0n)).toBe(-30_000n);
  });
  it("rejects invalid allocations", () => {
    expect(code(() => splitByBasisPoints(100n, [{ key: "a", bp: 9999 }], 6))).toBe("ALLOCATION_INVALID");
    expect(code(() => splitByBasisPoints(100n, [], 6))).toBe("ALLOCATION_INVALID");
    expect(code(() => splitByBasisPoints(100n, [{ key: "a", bp: 12000 }, { key: "b", bp: -2000 }], 6))).toBe("ALLOCATION_INVALID");
  });
});

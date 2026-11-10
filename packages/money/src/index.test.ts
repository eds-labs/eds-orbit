import { describe, expect, it } from "vitest";
import {
  MICROS_PER_UNIT,
  MoneyError,
  convert,
  decimalToMicros,
  formatMicros,
  microsToDecimal,
  microsToMinor,
  minorToMicros,
  parseAmount,
  roundHalfEven,
  splitByBasisPoints,
} from "./index.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string; message?: string }).code ?? (error as Error).message;
  }
  return null;
};

describe("moved arithmetic (same results as Finance)", () => {
  it("parseAmount", () => {
    expect(parseAmount("1.234,56", 2)).toBe(1_234_560_000n);
    expect(parseAmount("12.345678", 6)).toBe(12_345_678n);
    expect(code(() => parseAmount("1,000", 6))).toBe("AMOUNT_INVALID");
    expect(code(() => parseAmount("1.234", 2))).toBe("AMOUNT_INVALID");
  });
  it("roundHalfEven", () => {
    expect(roundHalfEven(12_345_000n, 2)).toBe(12_340_000n);
    expect(roundHalfEven(-12_355_000n, 2)).toBe(-12_360_000n);
    expect(code(() => roundHalfEven(1n, 7))).toBe("CURRENCY_DECIMALS_INVALID");
  });
  it("convert", () => {
    expect(convert(100_000_000n, "1.1", 2)).toBe(110_000_000n);
    expect(code(() => convert(1n, "abc", 2))).toBe("RATE_INVALID");
  });
  it("formatMicros", () => {
    expect(formatMicros(-12_500_000n, 2)).toBe("-12.50");
    expect(formatMicros(1_234_000_000n, 0)).toBe("1234");
  });
  it("splitByBasisPoints", () => {
    const parts = splitByBasisPoints(
      100_000_000n,
      [
        { key: "a", bp: 3333 },
        { key: "b", bp: 3333 },
        { key: "c", bp: 3334 },
      ],
      2,
    );
    expect(parts.reduce((s, p) => s + p.micros, 0n)).toBe(100_000_000n);
    expect(code(() => splitByBasisPoints(1n, [{ key: "a", bp: 1 }], 2))).toBe("ALLOCATION_INVALID");
  });
  it("MoneyError carries its code as message", () => {
    const error = new MoneyError("X");
    expect(error.code).toBe("X");
    expect(error.message).toBe("X");
    expect(MICROS_PER_UNIT).toBe(1_000_000n);
  });
});

describe("minor units and decimal strings", () => {
  it("minorToMicros / microsToMinor", () => {
    expect(minorToMicros(1234n, 2)).toBe(12_340_000n);
    expect(minorToMicros(1234n, 0)).toBe(1_234_000_000n);
    expect(microsToMinor(12_340_000n, 2)).toBe(1234n);
    expect(code(() => microsToMinor(12_345n, 2))).toBe("AMOUNT_NOT_REPRESENTABLE");
  });
  it("decimalToMicros", () => {
    expect(decimalToMicros("12.34")).toBe(12_340_000n);
    expect(decimalToMicros("0.000001")).toBe(1n);
    for (const bad of ["1.0000001", "1e3", "-5", "1,5", ""]) {
      expect(code(() => decimalToMicros(bad))).toBe("AMOUNT_INVALID");
    }
  });
  it("microsToDecimal", () => {
    expect(microsToDecimal(12_340_000n, 2)).toBe("12.34");
    expect(microsToDecimal(1_234_000_000n, 0)).toBe("1234");
    expect(code(() => microsToDecimal(12_345n, 2))).toBe("AMOUNT_NOT_REPRESENTABLE");
  });
});

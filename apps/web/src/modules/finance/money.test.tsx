import { describe, expect, it } from "vitest";
import { formatMoney, microsToUnits, unitsToMicros } from "./money";

describe("formatMoney", () => {
  it("formats USDC with up to six decimals", () => {
    expect(formatMoney("1500000", "USDC", "en")).toBe("1.50 USDC");
    expect(formatMoney("1234567", "USDC", "en")).toBe("1.234567 USDC");
    expect(formatMoney("1230000", "USDC", "en")).toBe("1.23 USDC");
    expect(formatMoney("1200000", "USDC", "en")).toBe("1.20 USDC");
    expect(formatMoney("1000001", "USDC", "en")).toBe("1.000001 USDC");
    expect(formatMoney("0", "USDC", "en")).toBe("0.00 USDC");
    expect(formatMoney("-2500000", "USDC", "en")).toBe("-2.50 USDC");
  });

  it("formats EUR in de locale", () => {
    const text = formatMoney("1234560000", "EUR", "de").replace(/\s/g, " ");
    expect(text).toBe("1.234,56 €");
    expect(formatMoney("1234560000", "EUR", "en")).toBe("€1,234.56");
    expect(formatMoney("12340000", "USD", "en")).toBe("$12.34");
  });

  it("keeps full precision for large values", () => {
    // 10^15 units of currency, far beyond Number.MAX_SAFE_INTEGER in micros.
    expect(formatMoney("1000000000000000000001", "USDC", "en")).toBe(
      "1,000,000,000,000,000.000001 USDC",
    );
    expect(formatMoney("999999999999999990000", "EUR", "en")).toBe(
      "€999,999,999,999,999.99",
    );
  });

  it("rounds sub-cent micros half to even for ISO currencies", () => {
    expect(formatMoney("1005000", "EUR", "en")).toBe("€1.00");
    expect(formatMoney("1015000", "EUR", "en")).toBe("€1.02");
    expect(formatMoney("-1015000", "EUR", "en")).toBe("-€1.02");
  });

  it("shows a dash for anything that is not whole micros", () => {
    expect(formatMoney("12.5", "EUR", "en")).toBe("—");
    expect(formatMoney("", "EUR", "en")).toBe("—");
  });
});

describe("unit conversion", () => {
  it("converts decimal text to micros without floats", () => {
    expect(unitsToMicros("2")).toBe(2_000_000);
    expect(unitsToMicros("2.5")).toBe(2_500_000);
    expect(unitsToMicros("0.000001")).toBe(1);
    expect(unitsToMicros("2,5")).toBe(2_500_000);
    expect(unitsToMicros("abc")).toBeNull();
    expect(unitsToMicros("1.0000001")).toBeNull();
    expect(unitsToMicros("-1")).toBeNull();
  });
  it("shows micros as plain decimal text", () => {
    expect(microsToUnits(2_000_000)).toBe("2");
    expect(microsToUnits(2_500_000)).toBe("2.5");
    expect(microsToUnits(1)).toBe("0.000001");
  });
});

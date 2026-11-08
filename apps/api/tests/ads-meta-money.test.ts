import { describe, expect, it } from "vitest";
import { DomainError } from "../src/platform/shared.ts";
import {
  META_CURRENCY_OFFSETS,
  metaDecimals,
  metaMajorToMicros,
  metaMinorToMicros,
  microsToMetaMajor,
  microsToMetaMinor,
} from "../src/modules/ads/providers/meta/money.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status };
    throw error;
  }
  return null;
};

describe("Meta currency units", () => {
  it("reads minor units as exact micros", () => {
    expect(metaMinorToMicros("1500", "EUR")).toBe(15_000_000n);
    expect(metaMinorToMicros(1500, "EUR")).toBe(15_000_000n);
    expect(metaMinorToMicros("1500", "JPY")).toBe(1_500_000_000n);
  });
  it("rejects non-integer minor values from Meta", () => {
    for (const bad of ["12.5", "", "-1", "1e3", "abc", 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(code(() => metaMinorToMicros(bad, "EUR"))).toEqual({ code: "ADS_PROVIDER_RESPONSE_INVALID", status: 502 });
    }
  });
  it("writes minor units only when exact", () => {
    expect(microsToMetaMinor(15_000_000n, "EUR")).toBe("1500");
    expect(code(() => microsToMetaMinor(15_005_000n, "EUR"))).toEqual({ code: "ADS_AMOUNT_NOT_REPRESENTABLE", status: 422 });
  });
  it("writes the spend cap in major units", () => {
    expect(microsToMetaMajor(100_000_000n, "USD")).toBe("100.00");
    expect(microsToMetaMajor(1_500_000_000n, "JPY")).toBe("1500");
    expect(code(() => microsToMetaMajor(100_000_001n, "USD"))).toEqual({ code: "ADS_AMOUNT_NOT_REPRESENTABLE", status: 422 });
  });
  it("reads insights spend text", () => {
    expect(metaMajorToMicros("12.34")).toBe(12_340_000n);
    expect(code(() => metaMajorToMicros("12,34"))).toEqual({ code: "ADS_PROVIDER_RESPONSE_INVALID", status: 502 });
  });
  it("maps offsets and rejects unknown currencies", () => {
    expect(metaDecimals("EUR")).toBe(2);
    expect(metaDecimals("USD")).toBe(2);
    expect(metaDecimals("JPY")).toBe(0);
    expect(metaDecimals("BHD")).toBe(2);
    expect(metaDecimals("JOD")).toBe(2);
    expect(metaDecimals("HUF")).toBe(0);
    expect(metaDecimals("TWD")).toBe(0);
    expect(code(() => metaDecimals("XYZ"))).toEqual({ code: "ADS_CURRENCY_UNSUPPORTED", status: 422 });
    expect(code(() => metaMinorToMicros("1", "XYZ"))?.code).toBe("ADS_CURRENCY_UNSUPPORTED");
  });
  it("round-trips every currency in the table", () => {
    const x = 10n ** 6n * 7n;
    for (const currency of Object.keys(META_CURRENCY_OFFSETS)) {
      expect(metaMinorToMicros(microsToMetaMinor(x, currency), currency)).toBe(x);
    }
    expect(Object.keys(META_CURRENCY_OFFSETS)).toHaveLength(66);
  });
});

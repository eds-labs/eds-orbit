import {
  MoneyError,
  decimalToMicros,
  microsToDecimal,
  microsToMinor,
  minorToMicros,
} from "../../../../../../../packages/money/src/index.ts";
import { DomainError } from "../../../../shared.ts";

// Meta's currency offsets, from
// https://developers.facebook.com/docs/marketing-api/currencies (read
// 2026-11-08; the A0 spike confirms them on real accounts). The offset says
// how many API minor units make one major unit. It differs from ISO 4217 for
// some currencies (BHD and JOD: offset 100; HUF and TWD: offset 1), so this
// table lives in the Meta adapter and not in packages/money.
const OFFSET_ONE = ["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"];
const OFFSET_HUNDRED = [
  "DZD", "ARS", "AUD", "BHD", "BDT", "BOB", "BGN", "BRL", "GBP", "CAD", "CNY", "HRK", "CZK", "DKK", "EGP", "EUR",
  "GTQ", "HNL", "HKD", "INR", "ILS", "JOD", "KES", "LVL", "LTL", "MOP", "MYR", "MXN", "NZD", "NIO", "NGN", "NOK",
  "PKR", "PEN", "PHP", "PLN", "QAR", "RON", "RUB", "SAR", "RSD", "SGD", "SKK", "ZAR", "SEK", "CHF", "THB", "TRY",
  "AED", "UAH", "USD", "UYU", "VEF", "FBZ", "VES",
];

export const META_CURRENCY_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries(OFFSET_ONE.map((currency) => [currency, 1])),
  ...Object.fromEntries(OFFSET_HUNDRED.map((currency) => [currency, 100])),
});

/** Fraction digits of Meta's minor unit (offset 100 -> 2, offset 1 -> 0). */
export function metaDecimals(currency: string): number {
  const offset = Object.hasOwn(META_CURRENCY_OFFSETS, currency) ? META_CURRENCY_OFFSETS[currency] : undefined;
  if (offset === undefined) throw new DomainError("ADS_CURRENCY_UNSUPPORTED", 422);
  const decimals = Math.round(Math.log10(offset));
  if (10 ** decimals !== offset) throw new DomainError("ADS_CURRENCY_UNSUPPORTED", 422);
  return decimals;
}

const responseInvalid = () => new DomainError("ADS_PROVIDER_RESPONSE_INVALID", 502);

const writable = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MoneyError) throw new DomainError("ADS_AMOUNT_NOT_REPRESENTABLE", 422);
    throw error;
  }
};

/** Minor units as Meta returns them (budgets, amount_spent, spend_cap read). Integer only. */
export function metaMinorToMicros(value: string | number, currency: string): bigint {
  const decimals = metaDecimals(currency);
  let minor: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw responseInvalid();
    minor = String(value);
  } else {
    minor = value;
  }
  if (!/^\d+$/.test(minor)) throw responseInvalid();
  return minorToMicros(BigInt(minor), decimals);
}

/** Micros as minor units for writes (budgets); throws when not exact. */
export function microsToMetaMinor(micros: bigint, currency: string): string {
  const decimals = metaDecimals(currency);
  return String(writable(() => microsToMinor(micros, decimals)));
}

/** Insights `spend` text (major units) to micros. */
export function metaMajorToMicros(text: string): bigint {
  try {
    return decimalToMicros(text);
  } catch (error) {
    if (error instanceof MoneyError) throw responseInvalid();
    throw error;
  }
}

/** Major-unit text for the account spend_cap as written (Meta reads minor, writes major). */
export function microsToMetaMajor(micros: bigint, currency: string): string {
  const decimals = metaDecimals(currency);
  return writable(() => microsToDecimal(micros, decimals));
}

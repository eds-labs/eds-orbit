// Typed amounts, rates and dates of the finance forms. Amounts are decimal
// strings checked against the currency's decimals with bigint math only;
// the server parses them again (parseAmount).

const DECIMALS: Readonly<Record<string, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  USDC: 6,
};
const MICRO = 1_000_000n;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^\d{1,12}(?:\.\d{1,12})?$/;

/** The decimals a currency allows, or null for one finance does not know. */
export const currencyDecimals = (currency: string): number | null =>
  DECIMALS[currency] ?? null;

const GROUPED = (separator: "." | ",") =>
  new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`);
/** A comma before exactly three final digits: refused for USDC (see below). */
const AMBIGUOUS_COMMA = /^\d{1,3}(?:\.\d{3})*,\d{3}$/;

/**
 * Typed amount text as micros, or null when it is not a non-negative
 * amount with at most the currency's decimals. Reads separators like the
 * server's parseAmount: with both "." and "," the last one is the decimal
 * separator and the other must group thousands ("1,000.50", "1.000,50"); a
 * separator that repeats groups thousands ("1,234,567"); a single one is
 * the decimal separator ("12,5"). For currencies with more than two
 * decimals a comma before exactly three final digits ("1,000") is
 * ambiguous and refused.
 */
export function amountMicros(text: string, currency: string): bigint | null {
  const decimals = currencyDecimals(currency);
  if (decimals === null) return null;
  const body = text.trim();
  if (!/^[\d.,]+$/.test(body)) return null;
  if (decimals > 2 && AMBIGUOUS_COMMA.test(body)) return null;
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let whole = body;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const index = Math.max(lastDot, lastComma);
    const grouping = body[index] === "." ? "," : ".";
    const left = body.slice(0, index);
    fraction = body.slice(index + 1);
    if (!GROUPED(grouping).test(left) || !fraction) return null;
    whole = left.replaceAll(grouping, "");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? "." : ",";
    const index = Math.max(lastDot, lastComma);
    if (body.split(separator).length > 2) {
      if (!GROUPED(separator).test(body)) return null;
      whole = body.replaceAll(separator, "");
    } else {
      whole = body.slice(0, index);
      fraction = body.slice(index + 1);
      if (!fraction) return null;
    }
  }
  if (!/^\d{1,12}$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

/** Micros text ("12500000") as input text in the currency's decimals ("12.50"). */
export function microsToInput(micros: unknown, currency: string): string {
  if (typeof micros !== "string" || !/^-?\d+$/.test(micros)) return "";
  const value = BigInt(micros);
  const abs = value < 0n ? -value : value;
  const places = currencyDecimals(currency) ?? 6;
  let fraction = (abs % MICRO).toString().padStart(6, "0");
  // Keep what the currency allows; never drop a non-zero digit.
  while (fraction.length > places && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  return `${value < 0n ? "-" : ""}${abs / MICRO}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A typed rate as the decimal text the server takes ("1,0850" becomes
 * "1.0850"), or null unless it is positive with up to 12 decimals. A comma
 * is the decimal separator, as in amounts; rates never have grouping.
 */
export function rateText(text: string): string | null {
  const body = text.trim().replace(",", ".");
  return RATE.test(body) && /[1-9]/.test(body) ? body : null;
}

/** A positive decimal rate with up to 12 decimals (comma or dot). */
export const rateValid = (text: string) => rateText(text) !== null;

/** A real `YYYY-MM-DD` calendar date. */
export function isDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

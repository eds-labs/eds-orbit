import { DomainError } from "../../shared.ts";

/**
 * Currencies the finance module knows, with their decimals for display and
 * input validation (spec §4). Amounts are stored as bigint micros (10⁻⁶ of
 * the unit) whatever the decimals.
 */
export const CURRENCY_DECIMALS = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  USDC: 6,
} as const;

export type Currency = keyof typeof CURRENCY_DECIMALS;

/** True when `code` is a currency of {@link CURRENCY_DECIMALS}. */
export const isCurrency = (code: string): code is Currency =>
  Object.hasOwn(CURRENCY_DECIMALS, code);

/** Micros per unit: amounts always carry six fraction digits internally. */
const MICRO_DIGITS = 6;
const RATE_DIGITS = 12;
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS);

const decimalsFor = (currency: string): number => {
  if (!isCurrency(currency)) {
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  }
  return CURRENCY_DECIMALS[currency];
};

/** Size of one display unit in micros, e.g. 10_000 for 2 decimals. */
const unitFor = (decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MICRO_DIGITS) {
    throw new DomainError("CURRENCY_DECIMALS_INVALID", 422);
  }
  return 10n ** BigInt(MICRO_DIGITS - decimals);
};

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/** Integer division of a non-negative numerator, rounding half to even. */
const divHalfEven = (numerator: bigint, divisor: bigint): bigint => {
  const quotient = numerator / divisor;
  const twice = (numerator % divisor) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) {
    return quotient + 1n;
  }
  return quotient;
};

const GROUPED = (separator: string) =>
  new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`);
const DIGITS = /^\d+$/;

/**
 * Parses user-entered money text into micros. Accepts an optional leading
 * "-", surrounding whitespace is trimmed, no whitespace inside the number.
 *
 * Separator detection: the last "." or "," is the decimal separator when both
 * occur, and the other kind must then be well-formed thousands grouping.
 * A single kind that occurs more than once is a thousands separator
 * ("1,234,567"). A single separator followed by exactly three digits and
 * preceded by 1-3 digits ("1,234") is ambiguous; with no further groups it is
 * read as the decimal separator, so it is rejected for 2-decimal currencies
 * (three decimals are too many) rather than silently scaled by 1000.
 */
export function parseAmount(text: string, currency: string): bigint {
  const decimals = decimalsFor(currency);
  const invalid = () => new DomainError("AMOUNT_INVALID", 422);
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  if (!/^[\d.,]+$/.test(body)) throw invalid();

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let integerPart = body;
  let fraction = "";

  if (lastDot >= 0 && lastComma >= 0) {
    const index = Math.max(lastDot, lastComma);
    const decimalSep = body[index]!;
    const thousandsSep = decimalSep === "." ? "," : ".";
    const left = body.slice(0, index);
    fraction = body.slice(index + 1);
    if (!GROUPED(thousandsSep).test(left) || fraction === "") throw invalid();
    integerPart = left.replaceAll(thousandsSep, "");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const index = Math.max(lastDot, lastComma);
    if (body.split(sep).length > 2) {
      // Repeated separator: thousands grouping only ("1,234,567").
      if (!GROUPED(sep).test(body)) throw invalid();
      integerPart = body.replaceAll(sep, "");
    } else {
      integerPart = body.slice(0, index);
      fraction = body.slice(index + 1);
      if (fraction === "") throw invalid();
    }
  }

  if (!DIGITS.test(integerPart)) throw invalid();
  if (fraction !== "" && !DIGITS.test(fraction)) throw invalid();
  if (fraction.length > decimals) throw invalid();

  const micros =
    BigInt(integerPart) * 10n ** BigInt(MICRO_DIGITS) +
    BigInt(fraction.padEnd(MICRO_DIGITS, "0"));
  return negative ? -micros : micros;
}

/**
 * Rounds micros to `decimals` fraction digits, half to even. Negative values
 * are rounded symmetrically (on the absolute value, sign restored).
 */
export function roundHalfEven(micros: bigint, decimals: number): bigint {
  const unit = unitFor(decimals);
  const rounded = divHalfEven(abs(micros), unit) * unit;
  return micros < 0n ? -rounded : rounded;
}

/**
 * Multiplies micros by a decimal-string rate (non-negative, at most 12
 * fraction digits) and rounds once, half-even, to `toDecimals`. Bigint only.
 */
export function convert(micros: bigint, rate: string, toDecimals: number): bigint {
  if (!/^\d+(?:\.\d{1,12})?$/.test(rate)) {
    throw new DomainError("RATE_INVALID", 422);
  }
  const unit = unitFor(toDecimals);
  const [whole = "0", fractionDigits = ""] = rate.split(".");
  const scaled =
    BigInt(whole) * RATE_SCALE + BigInt(fractionDigits.padEnd(RATE_DIGITS, "0"));
  const rounded = divHalfEven(abs(micros) * scaled, RATE_SCALE * unit) * unit;
  return micros < 0n ? -rounded : rounded;
}

/**
 * Plain decimal string with exactly the currency's decimals ("-12.50"), "."
 * separator and no grouping, for CSV and API output. Micros finer than the
 * currency's decimals are truncated toward zero; round first if needed.
 */
export function formatMicros(micros: bigint, currency: string): string {
  const decimals = decimalsFor(currency);
  const unit = unitFor(decimals);
  const units = abs(micros) / unit;
  const digits = units.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const text = decimals > 0 ? `${whole}.${fraction}` : whole;
  return micros < 0n && units > 0n ? `-${text}` : text;
}

/**
 * Splits `total` by basis points (largest remainder, ties to the earlier
 * part) in whole units of `decimals`, so the parts always sum to the total.
 */
export function splitByBasisPoints(
  total: bigint,
  parts: { key: string; bp: number }[],
  decimals: number,
): { key: string; micros: bigint }[] {
  const unit = unitFor(decimals);
  const invalid = () => new DomainError("ALLOCATION_INVALID", 422);
  if (parts.length === 0 || total % unit !== 0n) throw invalid();
  let sum = 0;
  for (const part of parts) {
    if (!Number.isInteger(part.bp) || part.bp < 0) throw invalid();
    sum += part.bp;
  }
  if (sum !== 10_000) throw invalid();

  const totalUnits = abs(total) / unit;
  const shares = parts.map((part, index) => {
    const product = totalUnits * BigInt(part.bp);
    return { index, floor: product / 10_000n, remainder: product % 10_000n };
  });
  let left = totalUnits - shares.reduce((acc, share) => acc + share.floor, 0n);
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  const extra = new Set<number>();
  for (const share of order) {
    if (left <= 0n) break;
    extra.add(share.index);
    left -= 1n;
  }
  return parts.map((part, index) => {
    const units = shares[index]!.floor + (extra.has(index) ? 1n : 0n);
    const micros = units * unit;
    return { key: part.key, micros: total < 0n ? -micros : micros };
  });
}

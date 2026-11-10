/**
 * Provider-neutral exact money arithmetic on bigint micros (10^-6 of the
 * unit). No floats, no rounding unless a function says so. Errors are
 * {@link MoneyError}; callers map them to their own error type.
 */

/** Thrown for invalid input; `code` is also the message. */
export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MoneyError";
    this.code = code;
  }
}

/** Micros per unit: amounts always carry six fraction digits internally. */
const MICRO_DIGITS = 6;
const RATE_DIGITS = 12;
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS);

/** Size of one display unit in micros, e.g. 10_000 for 2 decimals. */
const unitFor = (decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MICRO_DIGITS) {
    throw new MoneyError("CURRENCY_DECIMALS_INVALID");
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
 * A comma before exactly three final digits, with at most dot-grouped
 * thousands before it ("1,000", "1.234,567"): a thousands group to some
 * readers and a decimal comma to others.
 */
const AMBIGUOUS_COMMA = /^\d{1,3}(?:\.\d{3})*,\d{3}$/;

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
 * (three decimals are too many) rather than silently scaled by 1000. For
 * currencies with more decimals (USDC) a comma before exactly three final
 * digits ("1,000", "1.234,567") is rejected as well instead of guessed; a
 * dot stays a decimal point ("1.000" is 1).
 */
export function parseAmount(text: string, decimals: number): bigint {
  const invalid = () => new MoneyError("AMOUNT_INVALID");
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  if (!/^[\d.,]+$/.test(body)) throw invalid();
  if (decimals > 2 && AMBIGUOUS_COMMA.test(body)) throw invalid();

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
    throw new MoneyError("RATE_INVALID");
  }
  const unit = unitFor(toDecimals);
  const [whole = "0", fractionDigits = ""] = rate.split(".");
  const scaled =
    BigInt(whole) * RATE_SCALE + BigInt(fractionDigits.padEnd(RATE_DIGITS, "0"));
  const rounded = divHalfEven(abs(micros) * scaled, RATE_SCALE * unit) * unit;
  return micros < 0n ? -rounded : rounded;
}

/**
 * Plain decimal string with exactly `decimals` fraction digits ("-12.50"), "."
 * separator and no grouping, for CSV and API output. Micros finer than
 * `decimals` are truncated toward zero; round first if needed.
 */
export function formatMicros(micros: bigint, decimals: number): string {
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
  const invalid = () => new MoneyError("ALLOCATION_INVALID");
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

/** Micros per whole currency unit. */
export const MICROS_PER_UNIT = 1_000_000n;

/** Converts minor units (cents for 2 decimals) to micros. Exact. */
export function minorToMicros(minor: bigint, decimals: number): bigint {
  return minor * unitFor(decimals);
}

/** Converts micros to minor units; throws when it would lose precision. */
export function microsToMinor(micros: bigint, decimals: number): bigint {
  const unit = unitFor(decimals);
  if (micros % unit !== 0n) throw new MoneyError("AMOUNT_NOT_REPRESENTABLE");
  return micros / unit;
}

/** Strict non-negative decimal text (at most 6 fraction digits) to micros. */
export function decimalToMicros(text: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new MoneyError("AMOUNT_INVALID");
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * MICROS_PER_UNIT + BigInt(fraction.padEnd(MICRO_DIGITS, "0"));
}

/**
 * Decimal text with exactly `decimals` fraction digits; throws when the
 * micros are finer than `decimals` (no silent rounding or truncation).
 */
export function microsToDecimal(micros: bigint, decimals: number): string {
  const unit = unitFor(decimals);
  if (micros % unit !== 0n) throw new MoneyError("AMOUNT_NOT_REPRESENTABLE");
  return formatMicros(micros, decimals);
}

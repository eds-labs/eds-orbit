import {
  MoneyError,
  convert as convertMicros,
  formatMicros as formatMicrosByDecimals,
  parseAmount as parseAmountByDecimals,
  roundHalfEven as roundHalfEvenByDecimals,
  splitByBasisPoints as splitByBasisPointsByDecimals,
} from "../../../../../packages/money/src/index.ts";
import { DomainError } from "../../shared.ts";

/**
 * Currencies the finance module knows, with their decimals for display and
 * input validation (spec §4). Amounts are stored as bigint micros (10⁻⁶ of
 * the unit) whatever the decimals. The arithmetic lives in `packages/money`;
 * this file adds the currency table and maps `MoneyError` to `DomainError`
 * (422).
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

const decimalsFor = (currency: string): number => {
  if (!isCurrency(currency)) {
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  }
  return CURRENCY_DECIMALS[currency];
};

const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MoneyError) throw new DomainError(error.code, 422);
    throw error;
  }
};

/** Parses user-entered money text into micros; see `packages/money` for the separator rules. */
export function parseAmount(text: string, currency: string): bigint {
  const decimals = decimalsFor(currency);
  return wrap(() => parseAmountByDecimals(text, decimals));
}

/** Rounds micros to `decimals` fraction digits, half to even. */
export function roundHalfEven(micros: bigint, decimals: number): bigint {
  return wrap(() => roundHalfEvenByDecimals(micros, decimals));
}

/** Multiplies micros by a decimal-string rate and rounds once, half-even. */
export function convert(micros: bigint, rate: string, toDecimals: number): bigint {
  return wrap(() => convertMicros(micros, rate, toDecimals));
}

/** Plain decimal string with exactly the currency's decimals ("-12.50"). */
export function formatMicros(micros: bigint, currency: string): string {
  const decimals = decimalsFor(currency);
  return wrap(() => formatMicrosByDecimals(micros, decimals));
}

/** Splits `total` by basis points (largest remainder) in whole units of `decimals`. */
export function splitByBasisPoints(
  total: bigint,
  parts: { key: string; bp: number }[],
  decimals: number,
): { key: string; micros: bigint }[] {
  return wrap(() => splitByBasisPointsByDecimals(total, parts, decimals));
}

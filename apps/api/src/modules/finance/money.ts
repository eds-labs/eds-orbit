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

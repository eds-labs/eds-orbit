// Money formatting for the finance views. Amounts arrive as bigint micros
// (10^-6 of a currency unit) in decimal strings; they are split with bigint
// math and never pass through a float.

const ISO_DECIMALS: Readonly<Record<string, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
};
const MICRO = 1_000_000n;
const WHOLE_MICROS = /^-?\d+$/;

/** The currencies a project can enable (spec §4), in the order offered. */
export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "USDC"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Exact decimal text of micros: "-12.345600" without trailing zeros kept to `min` places. */
function decimalText(micros: bigint, places: number, min: number): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICRO;
  let fraction = (abs % MICRO).toString().padStart(6, "0").slice(0, places);
  while (fraction.length > min && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Micros rounded half to even to `places` decimals, as a scaled integer. */
function roundHalfEven(micros: bigint, places: number): bigint {
  const step = 10n ** BigInt(6 - places);
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  let quotient = abs / step;
  const rest = abs % step;
  const twice = rest * 2n;
  if (twice > step || (twice === step && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

// `Intl.NumberFormat#format` reads a decimal string exactly (ES2023); the
// typings only list number and bigint.
const exact = (text: string) => text as unknown as number;

/**
 * An amount for display. ISO currencies go through Intl (two decimals, the
 * sub-cent part rounded half to even); USDC is "<amount> USDC" with two to
 * six decimals, trailing zeros beyond two trimmed. Anything that is not a
 * whole number of micros reads "—".
 */
export function formatMoney(
  micros: string,
  currency: string,
  locale: string,
): string {
  if (!WHOLE_MICROS.test(micros)) return "—";
  const value = BigInt(micros);
  if (currency === "USDC") {
    const text = decimalText(value, 6, 2);
    const amount = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(exact(text));
    return `${amount} USDC`;
  }
  const places = ISO_DECIMALS[currency];
  if (places === undefined) return "—";
  const scaled = roundHalfEven(value, places);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const unit = 10n ** BigInt(places);
  const text = `${negative ? "-" : ""}${abs / unit}.${(abs % unit).toString().padStart(places, "0")}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(exact(text));
}

// Fractional ranks for board and list order: strings over base-62 digits
// that sort with the "C" collation, so a task moves by rewriting its own
// rank only. A rank never ends in "0", so there is always room between two.

const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0]!;
const RANK = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export const isRank = (value: string) => RANK.test(value) && value.length <= 200;

/** A key strictly between `a` and `b` ("" is the lowest, null the highest). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error("WORK_RANK_ORDER");
  if (b) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]!;
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * A rank after `before` (the item above) and ahead of `after` (the item
 * below); either may be null at the ends. Throws WORK_RANK_ORDER when the
 * two are not in order, such as after a concurrent move.
 */
export function rankBetween(before: string | null, after: string | null) {
  for (const value of [before, after])
    if (value !== null && !isRank(value)) throw new Error("WORK_RANK_INVALID");
  return midpoint(before ?? "", after);
}

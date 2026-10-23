// Date ranges of the finance dashboard periods (kept apart so the home card
// does not pull the dashboard into its bundle).

export type Period = "12m" | "year" | "lastYear";
export const PERIODS: readonly Period[] = ["12m", "year", "lastYear"];
const RECEIPT_LIMIT = 10;

/** The period named in the URL; anything unknown is the default. */
export function periodOf(value: string | null): Period {
  return PERIODS.find((p) => p === value) ?? "12m";
}

const isoDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);

/**
 * The date range of a period (UTC). "12m" is the last twelve months
 * including the current one and ends with the current month; "year" runs
 * January to the end of the current month; "lastYear" is the previous
 * calendar year.
 */
export function periodRange(period: Period, now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "lastYear")
    return { from: isoDay(year - 1, 0, 1), to: isoDay(year - 1, 12, 0) };
  const monthEnd = isoDay(year, month + 1, 0);
  return period === "year"
    ? { from: isoDay(year, 0, 1), to: monthEnd }
    : { from: isoDay(year, month - 11, 1), to: monthEnd };
}

import { randomUUID } from "node:crypto";
import {
  boundedFetch,
  type FetchLike,
} from "../../../../../packages/connectors/src/http.ts";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { DomainError } from "../../shared.ts";
import { financeActive } from "./gate.ts";
import { parseEcbXml } from "./fx-ecb.ts";
import type { Rate } from "./ledger/posting.ts";
import { isCurrency } from "./money.ts";
import { readFinanceSettings } from "./settings.ts";

export type { Rate };

const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const MAX_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_CHARS = 2 * 1024 * 1024;
const DECIMAL = /^\d+(?:\.\d{1,12})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const invalidRate = () => new DomainError("RATE_INVALID", 422);

/** A positive decimal string with at most 12 fraction digits, as 10^12-scaled bigint. */
function toScaled(rate: string): bigint {
  if (!DECIMAL.test(rate)) throw invalidRate();
  const [whole = "0", fraction = ""] = rate.split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, "0"));
  if (scaled <= 0n) throw invalidRate();
  return scaled;
}

/** Scaled bigint back to a decimal string without trailing fraction zeros. */
function fromScaled(scaled: bigint): string {
  const whole = scaled / SCALE;
  const fraction = (scaled % SCALE)
    .toString()
    .padStart(SCALE_DIGITS, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Non-negative integer division rounding half to even. */
function divHalfEven(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  const twice = (numerator % divisor) * 2n;
  return twice > divisor || (twice === divisor && quotient % 2n === 1n)
    ? quotient + 1n
    : quotient;
}

/**
 * The rate from `from` to `to` given units per EUR (EUR is implicit 1):
 * `perEur[to] / perEur[from]`, rounded half-even to 12 fraction digits.
 */
export function crossRate(
  perEur: Record<string, string>,
  from: string,
  to: string,
): string {
  const side = (code: string) => {
    if (code === "EUR") return SCALE;
    const value = perEur[code];
    if (value === undefined) throw new DomainError("FX_RATE_MISSING", 422);
    return toScaled(value);
  };
  const result = divHalfEven(side(to) * SCALE, side(from));
  if (result <= 0n) throw invalidRate();
  return fromScaled(result);
}

/** Product of two decimal strings, rounded half-even to 12 fraction digits. */
const multiply = (a: string, b: string) =>
  fromScaled(divHalfEven(toScaled(a) * toScaled(b), SCALE));

const parseDate = (date: string): Date => {
  if (!ISO_DATE.test(date)) throw new DomainError("DATE_INVALID", 422);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new DomainError("DATE_INVALID", 422);
  return parsed;
};
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

type Found = { perEur: string; date: string; source: "ecb" | "manual" };

/** Newest stored rate on or before `date` (7 days back); manual wins on the same day. */
async function findRate(
  tx: DbTx,
  scope: Scope,
  currency: string,
  date: string,
): Promise<Found> {
  const day = parseDate(date);
  const rows = await tx.financeFxRate.findMany({
    where: {
      projectId: scope.projectId,
      currency,
      date: {
        lte: day,
        gte: new Date(day.getTime() - MAX_LOOKBACK_DAYS * DAY_MS),
      },
    },
    orderBy: { date: "desc" },
  });
  if (!rows.length) throw new DomainError("FX_RATE_MISSING", 422);
  const newest = isoDate(rows[0]!.date);
  const sameDay = rows.filter((row) => isoDate(row.date) === newest);
  const row = sameDay.find((r) => r.source === "manual") ?? sameDay[0]!;
  return {
    perEur: row.perEur.toFixed(SCALE_DIGITS),
    date: newest,
    source: row.source === "manual" ? "manual" : "ecb",
  };
}

/**
 * The rate converting `from` into `to` on `date` (spec §5). An override wins
 * after validation. USDC goes through the project's USDC-per-USD peg; other
 * currencies use the newest stored per-EUR rate within a week, the older date
 * when two are combined. No rate throws 422 FX_RATE_MISSING.
 */
export async function rateFor(
  tx: DbTx,
  scope: Scope,
  from: string,
  to: string,
  date: string,
  override?: Rate,
): Promise<Rate> {
  if (override) {
    toScaled(override.rate);
    return override;
  }
  if (!isCurrency(from) || !isCurrency(to))
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  parseDate(date);
  if (from === to) return { rate: "1", rateDate: date, source: "identity" };

  const { settings } = await readFinanceSettings(tx, scope);
  const peg = settings.usdcPeg;
  if ((from === "USDC" && to === "USD") || (from === "USD" && to === "USDC")) {
    return {
      rate: crossRate({ USDC: peg, USD: "1" }, from, to),
      rateDate: date,
      source: "peg",
    };
  }

  // USDC is quoted through USD: perEur[USDC] = perEur[USD] * peg.
  const lookup = (code: string) => findRate(tx, scope, code === "USDC" ? "USD" : code, date);
  const legs = [from, to].filter((code) => code !== "EUR");
  const found = new Map<string, Found>();
  for (const code of legs) found.set(code, await lookup(code));

  const perEur: Record<string, string> = {};
  for (const [code, rate] of found)
    perEur[code] = code === "USDC" ? multiply(rate.perEur, peg) : rate.perEur;
  const used = [...found.values()];
  return {
    rate: crossRate(perEur, from, to),
    rateDate: used.map((u) => u.date).sort()[0]!,
    source: used.some((u) => u.source === "manual") ? "manual" : "ecb",
  };
}

/** Stores (or replaces) a manual per-EUR rate for one currency and day. */
export async function setManualRate(
  tx: DbTx,
  scope: Scope,
  input: { date: string; currency: string; perEur: string },
) {
  if (!isCurrency(input.currency) || input.currency === "EUR")
    throw new DomainError("CURRENCY_UNSUPPORTED", 422);
  const date = parseDate(input.date);
  toScaled(input.perEur);
  const key = {
    projectId: scope.projectId,
    date,
    currency: input.currency,
    source: "manual",
  };
  await tx.financeFxRate.upsert({
    where: { projectId_date_currency_source: key },
    create: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      ...key,
      perEur: input.perEur,
    },
    update: { perEur: input.perEur },
  });
}

let fetchOverride: FetchLike | null = null;
/** Tests replace the network; null restores the bounded platform fetch. */
export function setFxFetchForTests(fetcher: FetchLike | null) {
  fetchOverride = fetcher;
}

/** Fetches the 90-day ECB feed; throws on any failure. */
async function fetchFeed(): Promise<string> {
  const fetcher = fetchOverride ?? boundedFetch;
  const response = await fetcher(ECB_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("FX_FEED_HTTP");
  const text = await response.text();
  if (text.length > MAX_FEED_CHARS) throw new Error("FX_FEED_TOO_LARGE");
  return text;
}

/** Upserts the feed's days as `ecb` rows; returns the number of rows written. */
export async function storeEcbRates(
  tx: DbTx,
  scope: Scope,
  days: ReturnType<typeof parseEcbXml>,
) {
  const existing = await tx.financeFxRate.findMany({
    where: { projectId: scope.projectId, source: "ecb" },
    select: { date: true, currency: true, perEur: true },
  });
  const known = new Map(
    existing.map((r) => [
      `${isoDate(r.date)}|${r.currency}`,
      fromScaled(toScaled(r.perEur.toFixed(SCALE_DIGITS))),
    ]),
  );
  let written = 0;
  for (const day of days) {
    for (const [currency, perEur] of Object.entries(day.perEur)) {
      if (known.get(`${day.date}|${currency}`) === fromScaled(toScaled(perEur)))
        continue;
      const key = {
        projectId: scope.projectId,
        date: parseDate(day.date),
        currency,
        source: "ecb",
      };
      await tx.financeFxRate.upsert({
        where: { projectId_date_currency_source: key },
        create: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          ...key,
          perEur,
        },
        update: { perEur },
      });
      written += 1;
    }
  }
  return written;
}

// Throttle per project and process: a day after a success, an hour after a
// failure. Nothing is persisted; a restart merely fetches once more.
const SUCCESS_BACKOFF_MS = DAY_MS;
const FAILURE_BACKOFF_MS = 3_600_000;
const nextAttempt = new Map<string, number>();
/** Tests only: forget the throttle. */
export function resetFxSyncThrottle() {
  nextAttempt.clear();
}

/** Daily ECB sync for projects with `fxSource === "ecb"`; never throws. */
export const financeFxSync: PeriodicTask = {
  name: "finance-fx-sync",
  async nextDueAt(tx, scope) {
    if (!(await financeActive(tx, scope))) return null;
    const { settings } = await readFinanceSettings(tx, scope);
    if (settings.fxSource !== "ecb") return null;
    const newest = await tx.financeFxRate.findFirst({
      where: { projectId: scope.projectId, source: "ecb" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const stored = newest ? newest.createdAt.getTime() + DAY_MS : 0;
    return new Date(Math.max(stored, nextAttempt.get(scope.projectId) ?? 0));
  },
  async run(scope) {
    try {
      const due = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        financeFxSync.nextDueAt!(tx, scope),
      );
      if (!due) return { status: "idle" };
      if (due.getTime() > Date.now()) return { status: "idle", wakeAt: due };

      const days = parseEcbXml(await fetchFeed());
      const written = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        storeEcbRates(tx, scope, days),
      );
      nextAttempt.set(scope.projectId, Date.now() + SUCCESS_BACKOFF_MS);
      return {
        status: `fx rates=${written}`,
        wakeAt: new Date(Date.now() + SUCCESS_BACKOFF_MS),
      };
    } catch {
      nextAttempt.set(scope.projectId, Date.now() + FAILURE_BACKOFF_MS);
      return {
        status: "fx failed",
        wakeAt: new Date(Date.now() + FAILURE_BACKOFF_MS),
      };
    }
  },
};

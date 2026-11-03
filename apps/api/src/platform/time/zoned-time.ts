/**
 * Wall-clock times in IANA time zones without a date library: what instant a
 * local time names, including the two cases daylight saving creates. In a
 * gap (spring forward) the local time does not exist; in an overlap (fall
 * back) it exists twice. Minute precision, as schedules use.
 */

export type LocalResolution =
  | { kind: "exact"; at: Date }
  /** The local time does not exist; the first valid minute after the gap. */
  | { kind: "gap"; suggestedAt: Date; suggestedLocal: string }
  /** The local time exists twice: before and after the clocks went back. */
  | { kind: "ambiguous"; earlier: Date; later: Date };

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MINUTE = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall clock of an instant, as milliseconds of a UTC date with the same fields. */
function wallClock(at: number, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}

const offset = (at: number, timeZone: string) => wallClock(at, timeZone) - Math.floor(at / MINUTE) * MINUTE;

/** True when Intl knows the zone. */
export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** An instant as local time `YYYY-MM-DDTHH:MM` in the zone. */
export function localOf(at: Date, timeZone: string): string {
  return new Date(wallClock(at.getTime(), timeZone)).toISOString().slice(0, 16);
}

/**
 * The instant(s) a local time `YYYY-MM-DDTHH:MM` names in the zone. Throws
 * a RangeError for a malformed local time or an unknown zone.
 */
export function resolveLocalTime(local: string, timeZone: string): LocalResolution {
  const m = LOCAL.exec(local);
  if (!m) throw new RangeError("INVALID_LOCAL_TIME");
  const wanted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (new Date(wanted).toISOString().slice(0, 16) !== local) throw new RangeError("INVALID_LOCAL_TIME");
  if (!isTimeZone(timeZone)) throw new RangeError("INVALID_TIME_ZONE");
  // The offsets a day before and after cover both sides of any change.
  const before = offset(wanted - DAY, timeZone);
  const after = offset(wanted + DAY, timeZone);
  const candidates = [...new Set([wanted - before, wanted - after])].sort((a, b) => a - b);
  const valid = candidates.filter((at) => wallClock(at, timeZone) === wanted);
  if (valid.length === 2) return { kind: "ambiguous", earlier: new Date(valid[0]!), later: new Date(valid[1]!) };
  if (valid.length === 1) return { kind: "exact", at: new Date(valid[0]!) };
  // A gap: the change lies between the candidates; find its first minute.
  let lo = candidates[0]!;
  let hi = candidates[candidates.length - 1]!;
  const first = offset(lo, timeZone);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offset(mid, timeZone) === first) lo = mid;
    else hi = mid;
  }
  return { kind: "gap", suggestedAt: new Date(hi), suggestedLocal: localOf(new Date(hi), timeZone) };
}

/**
 * Fixed daily posting times per channel. Run n of a mission is planned for
 * day n at the channel's local posting time, counted from the first slot at or
 * after the mission start, so every run of a series gets its own day.
 */
export const POSTING_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function localParts(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** UTC instant of a wall-clock time in a timezone (DST-safe via two passes). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let at = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const p = localParts(new Date(at), timezone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    at += wanted - shown;
  }
  return new Date(at);
}

export function postingSlot(
  startAt: string | Date,
  postingTime: string,
  timezone: string,
  runIndex: number,
) {
  const match = POSTING_TIME.exec(postingTime);
  if (!match || !Number.isInteger(runIndex) || runIndex < 0) return null;
  const start = new Date(startAt);
  if (!Number.isFinite(start.valueOf())) return null;
  const hour = Number(match[1]),
    minute = Number(match[2]);
  const base = localParts(start, timezone);
  let offset = 0;
  const slot = (days: number) =>
    zonedTime(base.year, base.month, base.day + days, hour, minute, timezone);
  if (slot(0) < start) offset = 1;
  return slot(offset + runIndex);
}

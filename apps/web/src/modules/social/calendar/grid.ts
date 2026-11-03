import type { CalendarItem } from "../api";

// Calendar arithmetic (S6) in the project's IANA time zone, without a date
// library. Dates are YYYY-MM-DD, local times YYYY-MM-DDTHH:MM, instants ISO.

export type DayCell = { date: string; inMonth: boolean; isToday: boolean };
export type Slot = { local: string; at: string; label: string; repeated: boolean };

const MINUTE = 60_000;
const DAY = 86_400_000;
const SLOT = 30 * MINUTE;

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

/** The wall clock of an instant as YYYY-MM-DDTHH:MM in the zone. */
export function localOf(at: Date | string | number, timeZone: string): string {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const utcOf = (local: string) => Date.parse(`${local}:00Z`);

/** The first instant whose wall clock is `local`, or the first after it when the clocks skip it. */
export function instantOf(local: string, timeZone: string): number {
  const naive = utcOf(local);
  // Offsets are within ±14 h: try the offsets around the naive instant.
  for (const probe of [naive - DAY, naive, naive + DAY]) {
    const at = naive - (utcOf(localOf(probe, timeZone)) - probe);
    if (localOf(at, timeZone) === local) {
      // Prefer the earlier of two occurrences (fall back).
      for (const earlier of [at - 2 * 3_600_000, at - 3_600_000])
        if (localOf(earlier, timeZone) === local) return earlier;
      return at;
    }
  }
  // In a gap: the wall clock moves past `local`; take the instant it resumes.
  let at = naive - (utcOf(localOf(naive, timeZone)) - naive);
  while (localOf(at, timeZone) < local) at += MINUTE * 30;
  while (localOf(at - MINUTE, timeZone) >= local) at -= MINUTE;
  return at;
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

function weekStart(date: string, weekStartsOn: 1 | 0) {
  return addDays(date, -((weekday(date) - weekStartsOn + 7) % 7));
}

/** The whole weeks that show a month: 28, 35 or 42 cells. */
export function monthCells(month: string, timeZone: string, today: Date, weekStartsOn: 1 | 0 = 1): DayCell[] {
  const first = `${month}-01`;
  const next = addDays(`${month}-28`, 4).slice(0, 7);
  const last = addDays(`${next}-01`, -1);
  const todayDate = localOf(today, timeZone).slice(0, 10);
  const cells: DayCell[] = [];
  for (let date = weekStart(first, weekStartsOn); date <= last || cells.length % 7 !== 0; date = addDays(date, 1))
    cells.push({ date, inMonth: date.startsWith(month), isToday: date === todayDate });
  return cells;
}

/** The seven dates of the week that holds `anchor`. */
export function weekDays(anchor: string, weekStartsOn: 1 | 0 = 1): string[] {
  const start = weekStart(anchor, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The day's half hours: 48, or 46 when the clocks go forward and 50 when they go back. */
export function daySlots(date: string, timeZone: string): Slot[] {
  const start = instantOf(`${date}T00:00`, timeZone);
  const end = instantOf(`${addDays(date, 1)}T00:00`, timeZone);
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (let at = start; at < end; at += SLOT) {
    const local = localOf(at, timeZone);
    slots.push({ local, at: new Date(at).toISOString(), label: local.slice(11), repeated: seen.has(local) });
    seen.add(local);
  }
  return slots;
}

const timeOf = (item: CalendarItem) => (item.schedule.at ? Date.parse(item.schedule.at) : Number.NaN);

function grouped(items: CalendarItem[], key: (at: number) => string) {
  const map = new Map<string, CalendarItem[]>();
  for (const item of [...items].filter((i) => !Number.isNaN(timeOf(i))).sort((a, b) => timeOf(a) - timeOf(b))) {
    const k = key(timeOf(item));
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

/** The posts by their local date, in time order. */
export function placeByDay(items: CalendarItem[], timeZone: string): Map<string, CalendarItem[]> {
  return grouped(items, (at) => localOf(at, timeZone).slice(0, 10));
}

/** The posts by the instant their half-hour slot starts, in time order. */
export function placeBySlot(items: CalendarItem[], timeZone: string): Map<string, CalendarItem[]> {
  return grouped(items, (at) => {
    // Slots start on the wall clock's half hours; zones with odd offsets keep that grid.
    const local = localOf(at, timeZone);
    const back = (Number(local.slice(14)) % 30) * MINUTE + (at % MINUTE);
    return new Date(at - back).toISOString();
  });
}

/** The instants the visible week or month grid covers: [from, to). */
export function rangeOf(view: "month" | "week", anchor: string, timeZone: string): { from: string; to: string } {
  const days = view === "week" ? weekDays(anchor) : monthCells(anchor.slice(0, 7), timeZone, new Date(0)).map((c) => c.date);
  const iso = (date: string) => new Date(instantOf(`${date}T00:00`, timeZone)).toISOString();
  return { from: iso(days[0]!), to: iso(addDays(days[days.length - 1]!, 1)) };
}

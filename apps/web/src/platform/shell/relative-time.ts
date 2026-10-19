import type { AttentionItem } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

// The time pill of an attention row (UI restructure §5.1). The renderers omit
// dates on purpose; the home page says when an item is due, or how long it
// has been waiting, relative to now.

const MINUTE = 60_000;
/** Due times below this many minutes keep their minutes ("1 Std. 59 Min."). */
const PRECISE_MINUTES = 120;

/**
 * A positive duration of whole minutes: minutes under an hour ("45 Min." /
 * "45 min"); with `precise`, hours and minutes under two hours ("1 Std.
 * 59 Min." / "1 h 59 min"); above that hours and days, each rounded to the
 * nearest ("3 Std." / "3 h", "2 Tagen" / "2 days"). German days take the
 * dative, as every phrase here ("in", "seit") needs it.
 */
function span(minutes: number, locale: Locale, precise: boolean): string {
  const de = locale === "de";
  const min = (n: number) => (de ? `${n} Min.` : `${n} min`);
  const hrs = (n: number) => (de ? `${n} Std.` : `${n} h`);
  if (minutes < 60) return min(minutes);
  if (precise && minutes < PRECISE_MINUTES) {
    const rest = minutes % 60;
    return rest ? `${hrs(1)} ${min(rest)}` : hrs(1);
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hrs(hours);
  const days = Math.max(1, Math.round(minutes / (24 * 60)));
  return de
    ? `${days} ${days === 1 ? "Tag" : "Tagen"}`
    : `${days} ${days === 1 ? "day" : "days"}`;
}

/** Whole minutes of a duration, rounded to the nearest. */
const minutesOf = (ms: number) => Math.round(Math.abs(ms) / MINUTE);

const time = (iso: string | undefined) => {
  const at = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

/**
 * The pill text of an item: its due time while `dueAt` is set ("in 45 Min.",
 * "jetzt fällig" within half a minute, "überfällig seit 10 Min." once past;
 * minutes kept under two hours), else its age from `since` ("seit 3 Std."),
 * else null.
 */
export function attentionWhen(
  item: Pick<AttentionItem, "dueAt" | "since">,
  now: Date,
  locale: Locale,
): { text: string; overdue: boolean } | null {
  const due = time(item.dueAt);
  if (due !== null) {
    const ahead = due - now.getTime();
    const minutes = minutesOf(ahead);
    if (minutes === 0)
      return {
        text: locale === "de" ? "jetzt fällig" : "due now",
        overdue: false,
      };
    const left = span(minutes, locale, true);
    if (ahead > 0) return { text: `in ${left}`, overdue: false };
    return {
      text: locale === "de" ? `überfällig seit ${left}` : `overdue by ${left}`,
      overdue: true,
    };
  }
  const since = time(item.since);
  if (since === null) return null;
  // An age is at least a minute ("seit 1 Min."), never "now".
  const age = span(
    Math.max(1, minutesOf(Math.max(0, now.getTime() - since))),
    locale,
    false,
  );
  return {
    text: locale === "de" ? `seit ${age}` : `${age} ago`,
    overdue: false,
  };
}

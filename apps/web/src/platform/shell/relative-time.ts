import type { AttentionItem } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

// The time pill of an attention row (UI restructure §5.1). The renderers omit
// dates on purpose; the home page says when an item is due, or how long it
// has been waiting, relative to now.

const MINUTE = 60_000;

/**
 * A positive duration in the largest whole unit, at least one minute:
 * "45 Min." / "45 min", "3 Std." / "3 h", "2 Tagen" / "2 days". German days
 * take the dative, as every phrase here ("in", "seit") needs it.
 */
function span(ms: number, locale: Locale): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60)
    return locale === "de" ? `${minutes} Min.` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === "de" ? `${hours} Std.` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return locale === "de"
    ? `${days} ${days === 1 ? "Tag" : "Tagen"}`
    : `${days} ${days === 1 ? "day" : "days"}`;
}

const time = (iso: string | undefined) => {
  const at = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

/**
 * The pill text of an item: its due time while `dueAt` is set ("in 45 Min.",
 * or "überfällig seit 10 Min." once past), else its age from `since`
 * ("seit 3 Std."), else null.
 */
export function attentionWhen(
  item: Pick<AttentionItem, "dueAt" | "since">,
  now: Date,
  locale: Locale,
): { text: string; overdue: boolean } | null {
  const due = time(item.dueAt);
  if (due !== null) {
    const ahead = due - now.getTime();
    if (ahead > 0) return { text: `in ${span(ahead, locale)}`, overdue: false };
    const past = span(-ahead, locale);
    return {
      text: locale === "de" ? `überfällig seit ${past}` : `overdue by ${past}`,
      overdue: true,
    };
  }
  const since = time(item.since);
  if (since === null) return null;
  const age = span(Math.max(0, now.getTime() - since), locale);
  return {
    text: locale === "de" ? `seit ${age}` : `${age} ago`,
    overdue: false,
  };
}

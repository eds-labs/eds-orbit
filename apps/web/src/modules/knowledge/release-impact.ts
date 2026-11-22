import { api, MutationCanceled } from "@/lib/api";
import { knowledgeCopy, releaseImpactSentence } from "./workspace-text";

type Locale = "de" | "en";

/** Mirrors the API route `GET /projects/:id/knowledge/release-impact`. */
export type ReleaseImpact = {
  enabled: boolean;
  gateValid: boolean;
  count: number;
  /** Empty when the caller may not see Marketing details; count is still set. */
  dependents: Array<{
    id: string;
    title: string;
    slotAt: string;
    timeZone: string;
    channels: string[];
  }>;
};

const MAX_LISTED = 3;
const DAY = 86_400_000;
const norm = (locale: string): Locale => (locale === "de" ? "de" : "en");

const parts = (
  at: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) => new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(at);
const dayKey = (at: Date, timeZone: string) =>
  parts(at, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });

/** Slot in the post's own time zone: today/tomorrow word, else a short date, then HH:mm. */
export function formatReleaseSlot(
  slotAt: string,
  timeZone: string,
  locale: string,
  now: Date = new Date(),
): string {
  const l = norm(locale);
  const t = knowledgeCopy[l];
  const at = new Date(slotAt);
  let zone = timeZone;
  try {
    dayKey(at, zone);
  } catch {
    zone = "UTC";
  }
  const time = parts(at, zone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const key = dayKey(at, zone);
  if (key === dayKey(now, zone)) return `${t.releaseImpactToday} ${time}`;
  if (key === dayKey(new Date(now.getTime() + DAY), zone))
    return `${t.releaseImpactTomorrow} ${time}`;
  const date = new Intl.DateTimeFormat(l === "de" ? "de-DE" : "en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "numeric",
  }).format(at);
  return `${date} ${time}`;
}

export function releaseImpactText(
  impact: ReleaseImpact,
  locale: string,
  now: Date = new Date(),
): string {
  const l = norm(locale);
  const t = knowledgeCopy[l];
  if (!impact.dependents.length)
    return releaseImpactSentence(impact.count, false, t);
  const items = impact.dependents.slice(0, MAX_LISTED).map((d) => {
    const label = d.channels.length ? d.channels.join(", ") : d.title;
    return `${formatReleaseSlot(d.slotAt, d.timeZone, l, now)} · ${label}`;
  });
  const more = impact.count - items.length;
  const list = items.join(", ") + (more > 0 ? ` +${more}` : "");
  return releaseImpactSentence(impact.count, true, t).replace("{list}", list);
}

/**
 * Ask before an action that changes the knowledge corpus and so locks released
 * posts. Resolves true to go ahead. A failed check never blocks the action.
 */
export async function confirmReleaseImpact(
  projectId: string,
  locale: string,
  ask: (text: string) => boolean = (text) => window.confirm(text),
): Promise<boolean> {
  let impact: ReleaseImpact;
  try {
    impact = await api<ReleaseImpact>(
      `/projects/${encodeURIComponent(projectId)}/knowledge/release-impact`,
    );
  } catch {
    return true;
  }
  if (!impact.enabled || !impact.gateValid || impact.count === 0) return true;
  return ask(releaseImpactText(impact, locale));
}

/**
 * Runs a corpus-changing action inside the caller's mutation lock, after the
 * release-impact question: a second click while the check is pending or the
 * question is open starts nothing. A cancel sends no request and shows no
 * error. `run` is `useMutation().run`.
 */
export function runAfterReleaseCheck<T>(
  run: <R>(task: () => Promise<R>) => Promise<R | undefined>,
  projectId: string,
  locale: string,
  task: () => Promise<T>,
  ask?: (text: string) => boolean,
): Promise<T | undefined> {
  return run(async () => {
    if (!(await confirmReleaseImpact(projectId, locale, ask)))
      throw new MutationCanceled();
    return task();
  });
}

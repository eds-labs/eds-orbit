import type { Locale } from "@/lib/i18n";
import { usd } from "@/lib/api";

// The labels of the Operations band and the worker panel, German and
// English (plan 2026-11-10, WP2 C). The band states its scope: the AI
// figures are this UTC month's, as the monthly limit counts them.

const texts = {
  en: {
    execution: "Project execution",
    readiness: "Readiness",
    spend: "AI spend this month",
    open: "AI open this month",
    since: (date: string) => `since ${date} (UTC month)`,
    split: (inFlight: string, stale: string, unclear: string) =>
      `in flight ${inFlight} · stale ${stale} · unclear ${unclear}`,
    stateUpdated: "Project state updated.",
    worker: "Worker and dispatch",
    lastObserved: "Last observed",
    heartbeat: "Worker heartbeat",
    outbox: "Pending outbox",
    queues: "Queue classes",
    workerDown:
      "The worker heartbeat is unavailable. Queued work is not evidence of execution.",
  },
  de: {
    execution: "Projektausführung",
    readiness: "Bereitschaft",
    spend: "KI-Ausgaben diesen Monat",
    open: "KI offen diesen Monat",
    since: (date: string) => `seit ${date} (UTC-Monat)`,
    split: (inFlight: string, stale: string, unclear: string) =>
      `läuft ${inFlight} · veraltet ${stale} · unklar ${unclear}`,
    stateUpdated: "Projektstatus aktualisiert.",
    worker: "Worker und Verteilung",
    lastObserved: "Zuletzt beobachtet",
    heartbeat: "Worker-Heartbeat",
    outbox: "Ausstehende Outbox",
    queues: "Warteschlangen",
    workerDown:
      "Der Worker-Heartbeat ist nicht verfügbar. Wartende Arbeit ist kein Nachweis für eine Ausführung.",
  },
};

export const operationsText = (locale: Locale) =>
  locale === "de" ? texts.de : texts.en;

/** The band's AI figures: this month's settled and open amounts, split. */
export function operationsBudget(
  budget: {
    periodStart?: string;
    reservedMicros: number;
    spentMicros: number;
    inFlightMicros?: number;
    staleMicros?: number;
    unknownMicros?: number;
  },
  locale: Locale,
) {
  const t = operationsText(locale);
  const since = budget.periodStart
    ? t.since(
        new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).format(new Date(budget.periodStart)),
      )
    : null;
  const split =
    budget.inFlightMicros === undefined
      ? null
      : t.split(
          usd(budget.inFlightMicros),
          usd(budget.staleMicros ?? 0),
          usd(budget.unknownMicros ?? 0),
        );
  return {
    spend: usd(budget.spentMicros),
    open: usd(budget.reservedMicros),
    since,
    split,
  };
}

import type { Locale } from "@/lib/i18n";
import { aiTasks, taskName } from "@/lib/ai-presets";
import { budgetRefusalText } from "@/lib/budget-refusals";

// Readable texts for the codes an open exception carries (plan 2026-11-10,
// WP2 D). An exception stores only its code (worker/main.ts); this turns it
// into what happened, why and what the owner can do, with the setting to
// open where there is one. Unknown codes stay as they are, so nothing is
// hidden. Paths are project-relative (AppLink).

export type ExceptionText = {
  title: string;
  cause: string;
  action: string;
  /** The project page that resolves it, such as the AI settings. */
  href?: string;
};

type Entry = {
  en: Omit<ExceptionText, "href">;
  de: Omit<ExceptionText, "href">;
  href?: string;
};

/** Settings → AI & budget, where routes, keys and the spending authority live. */
export const AI_SETTINGS_HREF = "/settings?section=ai";
const OPERATIONS_HREF = "/operations";
const CONNECTIONS_HREF = "/settings?section=integrations";

const entries: Record<string, Entry> = {
  AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA: {
    en: {
      title: "AI provider not allowed for customer data",
      cause:
        "Customer and financial data may only go to OpenAI (data policy). The task's route names another provider, so Orbit stopped the call before anything was sent or reserved.",
      action:
        "Set the route to a verified OpenAI model (Settings → AI & budget → Task routes). Orbit never switches the provider by itself.",
    },
    de: {
      title: "KI-Anbieter für Kundendaten nicht erlaubt",
      cause:
        "Kundendaten und Finanzdaten dürfen nur an OpenAI gehen (Datenschutzregel). Die Route der Aufgabe nennt einen anderen Anbieter, deshalb hat Orbit den Aufruf gestoppt, bevor etwas gesendet oder reserviert wurde.",
      action:
        "Route auf ein verifiziertes OpenAI-Modell stellen (Einstellungen → KI & Budget → Aufgaben-Routen). Orbit wechselt den Anbieter nie von selbst.",
    },
    href: AI_SETTINGS_HREF,
  },
  PAID_CALL_NOT_AUTHORIZED: {
    en: {
      title: "AI call without a usable key",
      cause:
        "The task is routed to a provider whose key is missing or not allowed for this project.",
      action:
        "Add the provider's key or route the task to a provider with a key (Settings → AI & budget).",
    },
    de: {
      title: "KI-Aufruf ohne nutzbaren Key",
      cause:
        "Die Aufgabe ist auf einen Anbieter geroutet, dessen Key fehlt oder für dieses Projekt nicht freigegeben ist.",
      action:
        "Key des Anbieters hinterlegen oder die Aufgabe auf einen Anbieter mit Key routen (Einstellungen → KI & Budget).",
    },
    href: AI_SETTINGS_HREF,
  },
  POSTIZ_QUEUE_STALLED: {
    en: {
      title: "Postiz is not sending scheduled posts",
      cause:
        "At least one scheduled post of an assigned channel is more than 15 minutes overdue in the Postiz queue.",
      action:
        "Check the Postiz orchestrator and restart it if it shows no startup lines. The exception closes itself once the queue moves again.",
    },
    de: {
      title: "Postiz sendet geplante Posts nicht",
      cause:
        "Mindestens ein geplanter Post eines zugewiesenen Kanals ist in der Postiz-Warteschlange mehr als 15 Minuten überfällig.",
      action:
        "Postiz-Orchestrator prüfen und neu starten, wenn er keine Startzeilen zeigt. Die Ausnahme schließt sich, sobald die Warteschlange wieder läuft.",
    },
  },
  POSTIZ_QUEUE_CHECK_FAILED: {
    en: {
      title: "Orbit cannot read the Postiz queue",
      cause: "The scheduled check of the Postiz queue failed.",
      action:
        "Check that Postiz is reachable and the connection's token is valid. The exception closes itself after the next successful check.",
    },
    de: {
      title: "Orbit kann die Postiz-Warteschlange nicht lesen",
      cause: "Die geplante Prüfung der Postiz-Warteschlange ist fehlgeschlagen.",
      action:
        "Prüfen, ob Postiz erreichbar und das Token der Verbindung gültig ist. Die Ausnahme schließt sich nach der nächsten erfolgreichen Prüfung.",
    },
    href: CONNECTIONS_HREF,
  },
  PUBLISH_PREFLIGHT_BLOCKED: {
    en: {
      title: "Publishing stopped before sending",
      cause:
        "The check before publishing found a missing requirement (channel, connection, approval or policy).",
      action:
        "Open the approvals, fix what the post names and release it again.",
    },
    de: {
      title: "Veröffentlichung vor dem Senden gestoppt",
      cause:
        "Die Prüfung vor dem Veröffentlichen hat eine fehlende Voraussetzung gefunden (Kanal, Verbindung, Freigabe oder Richtlinie).",
      action:
        "Freigaben öffnen, das Genannte beheben und den Post erneut freigeben.",
    },
  },
  CONTENT_REVIEW_REQUIRED: {
    en: {
      title: "Content needs a review",
      cause: "A generated draft did not pass the automatic checks.",
      action: "Review the draft in the approvals and release or reject it.",
    },
    de: {
      title: "Inhalt braucht eine Prüfung",
      cause: "Ein erzeugter Entwurf hat die automatischen Prüfungen nicht bestanden.",
      action: "Entwurf in den Freigaben prüfen und freigeben oder ablehnen.",
    },
  },
  INSUFFICIENT_EVIDENCE: {
    en: {
      title: "Not enough verified facts",
      cause: "The mission has too few verified facts for a grounded draft.",
      action: "Verify facts in Knowledge, then start the mission again.",
    },
    de: {
      title: "Zu wenig geprüfte Fakten",
      cause: "Die Mission hat zu wenige geprüfte Fakten für einen belegten Entwurf.",
      action: "Fakten im Wissen prüfen und die Mission dann erneut starten.",
    },
  },
  REMOTE_CANCELLATION_REQUIRED: {
    en: {
      title: "Cancel the post at the platform",
      cause:
        "The post was withdrawn in Orbit, but the platform may still hold it.",
      action: "Cancel or delete the post at the platform itself.",
    },
    de: {
      title: "Post bei der Plattform abbrechen",
      cause:
        "Der Post wurde in Orbit zurückgezogen, die Plattform hält ihn aber möglicherweise noch.",
      action: "Post direkt bei der Plattform abbrechen oder löschen.",
    },
  },
  RECONCILIATION_POLL_LIMIT: {
    en: {
      title: "Publishing state could not be confirmed",
      cause:
        "Orbit asked the platform for the post's state as often as allowed without an answer.",
      action:
        "Check the post at the platform and resolve the exception once it is clear.",
    },
    de: {
      title: "Veröffentlichungsstatus nicht bestätigt",
      cause:
        "Orbit hat die Plattform so oft wie erlaubt nach dem Status des Posts gefragt, ohne Antwort.",
      action:
        "Post bei der Plattform prüfen und die Ausnahme auflösen, sobald es klar ist.",
    },
  },
  SOCIAL_DELIVERY_BLOCKED: {
    en: {
      title: "Social delivery blocked",
      cause: "The Social account cannot take the post (disconnected, not verified or refused).",
      action: "Check the account under Social → Accounts, then release the post again.",
    },
    de: {
      title: "Social-Zustellung blockiert",
      cause: "Das Social-Konto kann den Post nicht annehmen (getrennt, nicht verifiziert oder abgelehnt).",
      action: "Konto unter Social → Konten prüfen und den Post erneut freigeben.",
    },
  },
  SOCIAL_HOLD_FAILED: {
    en: {
      title: "Social post could not be held",
      cause: "Orbit could not hold the Social post while publishing was stopped.",
      action: "Check the post in the Social calendar.",
    },
    de: {
      title: "Social-Post konnte nicht angehalten werden",
      cause: "Orbit konnte den Social-Post nicht anhalten, während die Veröffentlichung gestoppt war.",
      action: "Post im Social-Kalender prüfen.",
    },
  },
  TELEGRAM_DELIVERY_FAILED: {
    en: {
      title: "Telegram message not delivered",
      cause: "The Telegram bot could not deliver a message.",
      action: "Check the Telegram connection in the settings.",
    },
    de: {
      title: "Telegram-Nachricht nicht zugestellt",
      cause: "Der Telegram-Bot konnte eine Nachricht nicht zustellen.",
      action: "Telegram-Verbindung in den Einstellungen prüfen.",
    },
    href: CONNECTIONS_HREF,
  },
  MATOMO_SCHEDULED_IMPORT_FAILED: {
    en: {
      title: "Matomo import failed",
      cause: "The scheduled import of Matomo statistics failed.",
      action: "Check the Matomo connection; the next import runs on schedule.",
    },
    de: {
      title: "Matomo-Import fehlgeschlagen",
      cause: "Der geplante Import der Matomo-Statistiken ist fehlgeschlagen.",
      action: "Matomo-Verbindung prüfen; der nächste Import läuft planmäßig.",
    },
    href: CONNECTIONS_HREF,
  },
  ASSIGNMENT_BUDGET_EXHAUSTED: {
    en: {
      title: "Assignment out of budget",
      cause: "The assignment used up its monthly budget.",
      action: "Raise the assignment's budget or wait for the next month.",
    },
    de: {
      title: "Auftrag ohne Budget",
      cause: "Der Auftrag hat sein Monatsbudget aufgebraucht.",
      action: "Budget des Auftrags erhöhen oder den nächsten Monat abwarten.",
    },
  },
  AGENT_PRINCIPAL_FORBIDDEN: {
    en: {
      title: "Agent without the needed rights",
      cause: "The member the agent works for lost a role it needs.",
      action: "Check the member's project and module roles.",
    },
    de: {
      title: "Agent ohne nötige Rechte",
      cause: "Das Mitglied, für das der Agent arbeitet, hat eine nötige Rolle verloren.",
      action: "Projekt- und Modulrollen des Mitglieds prüfen.",
    },
  },
  PROJECT_PAUSED: {
    en: {
      title: "Project paused",
      cause: "The work stopped because the project is paused.",
      action: "Resume the project under Operations if it should continue.",
    },
    de: {
      title: "Projekt pausiert",
      cause: "Die Arbeit wurde gestoppt, weil das Projekt pausiert ist.",
      action: "Projekt unter Betrieb fortsetzen, wenn es weiterlaufen soll.",
    },
    href: OPERATIONS_HREF,
  },
};

/** Outcomes Orbit cannot confirm: never repeated automatically. */
const outcomeUnknown: Entry = {
  en: {
    title: "Outcome unclear",
    cause:
      "A step that writes to an external service may or may not have finished; Orbit does not repeat it on its own.",
    action:
      "Check the result at the service, then resolve the exception or repeat the step yourself.",
  },
  de: {
    title: "Ergebnis unklar",
    cause:
      "Ein Schritt, der an einen externen Dienst schreibt, wurde vielleicht abgeschlossen, vielleicht nicht; Orbit wiederholt ihn nicht von selbst.",
    action:
      "Ergebnis beim Dienst prüfen und die Ausnahme dann auflösen oder den Schritt selbst wiederholen.",
  },
};

/**
 * What an exception code means, why it happened and what to do. Budget
 * refusals reuse their own texts; an unknown code is returned as the title.
 */
export function exceptionText(locale: Locale, code: string | null | undefined): ExceptionText {
  const key = String(code ?? "").trim().replaceAll(" ", "_");
  const lang = locale === "de" ? "de" : "en";
  const entry =
    entries[key] ?? (key.endsWith("_OUTCOME_UNKNOWN") ? outcomeUnknown : undefined);
  if (entry) return { ...entry[lang], ...(entry.href ? { href: entry.href } : {}) };
  const budget = budgetRefusalText(key, lang === "de");
  if (budget)
    return {
      title: lang === "de" ? "KI-Aufruf vom Budget gestoppt" : "AI call stopped by the budget",
      cause: budget,
      action:
        lang === "de"
          ? "Ausgabefreigabe und Budgets prüfen (Einstellungen → KI & Budget)."
          : "Check the spending authority and budgets (Settings → AI & budget).",
      href: AI_SETTINGS_HREF,
    };
  return { title: key || "—", cause: "", action: "" };
}

/**
 * Whether the code has its own text. The generic "outcome unclear" text of
 * other *_OUTCOME_UNKNOWN codes does not count: there the code itself names
 * the service, so a list keeps showing it.
 */
export function hasExceptionText(code: string | null | undefined) {
  const key = String(code ?? "").trim().replaceAll(" ", "_");
  return key in entries || budgetRefusalText(key, false) !== null;
}

/** One task route its data class does not allow, as the AI settings get it. */
export type DataClassRoute = {
  task: string;
  dataClass: "customer_personal" | "financial";
  provider: string;
  allowed: string[];
  /** The pipeline refuses the call (Support); false: not checked yet (finance). */
  enforced: boolean;
};

const providerLabel = (id: string) =>
  id === "anthropic" ? "Claude" : id === "openai" ? "OpenAI" : id;

const taskLabel = (id: string, locale: Locale) => {
  const task = aiTasks.find((t) => t.id === id);
  return task ? taskName(task, locale) : id;
};

/**
 * The warning of the AI settings for routes their data class does not
 * allow: which tasks, what happens and the setting to change. Null when
 * every route is allowed.
 */
export function dataClassRouteWarning(locale: Locale, routes: readonly DataClassRoute[]) {
  if (!routes.length) return null;
  const de = locale === "de";
  const list = (rows: readonly DataClassRoute[]) =>
    rows.map((r) => `${taskLabel(r.task, locale)} (${providerLabel(r.provider)})`).join(", ");
  const enforced = routes.filter((r) => r.enforced);
  const unchecked = routes.filter((r) => !r.enforced);
  const parts: string[] = [];
  if (enforced.length)
    parts.push(
      de
        ? `Kundendaten dürfen nur an OpenAI gehen. Diese Aufgaben sind auf einen anderen Anbieter geroutet und werden blockiert, bevor etwas gesendet wird (AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA): ${list(enforced)}.`
        : `Customer data may only go to OpenAI. These tasks are routed to another provider and are stopped before anything is sent (AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA): ${list(enforced)}.`,
    );
  if (unchecked.length)
    parts.push(
      de
        ? `Finanzdaten sollen nach der Datenschutzregel nur an OpenAI gehen; Orbit blockiert diese Route noch nicht: ${list(unchecked)}.`
        : `Financial data should only go to OpenAI under the data policy; Orbit does not stop this route yet: ${list(unchecked)}.`,
    );
  parts.push(
    de
      ? "Stelle die Route unter „Aufgaben-Routen“ auf ein verifiziertes OpenAI-Modell. Orbit wechselt den Anbieter nicht automatisch."
      : "Set the route to a verified OpenAI model under “Task routes”. Orbit does not switch the provider automatically.",
  );
  return parts.join(" ");
}

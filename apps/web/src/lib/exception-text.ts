import type { Locale } from "@/lib/i18n";
import { aiTasks, taskName } from "@/lib/ai-presets";
import { budgetRefusalText } from "@/lib/budget-refusals";

// Readable texts for the codes an open exception carries (plan 2026-11-10,
// WP2 D). An exception stores only its code (worker/main.ts); this turns it
// into what happened, why and what the owner can do, with the setting to
// open where there is one. Unknown codes stay as they are, so nothing is
// hidden. A place is a section of the open project's settings center; the
// page that shows the text builds the address (ShellContextValue.projectCenterHref).

export type ExceptionText = {
  title: string;
  cause: string;
  action: string;
  /** The project page that resolves it, such as the operations page (project-relative, AppLink). */
  href?: string;
  /** The project settings section that resolves it, such as the AI settings. */
  place?: ExceptionPlace;
};

/** A section of the project's settings center, below /manage/p/<id>. */
export type ExceptionPlace = {
  area: string;
  rest?: readonly string[];
  /** "#…" of an anchor in the section. */
  hash?: string;
};

type Entry = {
  en: Omit<ExceptionText, "href" | "place">;
  de: Omit<ExceptionText, "href" | "place">;
  href?: string;
  place?: ExceptionPlace;
};

/** The AI area of the project settings: routes, keys and the spending authority. */
export const AI_SETTINGS_PLACE: ExceptionPlace = { area: "ai" };
const OPERATIONS_HREF = "/operations";
const CONNECTIONS_PLACE: ExceptionPlace = { area: "integrations" };
/** Modules → Marketing → Publishing rules, at the owner's "Autopilot through Social" switch. */
export const SOCIAL_AUTOPILOT_PLACE: ExceptionPlace = {
  area: "modules",
  rest: ["marketing", "policy"],
  hash: "#social-autopilot",
};

const entries: Record<string, Entry> = {
  AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA: {
    en: {
      title: "AI provider not allowed for customer data",
      cause:
        "Customer and financial data may only go to OpenAI (data policy). The task's route names another provider, so Orbit stopped the call before anything was sent or reserved.",
      action:
        "Set the route to a verified OpenAI model. Orbit never switches the provider by itself.",
    },
    de: {
      title: "KI-Anbieter für Kundendaten nicht erlaubt",
      cause:
        "Kundendaten und Finanzdaten dürfen nur an OpenAI gehen (Datenschutzregel). Die Route der Aufgabe nennt einen anderen Anbieter, deshalb hat Orbit den Aufruf gestoppt, bevor etwas gesendet oder reserviert wurde.",
      action:
        "Route auf ein verifiziertes OpenAI-Modell stellen. Orbit wechselt den Anbieter nie von selbst.",
    },
    place: AI_SETTINGS_PLACE,
  },
  PAID_CALL_NOT_AUTHORIZED: {
    en: {
      title: "AI call without a usable key",
      cause:
        "The task is routed to a provider whose key is missing or not allowed for this project.",
      action:
        "Add the provider's key or route the task to a provider with a key.",
    },
    de: {
      title: "KI-Aufruf ohne nutzbaren Key",
      cause:
        "Die Aufgabe ist auf einen Anbieter geroutet, dessen Key fehlt oder für dieses Projekt nicht freigegeben ist.",
      action:
        "Key des Anbieters hinterlegen oder die Aufgabe auf einen Anbieter mit Key routen.",
    },
    place: AI_SETTINGS_PLACE,
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
    place: CONNECTIONS_PLACE,
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
  AUTOPILOT_ON_SOCIAL_NOT_APPROVED: {
    en: {
      title: "Autopilot post waits for your release",
      cause:
        "Autopilot wrote and reviewed a post, but this project publishes through Social and the owner's switch “Autopilot through Social” is off, so Orbit did not schedule it.",
      action:
        "Release the post yourself in the approvals, or turn on “Autopilot through Social”.",
    },
    de: {
      title: "Autopilot-Post wartet auf deine Freigabe",
      cause:
        "Der Autopilot hat einen Post geschrieben und geprüft, aber dieses Projekt veröffentlicht über Social und der Schalter „Autopilot über Social“ des Owners ist aus. Deshalb hat Orbit ihn nicht eingeplant.",
      action:
        "Post selbst in den Freigaben freigeben oder „Autopilot über Social“ einschalten.",
    },
    place: SOCIAL_AUTOPILOT_PLACE,
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
    place: CONNECTIONS_PLACE,
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
    place: CONNECTIONS_PLACE,
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
  CREATIVE_AUTHORITY_OFF: {
    en: {
      title: "Creative post waits for your release",
      cause:
        "The review agent approved the post, but its approval does not cover a post with a Creative Studio image while the creative switch is off.",
      action:
        "Release the post yourself, or turn on ORBIT_AGENT_REVIEW_CREATIVES (the switch is off) so a passed vision review can stand in for you.",
    },
    de: {
      title: "Creative-Post wartet auf deine Freigabe",
      cause:
        "Der Prüf-Agent hat den Post freigegeben, aber seine Freigabe gilt für einen Post mit Creative-Studio-Bild nicht, solange der Creative-Schalter aus ist.",
      action:
        "Den Post selbst freigeben, oder den Schalter ORBIT_AGENT_REVIEW_CREATIVES einschalten (er ist aus), damit eine bestandene Bildprüfung deine Freigabe ersetzen kann.",
    },
  },
  CREATIVE_NOT_FOUND: {
    en: {
      title: "Creative of the post not found",
      cause:
        "The post names a creative that does not exist in this project, so the agent's approval cannot cover its image.",
      action:
        "Check the post's image and release it yourself, or compose the creative again.",
    },
    de: {
      title: "Creative des Posts nicht gefunden",
      cause:
        "Der Post nennt ein Creative, das es in diesem Projekt nicht gibt; die Freigabe des Agenten kann sein Bild deshalb nicht abdecken.",
      action:
        "Bild des Posts prüfen und selbst freigeben, oder das Creative neu erstellen.",
    },
  },
  CREATIVE_NOT_USABLE: {
    en: {
      title: "Creative cannot be used",
      cause:
        "The creative was replaced or is waiting for usage rights, so the agent's approval cannot cover it.",
      action:
        "Resolve the rights or compose a new creative, or release the post yourself.",
    },
    de: {
      title: "Creative nicht nutzbar",
      cause:
        "Das Creative wurde ersetzt oder wartet auf Nutzungsrechte; die Freigabe des Agenten kann es deshalb nicht abdecken.",
      action:
        "Rechte klären oder ein neues Creative erstellen, oder den Post selbst freigeben.",
    },
  },
  CREATIVE_RENDITION_NOT_ON_POST: {
    en: {
      title: "Post image is not a creative rendition",
      cause:
        "The image on the post is not one of the creative's renditions (for example the raw art), so the agent's approval cannot cover it.",
      action:
        "Attach the creative's rendition to the post, or release the post yourself.",
    },
    de: {
      title: "Post-Bild ist keine Creative-Variante",
      cause:
        "Das Bild am Post ist keine Variante des Creatives (zum Beispiel das rohe Bild); die Freigabe des Agenten kann es deshalb nicht abdecken.",
      action:
        "Die Variante des Creatives am Post anhängen, oder den Post selbst freigeben.",
    },
  },
  CREATIVE_VISION_REVIEW_REQUIRED: {
    en: {
      title: "No vision review for this creative",
      cause:
        "No vision review judged the creative, so the agent's approval cannot stand in for yours.",
      action:
        "Turn on the vision review in the brand kit and let the post run again, or release the post yourself.",
    },
    de: {
      title: "Bildprüfung für dieses Creative nicht erfolgt",
      cause:
        "Keine Bildprüfung hat das Creative beurteilt; die Freigabe des Agenten kann deine deshalb nicht ersetzen.",
      action:
        "Bildprüfung im Brand Kit einschalten und den Post erneut laufen lassen, oder den Post selbst freigeben.",
    },
  },
  CREATIVE_VISION_NOT_PASSED: {
    en: {
      title: "Vision review did not pass",
      cause:
        "The vision review found the creative below the pass mark, so the agent's approval cannot stand in for yours.",
      action:
        "Check the creative and release the post yourself, or correct the creative and review it again.",
    },
    de: {
      title: "Bildprüfung nicht bestanden",
      cause:
        "Die Bildprüfung hat das Creative unter der Bestehensgrenze bewertet; die Freigabe des Agenten kann deine deshalb nicht ersetzen.",
      action:
        "Creative ansehen und den Post selbst freigeben, oder das Creative korrigieren und erneut prüfen lassen.",
    },
  },
  CREATIVE_RENDITION_NOT_REVIEWED: {
    en: {
      title: "Post image changed after the vision review",
      cause:
        "The image on the post is not the exact one the vision review judged (the creative was composed again).",
      action:
        "Run the vision review again for the new image, or release the post yourself.",
    },
    de: {
      title: "Post-Bild nach der Bildprüfung geändert",
      cause:
        "Das Bild am Post ist nicht genau das, das die Bildprüfung beurteilt hat (das Creative wurde neu erstellt).",
      action:
        "Bildprüfung für das neue Bild erneut laufen lassen, oder den Post selbst freigeben.",
    },
  },
  CREATIVE_QA_NEEDS_OWNER: {
    en: {
      title: "Creative check left a finding for you",
      cause:
        "The automatic creative check found something only you can decide, so the agent's approval cannot stand in for yours.",
      action:
        "Open the creative, resolve the finding and release the post.",
    },
    de: {
      title: "Creative-Prüfung hat einen Befund für dich",
      cause:
        "Die automatische Creative-Prüfung hat etwas gefunden, das nur du entscheiden kannst; die Freigabe des Agenten kann deine deshalb nicht ersetzen.",
      action:
        "Creative öffnen, den Befund klären und den Post freigeben.",
    },
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
  if (entry)
    return {
      ...entry[lang],
      ...(entry.href ? { href: entry.href } : {}),
      ...(entry.place ? { place: entry.place } : {}),
    };
  const budget = budgetRefusalText(key, lang === "de");
  if (budget)
    return {
      title: lang === "de" ? "KI-Aufruf vom Budget gestoppt" : "AI call stopped by the budget",
      cause: budget,
      action:
        lang === "de"
          ? "Ausgabefreigabe und Budgets prüfen."
          : "Check the spending authority and budgets.",
      place: AI_SETTINGS_PLACE,
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

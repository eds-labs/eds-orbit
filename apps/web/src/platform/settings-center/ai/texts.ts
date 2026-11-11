import type { Locale } from "@/lib/i18n";

// The wording of the AI area of the settings center. German must name every
// English key (the type checks it); a missing or empty entry at runtime falls
// back to English.

const en = {
  originEnvironment: "Environment",
  originSystem: "System",
  originOrganization: "Organization",
  originPreset: "Own level",
  originProject: "This project",
  originNone: "Not set",
  exception: "Exception",
  modeUnsaved:
    "No own AI settings: the project uses what the organization, the system and the environment set.",
  modeCustom: "Own settings: the project's own tiers and task routes apply.",
  modePreset: "Own level: a preset chosen for this project.",
  modeOrganization: "Follows the organization's standard.",
  standardFromSystem:
    "The organization has set no standard, so Orbit's standard applies.",
  routingOff:
    "Standard models and presets are not switched on for this installation, so the project's own settings apply until they are.",
  exceptionsNone: "No exceptions: every value is inherited.",
  exceptionsList: "Set by this project:",
  partModels: "models",
  partRoutes: "routes",
  partPrices: "prices",
  partBudgets: "provider budgets",
  partKeys: "own keys",
  readinessTitle: "Readiness per provider",
  readyStored: "Key available",
  readyVerified: "Key checked",
  readyReady: "Ready for text",
  markYes: "yes",
  markNo: "no",
  reasonNoKey: "No key for this provider.",
  reasonProjectKey:
    "The project's own key cannot be checked; only central connections are checked.",
  reasonEnvironmentKey:
    "The environment's key cannot be checked; only central connections are checked.",
  reasonNotChecked: "The connection has not been checked yet.",
  reasonFailed: "The connection's last check failed; it is still used.",
  reasonDisabled: "The connection is disabled.",
  reasonNoTextRoute: "No text task uses this provider.",
  reasonTextNotReady: "Text tasks need a verified model with a current price.",
  valuesTitle: "Values and where they come from",
  defaultProvider: "Default provider",
  tierOpenAi: "OpenAI tier",
  tierClaude: "Claude tier",
  otherTasksTier: "Other tasks use the default provider's tier.",
  fallback: "When the Claude budget is stopped",
  fallbackNone: "Refuse the call",
  fallbackOpenAi: "Fall back to OpenAI",
  imageModel: "Image model",
  keyOpenAi: "OpenAI key",
  keyImage: "Image key",
  keyClaude: "Claude key",
  budgetOf: "Budget",
  perMonth: "per month",
  perDay: "per day",
  notSet: "not set",
  changeModels: "Change models",
  changeKeys: "Keys and providers",
  changeBudgets: "Budgets",
  modelsAdvanced: "Models, prices and task routes",
  defaultsOff:
    "Standard models and presets are not switched on for this installation; the project's own models apply.",
  ceilingsTitle: "AI ceilings of the modules",
  ceilingsIntro:
    "Modules limit their own AI use on top of the spending authority. They are changed in each module's settings.",
  ceilingsNone: "No module of this project sets an AI ceiling.",
  ceilingOff: "switched off",
  openSetting: "Open setting",
};

export type AiTextKey = keyof typeof en;

const de: Record<AiTextKey, string> = {
  originEnvironment: "Umgebung",
  originSystem: "System",
  originOrganization: "Organisation",
  originPreset: "Eigene Stufe",
  originProject: "Dieses Projekt",
  originNone: "Nicht festgelegt",
  exception: "Ausnahme",
  modeUnsaved:
    "Keine eigenen KI-Einstellungen: Das Projekt nutzt, was Organisation, System und Umgebung festlegen.",
  modeCustom:
    "Eigene Einstellungen: Es gelten die eigenen Stufen und Aufgaben-Routen des Projekts.",
  modePreset: "Eigene Stufe: eine für dieses Projekt gewählte Voreinstellung.",
  modeOrganization: "Folgt dem Standard der Organisation.",
  standardFromSystem:
    "Die Organisation hat keinen Standard festgelegt, daher gilt der Orbit-Standard.",
  routingOff:
    "Standard-Modelle und Stufen sind für diese Installation nicht eingeschaltet, daher gelten bis dahin die eigenen Einstellungen des Projekts.",
  exceptionsNone: "Keine Ausnahmen: Jeder Wert ist übernommen.",
  exceptionsList: "Von diesem Projekt festgelegt:",
  partModels: "Modelle",
  partRoutes: "Routen",
  partPrices: "Preise",
  partBudgets: "Anbieter-Budgets",
  partKeys: "eigene Schlüssel",
  readinessTitle: "Bereitschaft je Anbieter",
  readyStored: "Schlüssel vorhanden",
  readyVerified: "Schlüssel geprüft",
  readyReady: "Bereit für Text",
  markYes: "ja",
  markNo: "nein",
  reasonNoKey: "Kein Schlüssel für diesen Anbieter.",
  reasonProjectKey:
    "Der eigene Schlüssel des Projekts kann nicht geprüft werden; geprüft werden nur zentrale Verbindungen.",
  reasonEnvironmentKey:
    "Der Schlüssel aus der Umgebung kann nicht geprüft werden; geprüft werden nur zentrale Verbindungen.",
  reasonNotChecked: "Die Verbindung wurde noch nicht geprüft.",
  reasonFailed:
    "Die letzte Prüfung der Verbindung ist fehlgeschlagen; sie wird trotzdem genutzt.",
  reasonDisabled: "Die Verbindung ist deaktiviert.",
  reasonNoTextRoute: "Keine Textaufgabe nutzt diesen Anbieter.",
  reasonTextNotReady:
    "Textaufgaben brauchen ein geprüftes Modell mit aktuellem Preis.",
  valuesTitle: "Werte und ihre Herkunft",
  defaultProvider: "Standardanbieter",
  tierOpenAi: "OpenAI-Stufe",
  tierClaude: "Claude-Stufe",
  otherTasksTier: "Andere Aufgaben nutzen die Stufe des Standardanbieters.",
  fallback: "Wenn das Claude-Budget gestoppt ist",
  fallbackNone: "Aufruf ablehnen",
  fallbackOpenAi: "Auf OpenAI ausweichen",
  imageModel: "Bildmodell",
  keyOpenAi: "OpenAI-Schlüssel",
  keyImage: "Bild-Schlüssel",
  keyClaude: "Claude-Schlüssel",
  budgetOf: "Budget",
  perMonth: "pro Monat",
  perDay: "pro Tag",
  notSet: "nicht festgelegt",
  changeModels: "Modelle ändern",
  changeKeys: "Schlüssel und Anbieter",
  changeBudgets: "Budgets",
  modelsAdvanced: "Modelle, Preise und Aufgaben-Routen",
  defaultsOff:
    "Standard-Modelle und Stufen sind für diese Installation nicht eingeschaltet; es gelten die eigenen Modelle des Projekts.",
  ceilingsTitle: "KI-Obergrenzen der Module",
  ceilingsIntro:
    "Module begrenzen ihre KI-Nutzung zusätzlich zur Ausgabenfreigabe. Geändert werden sie in den Einstellungen des jeweiligen Moduls.",
  ceilingsNone: "Kein Modul dieses Projekts legt eine KI-Obergrenze fest.",
  ceilingOff: "ausgeschaltet",
  openSetting: "Einstellung öffnen",
};

export const AI_TEXTS: Record<Locale, Partial<Record<AiTextKey, string>>> = {
  en,
  de,
};

/** The text of a key in the locale, else English, else the key itself. */
export function aiText(locale: Locale) {
  return (key: AiTextKey): string => AI_TEXTS[locale]?.[key] || en[key] || key;
}

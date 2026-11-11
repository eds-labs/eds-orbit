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
  standardNone:
    "Neither the organization nor Orbit has set a standard yet; the table below shows what applies until then.",
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
  affectedOrgProfile:
    "Applies to projects that follow the standard ({following}) and to projects without own AI settings ({unsaved}); projects with their own choice ({own}) keep the values they set. Saving changes the route version of every project of this organization ({total}): running AI work there stops before its next paid call.",
  affectedOrgRouteOnly:
    "Saving changes the route version of every project of this organization ({total}): running AI work there stops before its next paid call.",
  affectedOrgCatalog:
    "Prices and switches here apply to every project of this organization ({total}) that sets no price of its own.",
  affectedSystemProfile:
    "Applies to every project whose organization and own settings leave a value open. Saving changes the route version of every project ({total}) and of every personal space: running AI work stops before its next paid call.",
  affectedSystemRouteOnly:
    "Saving changes the route version of every project ({total}) and of every personal space: running AI work stops before its next paid call.",
  affectedSystemCatalog:
    "Prices and switches here apply to every organization and project that sets no price of its own (projects: {total}).",
  catalogOff:
    "The central price catalog is not switched on for this installation; projects use their own and the profiles' prices. Saved changes apply once it is.",
  projectsIntro:
    "Which projects follow the organization's AI settings and which set their own.",
  projectsEmpty: "This organization has no projects yet.",
  projectsUnreadable:
    "Projects that could not be read and are missing from this list: {count}.",
  colProject: "Project",
  colChoice: "Model choice",
  colKeys: "Own keys",
  colOverrides: "Set by the project",
  colAuthority: "Spending authority",
  choiceUnsaved: "No own settings",
  choiceCustom: "Own settings",
  choicePreset: "Own level",
  choiceOrganization: "Organization standard",
  none: "none",
  authorityNone: "not set",
  authorityActive: "active",
  authorityExpired: "expired",
  authorityOff: "off",
  authorityInvalid: "invalid",
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
  standardNone:
    "Weder die Organisation noch Orbit hat bisher einen Standard festgelegt; die Tabelle unten zeigt, was bis dahin gilt.",
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
  affectedOrgProfile:
    "Gilt für Projekte, die dem Standard folgen ({following}), und für Projekte ohne eigene KI-Einstellungen ({unsaved}); Projekte mit eigener Wahl ({own}) behalten ihre gesetzten Werte. Speichern ändert die Routen-Version jedes Projekts dieser Organisation ({total}): Laufende KI-Arbeit dort stoppt vor ihrem nächsten bezahlten Aufruf.",
  affectedOrgRouteOnly:
    "Speichern ändert die Routen-Version jedes Projekts dieser Organisation ({total}): Laufende KI-Arbeit dort stoppt vor ihrem nächsten bezahlten Aufruf.",
  affectedOrgCatalog:
    "Preise und Schalter hier gelten für jedes Projekt dieser Organisation ({total}), das keinen eigenen Preis festlegt.",
  affectedSystemProfile:
    "Gilt für jedes Projekt, dessen Organisation und eigene Einstellungen einen Wert offen lassen. Speichern ändert die Routen-Version jedes Projekts ({total}) und jedes persönlichen Bereichs: Laufende KI-Arbeit stoppt vor ihrem nächsten bezahlten Aufruf.",
  affectedSystemRouteOnly:
    "Speichern ändert die Routen-Version jedes Projekts ({total}) und jedes persönlichen Bereichs: Laufende KI-Arbeit stoppt vor ihrem nächsten bezahlten Aufruf.",
  affectedSystemCatalog:
    "Preise und Schalter hier gelten für jede Organisation und jedes Projekt ohne eigenen Preis (Projekte: {total}).",
  catalogOff:
    "Der zentrale Preiskatalog ist für diese Installation nicht eingeschaltet; Projekte nutzen ihre eigenen Preise und die der Profile. Gespeicherte Änderungen gelten, sobald er eingeschaltet ist.",
  projectsIntro:
    "Welche Projekte den KI-Einstellungen der Organisation folgen und welche eigene festlegen.",
  projectsEmpty: "Diese Organisation hat noch keine Projekte.",
  projectsUnreadable:
    "Projekte, die nicht gelesen werden konnten und in dieser Liste fehlen: {count}.",
  colProject: "Projekt",
  colChoice: "Modellwahl",
  colKeys: "Eigene Schlüssel",
  colOverrides: "Vom Projekt festgelegt",
  colAuthority: "Ausgabenfreigabe",
  choiceUnsaved: "Keine eigenen Einstellungen",
  choiceCustom: "Eigene Einstellungen",
  choicePreset: "Eigene Stufe",
  choiceOrganization: "Organisationsstandard",
  none: "keine",
  authorityNone: "nicht festgelegt",
  authorityActive: "aktiv",
  authorityExpired: "abgelaufen",
  authorityOff: "aus",
  authorityInvalid: "ungültig",
};

export const AI_TEXTS: Record<Locale, Partial<Record<AiTextKey, string>>> = {
  en,
  de,
};

/** The text of a key in the locale, else English, else the key itself. */
export function aiText(locale: Locale) {
  return (key: AiTextKey): string => AI_TEXTS[locale]?.[key] || en[key] || key;
}

/** The text of a key with every `{name}` it has a value for filled in. */
export function affectedText(
  key: AiTextKey,
  values: Record<string, number | string>,
  locale: Locale,
): string {
  return aiText(locale)(key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/**
 * Labels and descriptions of the AI sections the organization and the system
 * scope share.
 */
export const AI_SECTION_TEXT = {
  standard: {
    label: { en: "Standard models", de: "Standard-Modelle" },
    description: {
      en: "One provider and level for every project that follows the standard.",
      de: "Ein Anbieter und eine Stufe für jedes Projekt, das dem Standard folgt.",
    },
  },
  models: {
    label: { en: "Models and prices", de: "Modelle und Preise" },
    description: {
      en: "Which catalog models are on and what they cost.",
      de: "Welche Katalogmodelle an sind und was sie kosten.",
    },
  },
  advanced: {
    label: { en: "AI profile", de: "KI-Profil" },
    description: {
      en: "The raw profile: verified models, routes, prices and provider budgets.",
      de: "Das Rohprofil: geprüfte Modelle, Routen, Preise und Anbieter-Budgets.",
    },
  },
} as const;

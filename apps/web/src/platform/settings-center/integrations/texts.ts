import type { Locale } from "@/lib/i18n";
import type { Label } from "@/platform/shell/types";
import type {
  IntegrationAuthType,
  IntegrationCategory,
  IntegrationState,
  IntegrationStorage,
} from "./types";

// The wording of the integrations center. German must name every English key
// (the type checks it); a missing or empty entry at runtime falls back to
// English.

const en = {
  lastCheck: "Last check",
  neverChecked: "Never checked",
  manage: "Manage",
  setUp: "Set up",
  managedInModule: "Managed in its module.",
  switchedOff: "Switched off in this installation.",
  notAvailableYet: "Not available yet",
  notAvailableBody: "Planned; there is nothing to set up yet.",
  usedBy: "Used by",
  bound: "bound",
  grantedNotBound: "granted, not bound",
  projectsTitle: "Integrations of the projects",
  environmentTitle: "Server environment",
  environmentBody: "Set on the server; shown as state only.",
  configured: "Configured",
  missing: "Missing",
  reachable: "Reachable",
  unreachable: "Not reachable",
  envRedis: "Redis",
  envFiles: "Files storage",
  envDriveApp: "Google Drive app",
  envAiKeys: "AI fallback keys",
  envKeyRing: "Key ring",
  envMcp: "MCP switches",
  envCutover: "Connection cutover",
  none: "None",
  setupTitle: "Guided setup",
  stepChoose: "Choose provider",
  stepConfigure: "Configure connection or developer app",
  stepCheck: "Check",
  stepAuthorize: "Authorize organization and projects",
  stepAssign: "Assign account or channel",
  stepValidate: "Validate",
  whoAdmin: "System administrator",
  whoOwner: "Organization owner",
  whoProjectOwner: "Project owner",
  whoAnyone: "Anyone who may set it up",
  stepDone: "Done",
  stepYours: "Your step",
  stepOthers: "Done by:",
  openStep: "Open",
  refreshState: "Refresh state",
  chooseProviderHint: "Choose what to set up.",
};

export type IntegrationTextKey = keyof typeof en;

const de: Record<IntegrationTextKey, string> = {
  lastCheck: "Letzte Prüfung",
  neverChecked: "Nie geprüft",
  manage: "Verwalten",
  setUp: "Einrichten",
  managedInModule: "Wird im Modul verwaltet.",
  switchedOff: "In dieser Installation abgeschaltet.",
  notAvailableYet: "Noch nicht verfügbar",
  notAvailableBody: "Geplant; es gibt noch nichts einzurichten.",
  usedBy: "Genutzt von",
  bound: "eingebunden",
  grantedNotBound: "freigegeben, nicht eingebunden",
  projectsTitle: "Integrationen der Projekte",
  environmentTitle: "Serverumgebung",
  environmentBody: "Auf dem Server gesetzt; nur als Zustand angezeigt.",
  configured: "Eingerichtet",
  missing: "Fehlt",
  reachable: "Erreichbar",
  unreachable: "Nicht erreichbar",
  envRedis: "Redis",
  envFiles: "Dateispeicher",
  envDriveApp: "Google-Drive-App",
  envAiKeys: "KI-Ersatzschlüssel",
  envKeyRing: "Schlüsselbund",
  envMcp: "MCP-Schalter",
  envCutover: "Verbindungsumstellung",
  none: "Keine",
  setupTitle: "Geführte Einrichtung",
  stepChoose: "Anbieter wählen",
  stepConfigure: "Verbindung oder Entwickler-App einrichten",
  stepCheck: "Prüfen",
  stepAuthorize: "Organisation und Projekte freigeben",
  stepAssign: "Konto oder Kanal zuordnen",
  stepValidate: "Abschließend prüfen",
  whoAdmin: "Systemadministration",
  whoOwner: "Inhaber der Organisation",
  whoProjectOwner: "Projektinhaber",
  whoAnyone: "Alle, die einrichten dürfen",
  stepDone: "Erledigt",
  stepYours: "Dein Schritt",
  stepOthers: "Erledigt durch:",
  openStep: "Öffnen",
  refreshState: "Zustand aktualisieren",
  chooseProviderHint: "Wähle, was du einrichten möchtest.",
};

export const INTEGRATION_TEXTS: Record<
  Locale,
  Partial<Record<IntegrationTextKey, string>>
> = { en, de };

/** The text of a key in the locale, else English, else the key itself. */
export function integrationText(locale: Locale) {
  return (key: IntegrationTextKey): string =>
    INTEGRATION_TEXTS[locale]?.[key] || en[key] || key;
}

// A deployed API can be newer than this web build (or an open tab), so a value
// outside the known lists shows as itself instead of breaking the page.
const pick = (
  labels: Record<string, Label>,
  value: string,
  locale: Locale,
): string => {
  const label = Object.hasOwn(labels, value) ? labels[value] : undefined;
  return label ? label[locale] || label.en : value;
};

const STATES: Record<IntegrationState, Label> = {
  not_set_up: { en: "Not set up", de: "Nicht eingerichtet" },
  stored: { en: "Stored, not checked", de: "Gespeichert, nicht geprüft" },
  verified: { en: "Verified", de: "Geprüft" },
  ready: { en: "Ready", de: "Bereit" },
  needs_attention: { en: "Needs attention", de: "Braucht Aufmerksamkeit" },
  disabled: { en: "Disabled", de: "Deaktiviert" },
};

const CATEGORIES: Record<IntegrationCategory, Label> = {
  email: { en: "E-mail", de: "E-Mail" },
  social: { en: "Social media", de: "Social Media" },
  google: { en: "Google", de: "Google" },
  ai: { en: "AI providers", de: "KI-Anbieter" },
  automation: { en: "Automation", de: "Automatisierung" },
  mcp: { en: "MCP", de: "MCP" },
  development: { en: "Development", de: "Entwicklung" },
  analytics: { en: "Analytics", de: "Analyse" },
  other: { en: "Other", de: "Weitere" },
};

const AUTH_TYPES: Record<IntegrationAuthType, Label> = {
  api_key: { en: "API key", de: "API-Schlüssel" },
  json_secret: { en: "Key set (JSON)", de: "Schlüsselsatz (JSON)" },
  oauth_app: { en: "Developer app (OAuth)", de: "Entwickler-App (OAuth)" },
  oauth_account: { en: "Account sign-in (OAuth)", de: "Kontoanmeldung (OAuth)" },
  bot_token: { en: "Bot token", de: "Bot-Token" },
  password: { en: "Server login", de: "Server-Anmeldung" },
  webhook_secret: { en: "Signed webhook", de: "Signierter Webhook" },
  environment: { en: "Set on the server", de: "Auf dem Server gesetzt" },
};

const STORAGES: Record<IntegrationStorage, Label> = {
  central: { en: "Central connection", de: "Zentrale Verbindung" },
  project: { en: "Project", de: "Projekt" },
  environment: { en: "Server environment", de: "Serverumgebung" },
};

export const stateLabel = (state: IntegrationState, locale: Locale) =>
  pick(STATES, state, locale);
export const categoryLabel = (category: IntegrationCategory, locale: Locale) =>
  pick(CATEGORIES, category, locale);
export const authTypeLabel = (authType: IntegrationAuthType, locale: Locale) =>
  pick(AUTH_TYPES, authType, locale);
export const storageLabel = (storage: IntegrationStorage, locale: Locale) =>
  pick(STORAGES, storage, locale);

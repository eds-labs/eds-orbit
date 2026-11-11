import type { Locale } from "@/lib/i18n";
import type { Label } from "@/platform/shell/types";
import { AREAS } from "./registry";
import type { ScopeKind } from "./types";

// The wording of the settings center frame. German must name every English
// key (the type checks it); a missing or empty entry at runtime falls back to
// English. The page title ("manageTitle") is in the central dictionary
// because the account menu names the page too.

const en = {
  scopeLabel: "Applies to",
  scopeSystem: "Whole system",
  scopeOrganizations: "Organizations",
  scopeProjects: "Projects",
  scopeAccount: "My account",
  searchLabel: "Search settings",
  searchEmpty: "No setting matches.",
  advanced: "Advanced",
  chooseSection: "Choose a section",
  notPermittedTitle: "Not available",
  notPermittedBody:
    "This page does not exist or your role does not include it.",
  overviewHint: "Choose an area. Each one says what it is for.",
  backToApp: "Back to Orbit",
  backToOrganization: "Back to organization",
  backToProject: "Back to project",
  backToList: "Back",
  orgMembers: "Members",
  orgProjects: "Projects",
  orgOpenMembers: "Manage members and projects",
  orgOpenAgents: "Agents of all projects",
};

export type CenterTextKey = keyof typeof en;

const de: Record<CenterTextKey, string> = {
  scopeLabel: "Gilt für",
  scopeSystem: "Gesamtes System",
  scopeOrganizations: "Organisationen",
  scopeProjects: "Projekte",
  scopeAccount: "Mein Konto",
  searchLabel: "Einstellungen suchen",
  searchEmpty: "Keine Einstellung passt dazu.",
  advanced: "Erweitert",
  chooseSection: "Abschnitt wählen",
  notPermittedTitle: "Nicht verfügbar",
  notPermittedBody:
    "Diese Seite gibt es nicht oder deine Rolle umfasst sie nicht.",
  overviewHint: "Wähle einen Bereich. Jeder sagt, wofür er da ist.",
  backToApp: "Zurück zu Orbit",
  backToOrganization: "Zurück zur Organisation",
  backToProject: "Zurück zum Projekt",
  backToList: "Zurück",
  orgMembers: "Mitglieder",
  orgProjects: "Projekte",
  orgOpenMembers: "Mitglieder und Projekte verwalten",
  orgOpenAgents: "Agenten aller Projekte",
};

export const CENTER_TEXTS: Record<
  Locale,
  Partial<Record<CenterTextKey, string>>
> = { en, de };

/** The text of a key in the locale, else English, else the key itself. */
export function centerText(locale: Locale) {
  return (key: CenterTextKey): string =>
    CENTER_TEXTS[locale]?.[key] || en[key] || key;
}

/** The label of an area; the labels themselves live in the registry. */
export const areaLabel = (scope: ScopeKind, area: string): Label =>
  AREAS[scope].find((a) => a.id === area)?.label ?? { en: area, de: area };

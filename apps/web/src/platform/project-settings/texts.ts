import type { Locale } from "@/lib/i18n";

// The wording of the project-wide settings (Settings → Project). German
// must name every English key (the type checks it); a missing or empty
// entry at runtime falls back to English.

const en = {
  projectHeading: "Project",
  projectHint:
    "Settings that apply to the whole project and every module. Module settings are in their own groups below; organization and installation settings are in the administration.",
  name: "Name",
  timezone: "Timezone",
  yourRole: "Your role",
  signedInAs: "Signed in as",
  mode: "Operating mode",
  exportProject: "Export project",
  roleOwner: "Owner",
  roleEditor: "Editor",
  roleViewer: "Viewer",
  roleMember: "Member",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  saving: "Saving…",
  ownerOnly: "Only project owners can change this.",
  // Content languages
  languagesHeading: "Content languages",
  languagesHint:
    "The languages this project creates and manages content in, for knowledge, drafts and module content. Your interface language is a personal setting in your account.",
  defaultLanguage: "Default language",
  defaultBadge: "Default",
  addLanguage: "Add language",
  chooseLanguage: "Choose a language…",
  otherCode: "Other language code",
  otherCodeHint: "A standard language tag such as fr, pt-BR or zh-Hant.",
  addCode: "Add",
  removeLanguage: "Remove",
  invalidCode: "This is not a valid language code.",
  duplicateLanguage: "This language is already in the list.",
  tooManyLanguages: "A project can have at most 20 content languages.",
  oneLanguageRequired: "Keep at least one content language.",
  agentLanguagesNote:
    "Automatic Marketing agents and assignments write in English or German, because their fact and image checks are tuned to these languages. Other languages are available for knowledge, manual campaigns and drafts.",
  // Links
  linksHeading: "Profile links",
  linksHint:
    "The project's public addresses: website, social media profiles, app stores and other links. They describe the project; they do not connect or authorize publishing.",
  linksChannelsNote:
    "Publishing channels are connected and verified separately under Integrations. A profile link here never enables posting.",
  noLinks: "No profile links yet.",
  addLink: "Add link",
  linkType: "Type",
  linkLabel: "Name",
  linkUrl: "Address (https://…)",
  moveUp: "Move up",
  moveDown: "Move down",
  removeLink: "Remove link",
  labelRequired: "Enter a name.",
  urlInvalid: "Enter a complete address.",
  httpsRequired: "The address must start with https://.",
  hostMismatch: "This address does not belong to the selected platform.",
  duplicateUrl: "This address is already in the list.",
  tooManyLinks: "A project can have at most 40 links.",
  openLink: "Open",
};

export type ProjectSettingsTextKey = keyof typeof en;

const de: Record<ProjectSettingsTextKey, string> = {
  projectHeading: "Projekt",
  projectHint:
    "Einstellungen für das ganze Projekt und alle Module. Moduleinstellungen stehen in eigenen Gruppen darunter; Organisations- und Installationseinstellungen in der Administration.",
  name: "Name",
  timezone: "Zeitzone",
  yourRole: "Deine Rolle",
  signedInAs: "Angemeldet als",
  mode: "Betriebsmodus",
  exportProject: "Projekt exportieren",
  roleOwner: "Owner",
  roleEditor: "Bearbeiten",
  roleViewer: "Lesen",
  roleMember: "Mitglied",
  edit: "Bearbeiten",
  save: "Speichern",
  cancel: "Abbrechen",
  saving: "Wird gespeichert…",
  ownerOnly: "Nur Owner des Projekts können das ändern.",
  languagesHeading: "Content-Sprachen",
  languagesHint:
    "Die Sprachen, in denen dieses Projekt Inhalte erstellt und verwaltet – für Wissen, Entwürfe und Modulinhalte. Deine Oberflächensprache ist eine persönliche Einstellung in deinem Konto.",
  defaultLanguage: "Standardsprache",
  defaultBadge: "Standard",
  addLanguage: "Sprache hinzufügen",
  chooseLanguage: "Sprache wählen…",
  otherCode: "Anderer Sprachcode",
  otherCodeHint: "Ein Standard-Sprachcode wie fr, pt-BR oder zh-Hant.",
  addCode: "Hinzufügen",
  removeLanguage: "Entfernen",
  invalidCode: "Das ist kein gültiger Sprachcode.",
  duplicateLanguage: "Diese Sprache ist bereits in der Liste.",
  tooManyLanguages: "Ein Projekt kann höchstens 20 Content-Sprachen haben.",
  oneLanguageRequired: "Mindestens eine Content-Sprache muss bleiben.",
  agentLanguagesNote:
    "Automatische Marketing-Agenten und Aufträge schreiben auf Englisch oder Deutsch, weil ihre Fakten- und Bildprüfungen auf diese Sprachen abgestimmt sind. Andere Sprachen stehen für Wissen, manuelle Kampagnen und Entwürfe zur Verfügung.",
  linksHeading: "Profil-Links",
  linksHint:
    "Die öffentlichen Adressen des Projekts: Website, Social-Media-Profile, App-Stores und weitere Links. Sie beschreiben das Projekt; sie verbinden oder autorisieren kein Veröffentlichen.",
  linksChannelsNote:
    "Veröffentlichungskanäle werden separat unter Integrationen verbunden und verifiziert. Ein Profil-Link hier ermöglicht nie das Posten.",
  noLinks: "Noch keine Profil-Links.",
  addLink: "Link hinzufügen",
  linkType: "Typ",
  linkLabel: "Name",
  linkUrl: "Adresse (https://…)",
  moveUp: "Nach oben",
  moveDown: "Nach unten",
  removeLink: "Link entfernen",
  labelRequired: "Gib einen Namen ein.",
  urlInvalid: "Gib eine vollständige Adresse ein.",
  httpsRequired: "Die Adresse muss mit https:// beginnen.",
  hostMismatch: "Diese Adresse gehört nicht zur gewählten Plattform.",
  duplicateUrl: "Diese Adresse ist bereits in der Liste.",
  tooManyLinks: "Ein Projekt kann höchstens 40 Links haben.",
  openLink: "Öffnen",
};

const texts: Record<Locale, Partial<Record<ProjectSettingsTextKey, string>>> = {
  en,
  de,
};

/** The text of a key in the locale, else English, else the key itself. */
export function projectSettingsText(locale: Locale) {
  return (key: ProjectSettingsTextKey): string =>
    texts[locale]?.[key] || en[key] || key;
}

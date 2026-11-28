import type { Locale } from "@/lib/i18n";
import { ApiError } from "@/lib/api";

const en = {
  intro: "Measure how your websites perform in organic search.",
  overview: "Overview",
  manage: "Manage websites and connections",
  manageDescription:
    "Add websites to this project and link them to verified properties.",
  loading: "Loading SEO workspace…",
  checkingProperties: "Loading properties…",
  waitingReport: "Loading performance…",
  retry: "Try again",
  problem: "Orbit could not complete the SEO request.",
  denied: "Your SEO role does not allow this action.",
  entitlement: "The organization does not have access to SEO.",
  unavailable: "The SEO module is unavailable for this project.",
  missingGrant:
    "A system administrator must configure the OAuth app and grant this project access.",
  missingConnection:
    "An administrator must configure a provider connection for this project.",
  projectConnections: "Open project connections",
  reconnectNeeded:
    "This connection can no longer read data. Reconnect it to continue.",
  providerDenied: "The connected account cannot access this property.",
  propertyChanged:
    "The linked property changed while loading. Load the report again.",
  rateLimited: "The provider is limiting requests. Try again later.",
  duplicate: "This website or property is already linked.",
  siteLimit: "This project has reached its website limit.",
  missing: "This website, connection or property is no longer available.",
  connect: "Connect account",
  reconnect: "Reconnect",
  sending: "Connecting…",
  connected:
    "Account connected. Link a property to a website to load performance.",
  connectFailed: "Could not connect the account. Try connecting again.",
  connectionUnavailable: "Unavailable",
  disconnect: "Disconnect",
  disconnectHelp: "Orbit will stop using this connection to read performance.",
  connections: "Provider accounts",
  noConnections: "No accounts connected.",
  websites: "Websites",
  addWebsite: "Add website",
  siteName: "Name",
  siteUrl: "Website URL",
  siteUrlHint:
    "Enter an HTTP or HTTPS URL without query parameters, a fragment or credentials.",
  websiteAdded: "Website added.",
  archive: "Archive",
  archiveHelp: "The website will disappear from the SEO workspace and reports.",
  link: "Link property",
  replaceLink: (propertyId: string) =>
    `Saving replaces the existing link to ${propertyId}.`,
  unlink: "Remove link",
  unlinkHelp: "Orbit will stop loading reports for this property.",
  noProperties: "This account has no available properties.",
  noLinks: "No properties linked.",
  selectWebsite: "Website",
  selectProvider: "Provider",
  selectConnection: "Account",
  selectProperty: "Property",
  choose: "Select…",
  cancel: "Cancel",
  saved: "Changes saved.",
  readonly: "Project owners can manage SEO websites and connections.",
  noSites: "No websites yet",
  noSitesBody:
    "Add a website and link a property to review organic search performance.",
  noLinkedSites: "No properties linked",
  noLinkedSitesBody:
    "Link a property to a website to load its search performance.",
  performance: "Search performance",
  reportTable: "Performance report table",
  startDate: "Start date",
  endDate: "End date",
  groupBy: "Group by",
  load: "Load report",
  range: "Choose a date range of up to 90 days.",
  rangeError:
    "The end date must follow the start date. Choose a period of up to 90 days.",
  dimensions: {
    date: "Date",
    page: "Page",
    query: "Search query",
    country: "Country",
    device: "Device",
  },
  clicks: "Clicks",
  impressions: "Impressions",
  ctr: "Click-through rate",
  position: "Average position",
  emptyReport: "No data for this period.",
  reportRows: (n: number, from: string, to: string) =>
    `${n} rows · ${from} to ${to}`,
};
const de: typeof en = {
  intro: "Miss, wie sichtbar deine Websites in der organischen Suche sind.",
  overview: "Übersicht",
  manage: "Websites und Verbindungen verwalten",
  manageDescription:
    "Füge Websites zum Projekt hinzu und verknüpfe sie mit bestätigten Properties.",
  loading: "SEO-Bereich wird geladen…",
  checkingProperties: "Properties werden geladen…",
  waitingReport: "Leistungsdaten werden geladen…",
  retry: "Erneut versuchen",
  problem: "Orbit konnte die SEO-Anfrage nicht abschließen.",
  denied: "Deine SEO-Rolle erlaubt diese Aktion nicht.",
  entitlement: "Die Organisation hat keinen Zugriff auf SEO.",
  unavailable: "Das SEO-Modul ist für dieses Projekt nicht verfügbar.",
  missingGrant:
    "Ein Systemadministrator muss die OAuth-App einrichten und für dieses Projekt freigeben.",
  missingConnection:
    "Ein Administrator muss für dieses Projekt eine Verbindung zum Anbieter einrichten.",
  projectConnections: "Projektverbindungen öffnen",
  reconnectNeeded:
    "Diese Verbindung kann keine Daten mehr lesen. Verbinde das Konto erneut.",
  providerDenied: "Das verbundene Konto hat keinen Zugriff auf diese Property.",
  propertyChanged:
    "Die Property-Verknüpfung hat sich während des Abrufs geändert. Lade den Bericht erneut.",
  rateLimited:
    "Der Anbieter begrenzt gerade die Anfragen. Versuche es später erneut.",
  duplicate: "Diese Website oder Property ist bereits verknüpft.",
  siteLimit: "Dieses Projekt hat sein Website-Limit erreicht.",
  missing: "Diese Website, Verbindung oder Property ist nicht mehr verfügbar.",
  connect: "Konto verbinden",
  reconnect: "Erneut verbinden",
  sending: "Verbindung wird hergestellt…",
  connected:
    "Konto verbunden. Verknüpfe eine Property mit einer Website, um Leistungsdaten zu laden.",
  connectFailed:
    "Die Verbindung konnte nicht hergestellt werden. Versuche es erneut.",
  connectionUnavailable: "Nicht verfügbar",
  disconnect: "Verbindung trennen",
  disconnectHelp:
    "Orbit liest über diese Verbindung keine Leistungsdaten mehr.",
  connections: "Anbieterkonten",
  noConnections: "Keine Konten verbunden.",
  websites: "Websites",
  addWebsite: "Website hinzufügen",
  siteName: "Name",
  siteUrl: "Website-URL",
  siteUrlHint:
    "Gib eine HTTP- oder HTTPS-URL ohne Suchparameter, Fragment oder Zugangsdaten ein.",
  websiteAdded: "Website hinzugefügt.",
  archive: "Archivieren",
  archiveHelp:
    "Die Website verschwindet aus dem SEO-Bereich und seinen Berichten.",
  link: "Property verknüpfen",
  replaceLink: (propertyId: string) =>
    `Beim Speichern wird die Verknüpfung zu ${propertyId} ersetzt.`,
  unlink: "Verknüpfung entfernen",
  unlinkHelp: "Orbit lädt für diese Property keine Berichte mehr.",
  noProperties: "Für dieses Konto sind keine Properties verfügbar.",
  noLinks: "Keine Properties verknüpft.",
  selectWebsite: "Website",
  selectProvider: "Anbieter",
  selectConnection: "Konto",
  selectProperty: "Property",
  choose: "Bitte wählen…",
  cancel: "Abbrechen",
  saved: "Änderungen gespeichert.",
  readonly:
    "Projektinhaber können Websites und Verbindungen für SEO verwalten.",
  noSites: "Noch keine Websites",
  noSitesBody:
    "Füge eine Website hinzu und verknüpfe eine Property, um Leistungsdaten zur organischen Suche abzurufen.",
  noLinkedSites: "Keine Properties verknüpft",
  noLinkedSitesBody:
    "Verknüpfe eine Property mit einer Website, um Leistungsdaten für die Suche zu laden.",
  performance: "Leistung in der Suche",
  reportTable: "Tabelle mit Leistungsdaten",
  startDate: "Startdatum",
  endDate: "Enddatum",
  groupBy: "Gruppieren nach",
  load: "Bericht laden",
  range: "Wähle einen Zeitraum von bis zu 90 Tagen.",
  rangeError:
    "Das Enddatum darf nicht vor dem Startdatum liegen. Wähle höchstens 90 Tage.",
  dimensions: {
    date: "Datum",
    page: "Seite",
    query: "Suchanfrage",
    country: "Land",
    device: "Gerät",
  },
  clicks: "Klicks",
  impressions: "Impressionen",
  ctr: "Klickrate",
  position: "Durchschnittliche Position",
  emptyReport: "Für diesen Zeitraum liegen keine Daten vor.",
  reportRows: (n, from, to) => `${n} Zeilen · ${from} bis ${to}`,
};

export const seoText = (locale: Locale) => (locale === "de" ? de : en);

export function seoError(error: unknown, t: ReturnType<typeof seoText>) {
  if (!(error instanceof ApiError)) return t.problem;
  switch (error.code) {
    case "MODULE_DISABLED":
    case "SEO_DISABLED":
      return t.unavailable;
    case "SEO_ENTITLEMENT_REQUIRED":
      return t.entitlement;
    case "SEO_GOOGLE_APP_NOT_GRANTED":
    case "SEO_GOOGLE_APP_INVALID":
    case "SEO_GOOGLE_APP_CHANGED":
      return t.missingGrant;
    case "SEO_PROPERTY_CHANGED":
      return t.propertyChanged;
    case "SEO_CONNECTION_RECONNECT_REQUIRED":
      return t.reconnectNeeded;
    case "SEO_WEBSITE_LIMIT":
      return t.siteLimit;
    case "SEO_PROPERTY_NOT_AVAILABLE":
    case "SEO_PROPERTY_INACCESSIBLE":
      return t.providerDenied;
    case "SEO_PROVIDER_RATE_LIMITED":
      return t.rateLimited;
    case "SEO_WEBSITE_EXISTS":
      return t.duplicate;
    case "SEO_WEBSITE_URL_INVALID":
      return t.siteUrlHint;
    case "SEO_DATE_RANGE_INVALID":
    case "SEO_REPORT_INPUT_INVALID":
      return t.rangeError;
  }
  if (error.status === 429) return t.rateLimited;
  if (error.status === 403) return t.denied;
  if (error.status === 404) return t.missing;
  return t.problem;
}

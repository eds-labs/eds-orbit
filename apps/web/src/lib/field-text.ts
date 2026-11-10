import type { Locale } from "./i18n";

// Column headers of the generic record table (EntityRows, WP5 2026-11-10).
// The table prints these as written: the old CSS capitalisation turned
// "updatedAt" into "Updated At" and would turn German into "Aktualisiert Am".

const en = {
  title: "Title",
  name: "Name",
  type: "Type",
  kind: "Kind",
  channel: "Channel",
  status: "Status",
  mode: "Mode",
  topic: "Topic",
  resourceId: "Resource",
  questionCount: "Questions",
  primaryMetric: "Primary metric",
  language: "Language",
  version: "Version",
  scheduledAt: "Scheduled for",
  createdAt: "Created",
  updatedAt: "Updated",
} as const;

export type FieldKey = keyof typeof en;

const de: Record<FieldKey, string> = {
  title: "Titel",
  name: "Name",
  type: "Typ",
  kind: "Art",
  channel: "Kanal",
  status: "Status",
  mode: "Modus",
  topic: "Thema",
  resourceId: "Ressource",
  questionCount: "Fragen",
  primaryMetric: "Hauptkennzahl",
  language: "Sprache",
  version: "Version",
  scheduledAt: "Geplant für",
  createdAt: "Erstellt",
  updatedAt: "Aktualisiert",
};

const tables: Record<Locale, Record<FieldKey, string>> = { en, de };

/**
 * The header of a record field in the locale. A field it does not know
 * reads as its words in sentence case ("lastSeenAt" → "Last seen at").
 */
export function fieldLabel(locale: Locale, key: string): string {
  if (Object.prototype.hasOwnProperty.call(en, key))
    return (tables[locale] ?? en)[key as FieldKey];
  const words = key
    .replace(/([A-Z])/g, " $1")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

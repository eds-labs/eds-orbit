import type { CmsSettings, EntryStatus } from "./api";

// The content module's texts (English and German). Short and factual.

const en = {
  module: "Content",
  intro:
    "Website content of this project: articles, their versions, SEO and publication.",
  nav: { overview: "Overview", entries: "Entries" },
  approversTitle: "Publication approvals",
  approvers: {
    owner: "Publishing and updates are approved by the owner.",
    owner_or_editor:
      "Publishing and updates are approved by the owner or a content editor.",
  } as Record<CmsSettings["publishApprovers"], string>,
  fourEyes: "The person who asks for a publication cannot approve it.",
  emptyTitle: "No content yet",
  emptyBody: "Create the first article under Entries.",
  overview: {
    drafts: "Drafts",
    waiting: "Waiting for a decision",
    scheduled: "Scheduled",
    published: "Published",
    sites: "Websites",
    recent: "Edited last",
  },
  status: {
    draft: "Draft",
    in_review: "In review",
    scheduled: "Scheduled",
    published: "Published",
    archived: "Archived",
  } as Record<EntryStatus, string>,
  entries: {
    title: "Entries",
    intro:
      "Articles of this project in every language, with their publication state.",
    newArticle: "New article",
    create: "Create draft",
    titleLabel: "Title",
    localeLabel: "Language",
    sitesLabel: "Websites",
    noSites:
      "No website serves this language yet. The owner adds websites in the settings.",
    filterStatus: "Status",
    filterLocale: "Language",
    search: "Search titles",
    all: "All (without archived)",
    allLocales: "All languages",
    empty: "No entries match.",
    emptyAll: "No entries yet. Create the first article.",
    untitled: "Untitled",
    updated: "Updated",
    waiting: "Waiting for a decision",
    more: "Show more",
    back: "All entries",
    open: "Open",
    live: "Live version",
    noLive: "Not published",
    latest: "Latest version",
    unsaved: "The draft has changes that no version holds yet.",
    scheduledFor: "Scheduled for",
    translations: "Translations",
    preflightTitle: "Before publishing",
    preflightOk: "Nothing stops a publication.",
    editorSoon:
      "The editor follows in the next step. Until then drafts are written through the API or MCP.",
    issue: {
      CMS_TYPE_UNAVAILABLE: "This content type cannot be published yet.",
      CMS_TITLE_MISSING: "The title is missing.",
      CMS_SITE_REQUIRED: "Choose at least one website.",
      CMS_SITE_UNAVAILABLE:
        "A chosen website is archived or does not serve this language.",
      CMS_SLUG_TAKEN: "Another entry uses this address.",
      CMS_REFERENCE_UNKNOWN: "An image, author or term no longer exists.",
      CMS_ALT_TEXT_MISSING: "An image needs alt text in this language.",
      AI_LABEL_MISSING: "An AI image is missing its label.",
      CMS_CONTENT_RULE: "The text breaks a rule of a website.",
    } as Record<string, string>,
    issueOther: "Something stops the publication",
  },
  attention: {
    open: "Open content",
    stopped: (n: number) =>
      n === 1
        ? "1 publication stopped and needs a person"
        : `${n} publications stopped and need a person`,
    liveCheck: (n: number) =>
      n === 1
        ? "1 website does not show the published version yet"
        : `${n} published versions are not shown on their website yet`,
  },
};

const de: typeof en = {
  module: "Inhalte",
  intro:
    "Website-Inhalte dieses Projekts: Artikel, ihre Versionen, SEO und Veröffentlichung.",
  nav: { overview: "Übersicht", entries: "Einträge" },
  approversTitle: "Freigabe von Veröffentlichungen",
  approvers: {
    owner: "Veröffentlichungen und Aktualisierungen gibt der Owner frei.",
    owner_or_editor:
      "Veröffentlichungen und Aktualisierungen geben der Owner oder ein Content-Editor frei.",
  },
  fourEyes:
    "Wer eine Veröffentlichung anfordert, kann sie nicht selbst freigeben.",
  emptyTitle: "Noch keine Inhalte",
  emptyBody: "Lege den ersten Artikel unter Einträge an.",
  overview: {
    drafts: "Entwürfe",
    waiting: "Warten auf Entscheidung",
    scheduled: "Geplant",
    published: "Veröffentlicht",
    sites: "Websites",
    recent: "Zuletzt bearbeitet",
  },
  status: {
    draft: "Entwurf",
    in_review: "In Prüfung",
    scheduled: "Geplant",
    published: "Veröffentlicht",
    archived: "Archiviert",
  },
  entries: {
    title: "Einträge",
    intro:
      "Artikel dieses Projekts in allen Sprachen, mit ihrem Veröffentlichungsstand.",
    newArticle: "Neuer Artikel",
    create: "Entwurf anlegen",
    titleLabel: "Titel",
    localeLabel: "Sprache",
    sitesLabel: "Websites",
    noSites:
      "Noch keine Website bedient diese Sprache. Der Owner legt Websites in den Einstellungen an.",
    filterStatus: "Status",
    filterLocale: "Sprache",
    search: "Titel durchsuchen",
    all: "Alle (ohne archivierte)",
    allLocales: "Alle Sprachen",
    empty: "Keine Einträge gefunden.",
    emptyAll: "Noch keine Einträge. Lege den ersten Artikel an.",
    untitled: "Ohne Titel",
    updated: "Geändert",
    waiting: "Wartet auf Entscheidung",
    more: "Mehr anzeigen",
    back: "Alle Einträge",
    open: "Öffnen",
    live: "Live-Version",
    noLive: "Nicht veröffentlicht",
    latest: "Letzte Version",
    unsaved: "Der Entwurf hat Änderungen, die noch keine Version enthält.",
    scheduledFor: "Geplant für",
    translations: "Übersetzungen",
    preflightTitle: "Vor dem Veröffentlichen",
    preflightOk: "Nichts steht einer Veröffentlichung im Weg.",
    editorSoon:
      "Der Editor folgt im nächsten Schritt. Bis dahin entstehen Entwürfe über die API oder MCP.",
    issue: {
      CMS_TYPE_UNAVAILABLE:
        "Dieser Inhaltstyp kann noch nicht veröffentlicht werden.",
      CMS_TITLE_MISSING: "Der Titel fehlt.",
      CMS_SITE_REQUIRED: "Wähle mindestens eine Website.",
      CMS_SITE_UNAVAILABLE:
        "Eine gewählte Website ist archiviert oder bedient diese Sprache nicht.",
      CMS_SLUG_TAKEN: "Ein anderer Eintrag nutzt diese Adresse.",
      CMS_REFERENCE_UNKNOWN:
        "Ein Bild, Autor oder Begriff existiert nicht mehr.",
      CMS_ALT_TEXT_MISSING:
        "Ein Bild braucht einen Alt-Text in dieser Sprache.",
      AI_LABEL_MISSING: "Einem KI-Bild fehlt die Kennzeichnung.",
      CMS_CONTENT_RULE: "Der Text verletzt eine Regel einer Website.",
    },
    issueOther: "Etwas verhindert die Veröffentlichung",
  },
  attention: {
    open: "Inhalte öffnen",
    stopped: (n: number) =>
      n === 1
        ? "1 Veröffentlichung wurde angehalten und braucht eine Person"
        : `${n} Veröffentlichungen wurden angehalten und brauchen eine Person`,
    liveCheck: (n: number) =>
      n === 1
        ? "1 Website zeigt die veröffentlichte Version noch nicht"
        : `${n} veröffentlichte Versionen erscheinen noch nicht auf ihrer Website`,
  },
};

export const cmsText = (locale: "en" | "de") => (locale === "de" ? de : en);

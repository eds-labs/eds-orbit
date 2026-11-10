import type { Locale } from "@/lib/i18n";

// Marketing's words in English and German (WP5, 2026-11-10), for the views
// moved off inline `locale === "de"` ternaries. Typed: the German table
// must have every key of the English one.

const en = {
  policy: {
    heading: "Versioned operating policy",
    intro: "A mandate is specific, time-bounded and verifiable.",
    newVersion: "New policy version",
    emptyTitle: "Observe is the safe starting point",
    emptyText:
      "No publishing rules are active yet, so Orbit observes and publishes nothing.",
    setupLink: "Set publishing rules",
    current: "Current version",
    noCurrent:
      "No policy version is active. Orbit publishes nothing until an owner activates one.",
    history: (count: number) =>
      `History (${count} ${count === 1 ? "version" : "versions"})`,
    caption: "All policy versions, newest first",
    version: "Version",
    mode: "Mode",
    status: "Status",
    valid: "Valid",
    activatedAt: "Activated",
    replacedAt: "Replaced",
    open: (n: number) => `Open version ${n}`,
    detailTitle: (n: number) => `Policy version ${n}`,
    validFrom: "Valid from",
    validUntil: "Valid until",
    channels: "Channels",
    contentTypes: "Content types",
    allowedOrigins: "Approved target origins",
    maxPerDay: "Publications per day (maximum)",
    minInterval: "Minimum spacing",
    minutes: (n: number) => `${n} min`,
    quietHours: "Quiet hours",
    budgetNote:
      "The AI budget is not part of this policy. It applies to every module and is set under",
    budgetLink: "Settings → AI & budget",
  },
  contentTypes: {
    social: "Social media",
    blog: "Blog",
    newsletter: "Newsletter",
    ad: "Ad",
    script: "Script",
    community: "Community",
  } as Record<string, string>,
  editor: {
    title: "New operating policy",
    description:
      "Only a verified capability can act under this mandate. Infrastructure, new spending permissions and unrelated channels remain outside its scope.",
    mode: "Operating mode",
    channels: "Authorized channels (comma separated)",
    contentTypes: "Authorized content types (comma separated)",
    allowedOrigins: "Approved target origins (comma separated)",
    startAt: "Mandate start",
    endAt: "Mandate end",
    maxPerDay: "Maximum publications per day",
    minInterval: "Minimum spacing (minutes)",
    quietStart: "Quiet hours start (project hour 0–23)",
    quietEnd: "Quiet hours end (project hour 0–23)",
    confirm: "I approve this exact version, its channels and dates.",
    save: "Save policy version",
    budgetPrefix: "AI budget:",
    budgetLimits: (
      daily: string,
      monthly: string,
      perRun: string,
      until: string,
    ) =>
      `${daily} per day, ${monthly} per month, ${perRun} per run, until ${until}`,
    budgetUnpaid: " (paid use not allowed)",
    budgetNotSet: "not set, so no paid AI runs.",
    budgetScope: "It applies to every module and is set under",
    budgetLink: "Settings → AI & budget",
    budgetKept: "; this policy keeps it unchanged.",
  },
  // The editorial plan (the page at marketing/calendar): it plans content
  // items; the Social calendar publishes.
  calendar: {
    title: "Editorial plan",
    description: (timezone: string) =>
      `Plans content items by month. Nothing is published from here. Times in ${timezone}.`,
    month: "Month",
    scheduleHint:
      "Edit a schedule through the content form, fully accessible by keyboard. Changes invalidate outdated approvals.",
    socialLink: "Publications in the Social calendar",
    items: "Planned content items",
    conflict: "Conflicts with a blocked period",
    emptyTitle: "No content scheduled this month",
    emptyText: "Open a draft and choose its schedule.",
  },
  blocks: {
    heading: "Blocked periods",
    intro:
      "Nothing is published in a blocked period. Orbit checks blocks again right before publishing; releasing one does not restore outdated approvals.",
    add: "Add blocked period",
    blocked: "Blocked",
    allChannels: "All channels",
    release: "Release",
    releaseLabel: (title: string) => `Release blocked period ${title}`,
    empty:
      "No blocked periods. The policy's quotas, spacing and quiet hours still apply.",
    title: "Title",
    channels: "Channels, comma separated (empty means all)",
    startAt: "Starts (browser local time)",
    endAt: "Ends (browser local time)",
    reason: "Reason",
    submit: "Block this period",
  },
  content: {
    description: "From source-backed ideas to reviewed content.",
    community: "Community questions",
    communityIntro:
      "Labeled imports, recurring topics and accountable internal drafts.",
    studio: "Content Studio",
    search: "Search content",
    format: "Format",
    allFormats: "All formats",
    channels: "Channels",
    caption: "Content: one row per post, its channel versions inside",
    showReplaced: (n: number) => `Show replaced versions (${n})`,
    replaced: "Replaced",
    variants: (n: number) => `${n} channels`,
    expand: (title: string) => `show the channels of ${title}`,
    open: (title: string) => `Open ${title}`,
    openColumn: "Open",
  },
  approvals: {
    open: "Open actions",
    openIntro:
      "What waits for a decision: drafts to release or review, exceptions and stopped posts.",
    openEmpty: "Nothing waits for you.",
    openContent: "Content to review",
    openContentIntro:
      "Content that still needs a review. Open it to review, reject or discard it.",
    reviewed: "Reviewed, not scheduled",
    reviewedIntro:
      "Reviewed content that no publication or Postiz draft holds yet.",
    released: "Released & scheduled",
    releasedIntro:
      "Released posts with their slot. They no longer need a decision; an upcoming one can still be stopped.",
    releasedEmpty: "Nothing is released or scheduled.",
    history: "History",
    historyIntro: "Published, replaced, rejected and archived content.",
    historyNewest: (n: number) => `The ${n} most recent are shown.`,
    decisions: "Decisions on assignment drafts",
    decisionsIntro: "What the owner decided in the last 30 days.",
    cleanup: "Clean up",
    cleanupHint:
      "“Archive old drafts” archives every draft here that nothing holds any more (no planned post, open hand-off, open decision or running assignment); you see each draft first and can undo it.",
    expired: "Expired drafts",
    expiredIntro:
      "Their slot passed and is not caught up: reject or archive them, or archive all old drafts at once.",
    releasedByYou: (date: string) => `Released by you on ${date}`,
    releasedByOwner: (date: string) => `Released by an owner on ${date}`,
    releasedByAgent: "Released by the review agent after the veto window",
    scheduled: "Scheduled",
    heldInSocial: "Announced in Social; it goes out at its slot",
    postizDraft: "Handed to Postiz as a draft",
    openInSocial: "Open in Social",
    slot: (time: string) => `Slot ${time}`,
    focused: "This is the post you opened from Social.",
    focusMissing:
      "The post opened from Social is not listed here any more; it may be in the history.",
  },
};

export type MarketingText = typeof en;

const de: MarketingText = {
  policy: {
    heading: "Versionierte Betriebsrichtlinie",
    intro: "Ein Mandat ist konkret, zeitlich begrenzt und überprüfbar.",
    newVersion: "Neue Richtlinienversion",
    emptyTitle: "Beobachten ist der sichere Start",
    emptyText:
      "Es sind noch keine Veröffentlichungsregeln aktiv. Orbit beobachtet nur und veröffentlicht nichts.",
    setupLink: "Veröffentlichungsregeln festlegen",
    current: "Aktuelle Version",
    noCurrent:
      "Keine Richtlinienversion ist aktiv. Orbit veröffentlicht nichts, bis ein Owner eine aktiviert.",
    history: (count: number) =>
      `Verlauf (${count} ${count === 1 ? "Version" : "Versionen"})`,
    caption: "Alle Richtlinienversionen, neueste zuerst",
    version: "Version",
    mode: "Modus",
    status: "Status",
    valid: "Gültig",
    activatedAt: "Aktiviert",
    replacedAt: "Ersetzt",
    open: (n: number) => `Version ${n} öffnen`,
    detailTitle: (n: number) => `Richtlinienversion ${n}`,
    validFrom: "Gültig ab",
    validUntil: "Gültig bis",
    channels: "Kanäle",
    contentTypes: "Inhaltstypen",
    allowedOrigins: "Freigegebene Zielseiten",
    maxPerDay: "Veröffentlichungen pro Tag (höchstens)",
    minInterval: "Mindestabstand",
    minutes: (n: number) => `${n} Min.`,
    quietHours: "Ruhezeiten",
    budgetNote:
      "Das KI-Budget ist nicht Teil dieser Richtlinie. Es gilt für alle Module und wird festgelegt unter",
    budgetLink: "Einstellungen → KI & Budget",
  },
  contentTypes: {
    social: "Social Media",
    blog: "Blog",
    newsletter: "Newsletter",
    ad: "Anzeige",
    script: "Skript",
    community: "Community",
  },
  editor: {
    title: "Neue Betriebsrichtlinie",
    description:
      "Nur eine verifizierte Fähigkeit kann unter diesem Mandat handeln. Infrastruktur, neue Ausgabeberechtigungen und fremde Kanäle bleiben außerhalb.",
    mode: "Betriebsmodus",
    channels: "Freigegebene Kanäle (durch Komma getrennt)",
    contentTypes: "Freigegebene Inhaltstypen (durch Komma getrennt)",
    allowedOrigins: "Freigegebene Zielseiten (Origins, durch Komma getrennt)",
    startAt: "Beginn des Mandats",
    endAt: "Ende des Mandats",
    maxPerDay: "Höchstens Veröffentlichungen pro Tag",
    minInterval: "Mindestabstand (Minuten)",
    quietStart: "Beginn der Ruhezeit (Projektstunde 0–23)",
    quietEnd: "Ende der Ruhezeit (Projektstunde 0–23)",
    confirm: "Ich gebe genau diese Version mit ihren Kanälen und Zeiten frei.",
    save: "Richtlinienversion speichern",
    budgetPrefix: "KI-Budget:",
    budgetLimits: (
      daily: string,
      monthly: string,
      perRun: string,
      until: string,
    ) =>
      `${daily} pro Tag, ${monthly} pro Monat, ${perRun} pro Lauf, bis ${until}`,
    budgetUnpaid: " (bezahlte Nutzung nicht erlaubt)",
    budgetNotSet: "nicht festgelegt, daher laufen keine bezahlten KI-Aufrufe.",
    budgetScope: "Es gilt für alle Module und wird festgelegt unter",
    budgetLink: "Einstellungen → KI & Budget",
    budgetKept: "; diese Richtlinie lässt es unverändert.",
  },
  calendar: {
    title: "Redaktionsplan",
    description: (timezone: string) =>
      `Plant Inhalte nach Monat. Von hier wird nichts veröffentlicht. Zeiten in ${timezone}.`,
    month: "Monat",
    scheduleHint:
      "Termine bearbeitest du über das Inhaltsformular – vollständig per Tastatur. Jede Änderung hebt veraltete Freigaben auf.",
    socialLink: "Veröffentlichungen im Social-Kalender",
    items: "Geplante Inhalte",
    conflict: "Kollidiert mit einer Sperrzeit",
    emptyTitle: "Noch keine geplanten Inhalte",
    emptyText: "Öffne einen Entwurf und wähle einen Termin.",
  },
  blocks: {
    heading: "Sperrzeiten",
    intro:
      "In einer Sperrzeit wird nichts veröffentlicht. Orbit prüft Sperrzeiten direkt vor dem Veröffentlichen erneut; das Aufheben stellt veraltete Freigaben nicht wieder her.",
    add: "Sperrzeit hinzufügen",
    blocked: "Gesperrt",
    allChannels: "Alle Kanäle",
    release: "Aufheben",
    releaseLabel: (title: string) => `Sperrzeit ${title} aufheben`,
    empty:
      "Keine Sperrzeiten. Kontingente, Mindestabstände und Ruhezeiten der Richtlinie gelten weiterhin.",
    title: "Bezeichnung",
    channels: "Kanäle, durch Komma getrennt (leer heißt alle)",
    startAt: "Beginnt (Ortszeit des Browsers)",
    endAt: "Endet (Ortszeit des Browsers)",
    reason: "Grund",
    submit: "Diesen Zeitraum sperren",
  },
  content: {
    description: "Von belegten Ideen zu überprüften Inhalten.",
    community: "Community-Fragen",
    communityIntro:
      "Gekennzeichnete Importe, wiederkehrende Themen und verantwortete interne Entwürfe.",
    studio: "Content Studio",
    search: "Inhalte durchsuchen",
    format: "Format",
    allFormats: "Alle Formate",
    channels: "Kanäle",
    caption: "Inhalte: eine Zeile je Beitrag, darin seine Kanalversionen",
    showReplaced: (n: number) => `Ersetzte Versionen anzeigen (${n})`,
    replaced: "Ersetzt",
    variants: (n: number) => `${n} Kanäle`,
    expand: (title: string) => `Kanäle von ${title} anzeigen`,
    open: (title: string) => `${title} öffnen`,
    openColumn: "Öffnen",
  },
  approvals: {
    open: "Offene Aktionen",
    openIntro:
      "Was auf eine Entscheidung wartet: Entwürfe zum Freigeben oder Prüfen, Ausnahmen und gestoppte Posts.",
    openEmpty: "Nichts wartet auf dich.",
    openContent: "Inhalte zum Prüfen",
    openContentIntro:
      "Inhalte, die noch eine Prüfung brauchen. Öffne sie, um sie zu prüfen, abzulehnen oder zu verwerfen.",
    reviewed: "Geprüft, nicht eingeplant",
    reviewedIntro:
      "Geprüfte Inhalte, die noch keine Veröffentlichung und kein Postiz-Entwurf hält.",
    released: "Freigegeben & geplant",
    releasedIntro:
      "Freigegebene Posts mit ihrem Termin. Sie brauchen keine Entscheidung mehr; einen anstehenden kannst du noch stoppen.",
    releasedEmpty: "Nichts ist freigegeben oder geplant.",
    history: "Verlauf",
    historyIntro:
      "Veröffentlichte, ersetzte, abgelehnte und archivierte Inhalte.",
    historyNewest: (n: number) => `Die ${n} neuesten werden gezeigt.`,
    decisions: "Entscheidungen zu Auftragsentwürfen",
    decisionsIntro: "Was der Owner in den letzten 30 Tagen entschieden hat.",
    cleanup: "Aufräumen",
    cleanupHint:
      "„Alte Entwürfe archivieren“ archiviert alle Entwürfe hier, an denen nichts mehr hängt (kein geplanter Post, keine offene Übergabe, Entscheidung oder laufender Auftrag); du siehst vorher jeden Entwurf und kannst es rückgängig machen.",
    expired: "Abgelaufene Entwürfe",
    expiredIntro:
      "Ihr Termin ist vorbei und wird nicht nachgeholt: lehne sie ab oder archiviere sie – oder archiviere alle alten Entwürfe auf einmal.",
    releasedByYou: (date: string) => `Von dir freigegeben am ${date}`,
    releasedByOwner: (date: string) => `Von einem Owner freigegeben am ${date}`,
    releasedByAgent: "Vom Review-Agenten nach dem Veto-Fenster freigegeben",
    scheduled: "Eingeplant",
    heldInSocial: "In Social angekündigt; geht zum Termin raus",
    postizDraft: "Als Entwurf an Postiz übergeben",
    openInSocial: "In Social öffnen",
    slot: (time: string) => `Termin ${time}`,
    focused: "Das ist der Post, den du aus Social geöffnet hast.",
    focusMissing:
      "Der aus Social geöffnete Post steht hier nicht mehr; vielleicht ist er im Verlauf.",
  },
};

export const marketingText = (locale: Locale): MarketingText =>
  locale === "de" ? de : en;

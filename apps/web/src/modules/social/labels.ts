import type { SocialApproval } from "./api";

// The social module's texts (English and German). The design system's tone:
// short, factual, no invented figures.

const en = {
  module: "Social",
  intro: "Social accounts, posts and the publishing calendar of this project.",
  nav: {
    overview: "Overview",
    calendar: "Calendar",
    posts: "Posts",
    media: "Media",
    accounts: "Accounts",
    analytics: "Analytics",
  },
  approvalTitle: "Approval",
  approval: {
    owner_each: "The owner approves every post before it is scheduled or published.",
    editor_each: "Editors with approval rights approve posts before they are scheduled or published.",
  } satisfies Record<SocialApproval, string>,
  later: "Coming in a later phase",
  laterBody: "This part of the social module is being built. Nothing is published from here yet.",
};
export type SocialText = typeof en;

const de: SocialText = {
  module: "Social Media",
  intro: "Social-Media-Konten, Beiträge und der Veröffentlichungskalender dieses Projekts.",
  nav: {
    overview: "Übersicht",
    calendar: "Kalender",
    posts: "Beiträge",
    media: "Medien",
    accounts: "Konten",
    analytics: "Auswertung",
  },
  approvalTitle: "Freigabe",
  approval: {
    owner_each: "Der Owner gibt jeden Beitrag frei, bevor er geplant oder veröffentlicht wird.",
    editor_each: "Editoren mit Freigaberecht geben Beiträge frei, bevor sie geplant oder veröffentlicht werden.",
  },
  later: "Folgt in einer späteren Phase",
  laterBody: "Dieser Teil des Social-Media-Moduls entsteht gerade. Von hier wird noch nichts veröffentlicht.",
};

export const socialText = (locale: "en" | "de"): SocialText => (locale === "de" ? de : en);

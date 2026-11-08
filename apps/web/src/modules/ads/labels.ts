// The ads module's texts (English and German). Short, factual, no invented
// figures.

const en = {
  module: "Ads",
  intro: "Paid advertising of this project: campaigns, creatives and performance.",
  nav: {
    overview: "Overview",
    campaigns: "Campaigns",
    units: "Ads",
    creatives: "Creatives",
    performance: "Performance",
    accounts: "Accounts",
  },
  deciderTitle: "Spend decisions",
  decider: "Spend decisions: owner only",
  noAccountTitle: "No ad account connected yet",
  noAccountBody: "Connect an ad account to see campaigns and performance here.",
  later: "Coming in a later phase",
  laterBody: "This part of the ads module is being built. Nothing is spent from here yet.",
};
export type AdsText = typeof en;

const de: AdsText = {
  module: "Werbung",
  intro: "Bezahlte Werbung dieses Projekts: Kampagnen, Werbemittel und Performance.",
  nav: {
    overview: "Übersicht",
    campaigns: "Kampagnen",
    units: "Anzeigen",
    creatives: "Werbemittel",
    performance: "Performance & Analytics",
    accounts: "Konten & Verbindungen",
  },
  deciderTitle: "Ausgaben",
  decider: "Ausgaben entscheidet nur der Owner",
  noAccountTitle: "Noch kein Werbekonto verbunden",
  noAccountBody: "Verbinde ein Werbekonto, um hier Kampagnen und Performance zu sehen.",
  later: "Folgt in einer späteren Phase",
  laterBody: "Dieser Teil des Werbemoduls entsteht gerade. Von hier wird noch nichts ausgegeben.",
};

export const adsText = (locale: "en" | "de"): AdsText => (locale === "de" ? de : en);

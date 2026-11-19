import type { CmsSettings } from "./api";

// The content module's texts (English and German). Short and factual.

const en = {
  module: "Content",
  intro: "Website content of this project: articles, their versions, SEO and publication.",
  nav: { overview: "Overview" },
  approversTitle: "Publication approvals",
  approvers: {
    owner: "Publishing and updates are approved by the owner.",
    owner_or_editor: "Publishing and updates are approved by the owner or a content editor.",
  } as Record<CmsSettings["publishApprovers"], string>,
  fourEyes: "The person who asks for a publication cannot approve it.",
  emptyTitle: "No content yet",
  emptyBody: "Articles, the editor and websites follow in the next steps of the rollout.",
  attention: {
    open: "Open content",
    stopped: (n: number) => (n === 1 ? "1 publication stopped and needs a person" : `${n} publications stopped and need a person`),
    liveCheck: (n: number) => (n === 1 ? "1 website does not show the published version yet" : `${n} published versions are not shown on their website yet`),
  },
};

const de: typeof en = {
  module: "Inhalte",
  intro: "Website-Inhalte dieses Projekts: Artikel, ihre Versionen, SEO und Veröffentlichung.",
  nav: { overview: "Übersicht" },
  approversTitle: "Freigabe von Veröffentlichungen",
  approvers: {
    owner: "Veröffentlichungen und Aktualisierungen gibt der Owner frei.",
    owner_or_editor: "Veröffentlichungen und Aktualisierungen geben der Owner oder ein Content-Editor frei.",
  },
  fourEyes: "Wer eine Veröffentlichung anfordert, kann sie nicht selbst freigeben.",
  emptyTitle: "Noch keine Inhalte",
  emptyBody: "Artikel, Editor und Websites folgen in den nächsten Schritten der Einführung.",
  attention: {
    open: "Inhalte öffnen",
    stopped: (n: number) => (n === 1 ? "1 Veröffentlichung wurde angehalten und braucht eine Person" : `${n} Veröffentlichungen wurden angehalten und brauchen eine Person`),
    liveCheck: (n: number) => (n === 1 ? "1 Website zeigt die veröffentlichte Version noch nicht" : `${n} veröffentlichte Versionen erscheinen noch nicht auf ihrer Website`),
  },
};

export const cmsText = (locale: "en" | "de") => (locale === "de" ? de : en);

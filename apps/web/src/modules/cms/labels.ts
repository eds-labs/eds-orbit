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
};

export const cmsText = (locale: "en" | "de") => (locale === "de" ? de : en);

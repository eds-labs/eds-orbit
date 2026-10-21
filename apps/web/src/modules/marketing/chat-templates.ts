import type { ChatExtension } from "@/platform/assistant/extensions";

export const marketingTemplates: NonNullable<ChatExtension["templates"]> = ({
  projectName,
  de,
  canEdit,
  features,
}) => {
  const legacy = de
    ? [
        {
          label: "Nächste Woche planen",
          prompt: `Plane für ${projectName} Content-Entwürfe für die nächste Woche. Nutze nur bestätigte Fakten und freigegebene Assets. Nenne Zeitraum, Zielgruppe, Zielaktion, Kanäle, Umfang, Quellen und Kostenrahmen. Frage gezielt nach fehlenden Angaben. Erstelle erst nach meiner Bestätigung eine Mission; veröffentliche nichts.`,
        },
        {
          label: "Webseite analysieren",
          prompt: `Analysiere die bereits in Orbit importierten Webseiten- und Knowledge-Quellen für ${projectName}. Nenne belegte Stärken, Lücken und konkrete nächste Schritte mit Quellen. Falls keine aktuellen abrufbaren Website-Passagen vorliegen, sage das klar; starte keinen Live-Crawl.`,
        },
        {
          label: "Blogbeitrag vorbereiten",
          prompt: `Bereite einen Blogbeitrag für ${projectName} als prüfbaren Entwurf vor. Verwende nur verifizierte Fakten und zitierbare Quellen. Frage nach Thema, Zielgruppe und Zielaktion, falls sie fehlen. Veröffentliche nichts.`,
        },
        {
          label: "Blocker prüfen",
          prompt: `Welche Freigaben und Voraussetzungen blockieren gerade die nächsten Content-Entwürfe und eine spätere Veröffentlichung für ${projectName}? Nenne die konkreten nächsten Schritte.`,
        },
      ]
    : [
        {
          label: "Plan next week",
          prompt: `Plan content drafts for ${projectName} next week using verified facts and approved assets. Show period, audience, action, channels, scope, sources, and cost ceiling. Ask for missing details. Create a mission only after my confirmation; publish nothing.`,
        },
        {
          label: "Analyze website",
          prompt: `Analyze the website and knowledge sources already imported into Orbit for ${projectName}. Cite strengths, gaps, and next steps. If no current retrievable website passages exist, say so; do not start a live crawl.`,
        },
        {
          label: "Prepare blog post",
          prompt: `Prepare a reviewable blog draft for ${projectName} using verified facts and cited sources. Ask for topic, audience, and target action if missing. Publish nothing.`,
        },
        {
          label: "Check blockers",
          prompt: `What approvals and prerequisites block the next drafts and later publication for ${projectName}? Give specific next steps.`,
        },
      ];

  if (!features.agents) return legacy;
  const plan = canEdit
    ? {
        label: de ? "Marketing planen" : "Plan marketing",
        prompt: de
          ? `Entwirf einen Marketingplan für ${projectName}. Kläre Ziel, Zielgruppe, Zeitraum, Kanäle, Takt, Budget und Quellen. Nutze bestätigte Fakten und freigegebene Assets. Schlage human_each vor: Jeder Beitrag braucht meine ausdrückliche Freigabe vor einer externen Übergabe. Lege einen prüfbaren Strategieentwurf vor. Starte keine Aufträge und veröffentliche nichts.`
          : `Propose a marketing plan for ${projectName}. Clarify goal, audience, horizon, channels, cadence, budget and sources. Use verified facts and approved assets. Propose human_each: each post needs my explicit approval before external handoff. Prepare a reviewable strategy proposal. Start no assignments and publish nothing.`,
      }
    : {
        label: de ? "Marketingstatus prüfen" : "Check marketing status",
        prompt: de
          ? `Zeige den aktuellen Stand der gespeicherten Marketingpläne für ${projectName}, offene Freigaben und vorhandene Berichte. Lies nur gespeicherte Daten; starte keine Arbeit und ändere nichts.`
          : `Show saved marketing plan status, pending approvals and available reports for ${projectName}. Read stored data only; start no work and change nothing.`,
      };
  return [plan, ...legacy.slice(1)];
};

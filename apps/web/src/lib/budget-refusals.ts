// Why a paid AI call was refused, named by the budget layer that stopped it
// (plans/ai-central-management.md, phase C). Codes come from `reserve` and
// the module caps; anything else stays a code.

const texts: Record<string, { en: string; de: string }> = {
  POLICY_REQUIRED: {
    en: "No AI spending authority for this project (Settings → AI & budget).",
    de: "Keine KI-Ausgabefreigabe für dieses Projekt (Einstellungen → KI & Budget).",
  },
  PAID_MANDATE_EXPIRED: {
    en: "The project's AI spending authority has expired.",
    de: "Die KI-Ausgabefreigabe des Projekts ist abgelaufen.",
  },
  BUDGET_NOT_APPROVED: {
    en: "Paid AI is not allowed for this project, or the call is larger than its limit per run.",
    de: "Bezahlte KI ist für dieses Projekt nicht erlaubt, oder der Aufruf ist größer als die Grenze pro Lauf.",
  },
  BUDGET_EXCEEDED: {
    en: "The project's AI budget for today or this month is used up.",
    de: "Das KI-Budget des Projekts für heute oder diesen Monat ist aufgebraucht.",
  },
  RUN_BUDGET_EXCEEDED: {
    en: "The project's limit per run is reached.",
    de: "Die Grenze pro Lauf des Projekts ist erreicht.",
  },
  PROVIDER_BUDGET_STOP: {
    en: "The project's provider budget reached its stop threshold.",
    de: "Das Anbieterbudget des Projekts hat seine Stopp-Schwelle erreicht.",
  },
  SUPPORT_AI_BUDGET_EXCEEDED: {
    en: "Support's daily AI limit is reached (Support settings).",
    de: "Das tägliche KI-Limit von Support ist erreicht (Support-Einstellungen).",
  },
  GRANT_BUDGET_EXCEEDED: {
    en: "The monthly budget of the connection granted to this project is used up.",
    de: "Das Monatsbudget der Verbindung, die diesem Projekt zugeteilt ist, ist aufgebraucht.",
  },
  ORGANIZATION_BUDGET_EXCEEDED: {
    en: "The organization's monthly budget on this connection is used up.",
    de: "Das Monatsbudget der Organisation auf dieser Verbindung ist aufgebraucht.",
  },
  CONNECTION_BUDGET_EXCEEDED: {
    en: "The connection's monthly budget is used up (administration).",
    de: "Das Monatsbudget der Verbindung ist aufgebraucht (Administration).",
  },
  ORG_AI_BUDGET_EXCEEDED: {
    en: "The organization's monthly AI budget is used up.",
    de: "Das KI-Monatsbudget der Organisation ist aufgebraucht.",
  },
  ORG_PROVIDER_BUDGET_EXCEEDED: {
    en: "The organization's cap for this provider is reached.",
    de: "Die Obergrenze der Organisation für diesen Anbieter ist erreicht.",
  },
};

/** The refusal as a sentence, or null for a code that is no budget refusal. */
export function budgetRefusalText(code: string | null | undefined, de: boolean) {
  if (!code) return null;
  return texts[code.replaceAll(" ", "_")]?.[de ? "de" : "en"] ?? null;
}

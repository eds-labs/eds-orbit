import { budgetRefusalText } from "@/lib/budget-refusals";

// Readable texts for the codes a chat turn or request can end with
// (plan agent-platform-phase-3 §2.7): every CHAT_* code of the runner, the
// personal assistant's refusals and the budget layer's. [English, German].
const texts: Record<string, [string, string]> = {
  PROJECT_PAUSED: [
    "The project is paused; Orbit answers again once it is resumed under Operations.",
    "Das Projekt ist pausiert; Orbit antwortet erst wieder, wenn es unter Betrieb fortgesetzt wird.",
  ],
  CHAT_FAILED: [
    "Orbit could not finish this answer. Please try again.",
    "Orbit konnte diese Antwort nicht abschließen. Bitte versuche es erneut.",
  ],
  CHAT_CANCELED: ["The answer was canceled.", "Die Antwort wurde abgebrochen."],
  CHAT_RUN_IN_PROGRESS: [
    "Orbit is still answering in this conversation. Wait for the answer or cancel it.",
    "Orbit antwortet in dieser Unterhaltung noch. Warte auf die Antwort oder brich sie ab.",
  ],
  CHAT_TOOL_LIMIT: [
    "Orbit needed more steps than one answer allows. Ask a narrower question or split the task.",
    "Orbit brauchte mehr Schritte, als eine Antwort erlaubt. Stelle eine engere Frage oder teile die Aufgabe auf.",
  ],
  CHAT_MAX_TOOL_CALLS: [
    "Orbit reached the limit of tool calls for one answer. Ask a narrower question.",
    "Orbit hat die Grenze der Werkzeugaufrufe für eine Antwort erreicht. Stelle eine engere Frage.",
  ],
  CHAT_MAX_MODEL_CALLS: [
    "Orbit reached the limit of model calls for one answer. Ask a narrower question.",
    "Orbit hat die Grenze der Modellaufrufe für eine Antwort erreicht. Stelle eine engere Frage.",
  ],
  CHAT_MAX_INPUT_BYTES: [
    "The conversation is too long for one more answer. Start a new conversation.",
    "Die Unterhaltung ist für eine weitere Antwort zu lang. Beginne eine neue Unterhaltung.",
  ],
  CHAT_CONTEXT_LIMIT: [
    "The conversation is too long for one more answer. Start a new conversation.",
    "Die Unterhaltung ist für eine weitere Antwort zu lang. Beginne eine neue Unterhaltung.",
  ],
  CHAT_MAX_OUTPUT_CHARS: [
    "The answer became longer than allowed. Ask for a shorter answer or one part at a time.",
    "Die Antwort wurde länger als erlaubt. Bitte um eine kürzere Antwort oder einen Teil nach dem anderen.",
  ],
  CHAT_OUTPUT_LIMIT: [
    "The answer became longer than allowed. Ask for a shorter answer or one part at a time.",
    "Die Antwort wurde länger als erlaubt. Bitte um eine kürzere Antwort oder einen Teil nach dem anderen.",
  ],
  CHAT_MODEL_OUTPUT_LIMIT: [
    "The model stopped at its output limit. Ask for a shorter answer.",
    "Das Modell hat an seiner Ausgabegrenze aufgehört. Bitte um eine kürzere Antwort.",
  ],
  CHAT_MODEL_INCOMPLETE: [
    "The model returned an incomplete answer. Please try again.",
    "Das Modell hat eine unvollständige Antwort geliefert. Bitte versuche es erneut.",
  ],
  CHAT_MODEL_FAILED: [
    "The AI provider did not answer. Please try again later.",
    "Der KI-Anbieter hat nicht geantwortet. Bitte versuche es später erneut.",
  ],
  CHAT_MODEL_CONTENT_FILTER: [
    "The AI provider's content filter stopped this answer. Rephrase the request.",
    "Der Inhaltsfilter des KI-Anbieters hat diese Antwort gestoppt. Formuliere die Anfrage anders.",
  ],
  CHAT_OUTCOME_UNKNOWN: [
    "It is unclear whether the last step finished. Check the result before you repeat it.",
    "Es ist unklar, ob der letzte Schritt abgeschlossen wurde. Prüfe das Ergebnis, bevor du ihn wiederholst.",
  ],
  CHAT_TOOL_NOT_ALLOWED: [
    "Orbit tried a tool that is not available here.",
    "Orbit hat ein Werkzeug versucht, das hier nicht verfügbar ist.",
  ],
  CHAT_TOOL_RESULT_LIMIT: [
    "A tool returned more data than one answer can use. Ask a narrower question.",
    "Ein Werkzeug lieferte mehr Daten, als eine Antwort verwenden kann. Stelle eine engere Frage.",
  ],
  CHAT_EVIDENCE_CHANGED: [
    "A source changed while Orbit was answering. Please ask again.",
    "Eine Quelle hat sich geändert, während Orbit geantwortet hat. Bitte frage erneut.",
  ],
  CHAT_ROUTE_CHANGED: [
    "The AI configuration changed during the answer. Please ask again.",
    "Die KI-Konfiguration hat sich während der Antwort geändert. Bitte frage erneut.",
  ],
  CHAT_PROPOSAL_COST_EXCEEDED: [
    "The proposal would cost more than its approved ceiling.",
    "Der Vorschlag würde mehr kosten als seine freigegebene Obergrenze.",
  ],
  CHAT_PROPOSAL_IMMUTABLE: [
    "This proposal can no longer be changed.",
    "Dieser Vorschlag kann nicht mehr geändert werden.",
  ],
  CHAT_PUBLISHING_FORBIDDEN: [
    "Orbit Chat cannot publish. Use the approvals instead.",
    "Orbit Chat kann nicht veröffentlichen. Nutze dafür die Freigaben.",
  ],
  // The personal assistant (ADR 0022).
  ASSISTANT_DISABLED: [
    "The personal assistant is not available.",
    "Der persönliche Assistent ist nicht verfügbar.",
  ],
  ASSISTANT_DISABLED_FOR_MEMBER: [
    "Your organization has not enabled the assistant for you.",
    "Deine Organisation hat den Assistenten für dich nicht freigeschaltet.",
  ],
  ASSISTANT_ENTITLEMENT: [
    "The assistant is not included for this organization.",
    "Der Assistent ist für diese Organisation nicht enthalten.",
  ],
  PROJECT_FORBIDDEN: [
    "You have no access to this project.",
    "Du hast keinen Zugriff auf dieses Projekt.",
  ],
  MODULE_DISABLED: [
    "The module is not switched on in this project, or you have no access to it.",
    "Das Modul ist in diesem Projekt nicht eingeschaltet, oder du hast keinen Zugriff darauf.",
  ],
  PERMISSION_DENIED: [
    "Your role does not allow this.",
    "Deine Rolle erlaubt das nicht.",
  ],
  CROSS_PROJECT_CONTEXT: [
    "This proposal used data from another project, so it needs your explicit approval.",
    "Dieser Vorschlag hat Daten aus einem anderen Projekt verwendet und braucht deshalb deine ausdrückliche Freigabe.",
  ],
  PERSONAL_CONTEXT_NOT_ALLOWED: [
    "This cannot be remembered: it looks like personal data of others, a secret, or health or financial details.",
    "Das kann nicht gemerkt werden: Es sieht nach personenbezogenen Daten anderer, einem Geheimnis oder Gesundheits- oder Finanzangaben aus.",
  ],
  PERSONAL_SPACE_SPEND_READ_ONLY: [
    "The assistant's budget is set by your organization and cannot be changed here.",
    "Das Budget des Assistenten legt deine Organisation fest; es kann hier nicht geändert werden.",
  ],
  AI_BUDGET_EXCEEDED: [
    "The AI budget for this is used up.",
    "Das KI-Budget dafür ist aufgebraucht.",
  ],
};

/**
 * Budget codes read differently in the personal space (D-09): it is paid
 * only from the organization's per-member assistant cap, never from a
 * project budget, and only organization owners set that cap.
 */
const personalTexts: Record<string, [string, string]> = {
  POLICY_REQUIRED: [
    "The organization's personal assistant budget is not set. Project budgets do not fund the personal assistant; only organization owners set this budget.",
    "Persönliches Assistentenbudget der Organisation nicht gesetzt. Projektbudgets gelten nicht für den persönlichen Assistenten; nur Organisations-Owner legen dieses Budget fest.",
  ],
  BUDGET_NOT_APPROVED: [
    "The organization's assistant budget per member is 0, or its limit per answer (a tenth of the monthly cap, at most USD 2) is too small for this answer. Only organization owners can change it.",
    "Das Assistentenbudget pro Mitglied der Organisation ist 0, oder seine Grenze pro Antwort (ein Zehntel des Monatsbudgets, höchstens 2 USD) ist für diese Antwort zu klein. Nur Organisations-Owner können es ändern.",
  ],
  PAID_MANDATE_EXPIRED: [
    "The organization's assistant budget is not active right now. Only organization owners can change it.",
    "Das Assistentenbudget der Organisation ist gerade nicht aktiv. Nur Organisations-Owner können es ändern.",
  ],
  BUDGET_EXCEEDED: [
    "Your assistant budget for today or this month is used up.",
    "Dein Assistenten-Budget für heute oder diesen Monat ist aufgebraucht.",
  ],
  RUN_BUDGET_EXCEEDED: [
    "This answer reached the assistant's limit per run.",
    "Diese Antwort hat die Grenze des Assistenten pro Lauf erreicht.",
  ],
  AI_BUDGET_EXCEEDED: [
    "Your monthly assistant budget is used up.",
    "Dein monatliches Assistenten-Budget ist aufgebraucht.",
  ],
};

const AI_BUDGET = /AI_BUDGET_(EXCEEDED|EXHAUSTED)$/;

/**
 * A code as a sentence the user can act on. ApiError messages carry the code
 * with spaces ("PROJECT PAUSED"); both spellings are accepted. Unknown codes
 * stay as they are, so nothing is hidden.
 */
export function chatErrorText(
  code: string | null,
  de: boolean,
  personal = false,
) {
  if (!code) return "—";
  const key = code.trim().replaceAll(" ", "_");
  const index = de ? 1 : 0;
  const budget = AI_BUDGET.test(key) ? "AI_BUDGET_EXCEEDED" : key;
  return (
    (personal ? personalTexts[key]?.[index] : undefined) ??
    texts[key]?.[index] ??
    budgetRefusalText(key, de) ??
    (personal ? personalTexts[budget]?.[index] : undefined) ??
    texts[budget]?.[index] ??
    code
  );
}

/** The readable text of a caught request error. */
export function chatErrorOf(cause: unknown, de: boolean, personal = false) {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return chatErrorText(code, de, personal);
  }
  return cause instanceof Error
    ? chatErrorText(cause.message, de, personal)
    : de
      ? "Anfrage fehlgeschlagen"
      : "Request failed";
}

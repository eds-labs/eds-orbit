// Texts of the agent pages (ADR 0021, WP1.8). German terms per D-13:
// "Agenten" for agents, "Ausführungen" for work orders.
import type { Locale } from "@/lib/i18n";
import type {
  AgentMode,
  AgentStatus,
  Bilingual,
  CatalogRefusal,
  WorkOrderStatus,
} from "./types";

const pick = (text: Bilingual, locale: Locale) => text[locale];

/**
 * Readable texts for every error code the agent routes and work orders end
 * with (plan §5, plus the codes of the work-order host). Unknown codes get
 * a generic sentence with the code, never nothing.
 */
const ERRORS: Readonly<Record<string, Bilingual>> = {
  AGENT_NOT_FOUND: {
    en: "This agent does not exist or you cannot see it (you need read access in every module it uses).",
    de: "Diesen Agenten gibt es nicht oder du kannst ihn nicht sehen (dafür brauchst du Lesezugriff in jedem seiner Module).",
  },
  AGENT_NOT_ACTIVE: {
    en: "The agent is not active. Activate or resume it first.",
    de: "Der Agent ist nicht aktiv. Aktiviere ihn oder setze ihn zuerst fort.",
  },
  AGENT_VERSION_CHANGED: {
    en: "The agent changed since you opened it. Reload and review the current draft before activating.",
    de: "Der Agent wurde geändert, seit du ihn geöffnet hast. Lade neu und prüfe den aktuellen Entwurf vor der Aktivierung.",
  },
  AGENT_CONFIG_INVALID: {
    en: "The configuration is incomplete or invalid. Check names, modules, tools, triggers, limits and budget.",
    de: "Die Konfiguration ist unvollständig oder ungültig. Prüfe Name, Module, Tools, Auslöser, Grenzen und Budget.",
  },
  AGENT_TOOL_NOT_GRANTABLE: {
    en: "A selected tool cannot be granted: you do not hold it yourself, or its module is not selected.",
    de: "Ein gewähltes Tool kann nicht vergeben werden: Du hast es selbst nicht, oder sein Modul ist nicht gewählt.",
  },
  AGENT_TEMPLATE_RULE: {
    en: "The configuration breaks a rule of its template (a required or forbidden tool, or a mode above the template's limit).",
    de: "Die Konfiguration verletzt eine Regel ihrer Vorlage (ein Pflicht- oder verbotenes Tool oder ein Modus über der Grenze der Vorlage).",
  },
  AGENT_PRINCIPAL_FORBIDDEN: {
    en: "The person this agent acts for no longer holds the needed rights (sponsor or requester).",
    de: "Die Person, für die der Agent handelt, hat die nötigen Rechte nicht mehr (Sponsor oder Auftraggeber).",
  },
  AGENT_BUDGET_EXHAUSTED: {
    en: "The agent's monthly budget is used up. It runs again next month or after an owner raises the ceiling.",
    de: "Das Monatsbudget des Agenten ist aufgebraucht. Er läuft im nächsten Monat wieder oder wenn ein Owner die Obergrenze anhebt.",
  },
  AGENT_BUDGET_EXCEEDS_PROJECT: {
    en: "The monthly ceilings of the active agents together would exceed the project's AI spending limit.",
    de: "Die Monatsobergrenzen der aktiven Agenten würden zusammen das KI-Ausgabenlimit des Projekts überschreiten.",
  },
  AGENT_RUN_LIMIT: {
    en: "The agent has used its runs for today.",
    de: "Der Agent hat seine Ausführungen für heute aufgebraucht.",
  },
  AGENT_RUN_CEILING: {
    en: "The execution reached its cost ceiling and stopped.",
    de: "Die Ausführung hat ihre Kostenobergrenze erreicht und wurde gestoppt.",
  },
  AGENT_CONCURRENCY_LIMIT: {
    en: "Too many executions are running at once. It waits for a free slot.",
    de: "Es laufen zu viele Ausführungen gleichzeitig. Sie wartet auf einen freien Platz.",
  },
  AGENT_DELEGATION_DEPTH: {
    en: "Agents may hand work on at most two levels deep.",
    de: "Agenten dürfen Arbeit höchstens zwei Ebenen tief weitergeben.",
  },
  AGENT_DELEGATION_CYCLE: {
    en: "An agent cannot hand work back to itself or to an agent above it.",
    de: "Ein Agent kann Arbeit nicht an sich selbst oder an einen übergeordneten Agenten zurückgeben.",
  },
  AGENT_DELEGATION_FANOUT: {
    en: "An execution may start at most ten sub-executions.",
    de: "Eine Ausführung darf höchstens zehn Unterausführungen starten.",
  },
  AGENT_ENTITLEMENT: {
    en: "This installation's plan does not include this (agent count, trigger kind, module or model).",
    de: "Der Plan dieser Installation enthält das nicht (Anzahl Agenten, Auslöserart, Modul oder Modell).",
  },
  AGENT_ROUTE_UNAVAILABLE: {
    en: "The chosen model is not available (only verified models can be chosen).",
    de: "Das gewählte Modell ist nicht verfügbar (nur verifizierte Modelle sind wählbar).",
  },
  AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA: {
    en: "The AI provider is not allowed for the personal or financial data this agent's tools handle.",
    de: "Der KI-Anbieter ist für die personenbezogenen oder Finanzdaten der Tools dieses Agenten nicht zugelassen.",
  },
  AGENT_OUTPUT_INVALID: {
    en: "The model's answer did not match the expected result format.",
    de: "Die Antwort des Modells passte nicht zum erwarteten Ergebnisformat.",
  },
  AGENT_LIMIT: {
    en: "The execution reached a limit (model calls, tool calls or time).",
    de: "Die Ausführung hat eine Grenze erreicht (Modellaufrufe, Tool-Aufrufe oder Zeit).",
  },
  AGENT_TRIGGER_DISABLED: {
    en: "This agent cannot be started that way: the trigger is not configured or automation is off.",
    de: "Dieser Agent kann so nicht gestartet werden: Der Auslöser ist nicht eingerichtet oder die Automatisierung ist aus.",
  },
  AGENT_PLATFORM_DISABLED: {
    en: "Agents are switched off in this installation.",
    de: "Agenten sind in dieser Installation ausgeschaltet.",
  },
  AGENT_CANCELED: {
    en: "The execution was canceled.",
    de: "Die Ausführung wurde abgebrochen.",
  },
  AGENT_STATUS_INVALID: {
    en: "This action is not possible in the agent's current status.",
    de: "Diese Aktion ist im aktuellen Status des Agenten nicht möglich.",
  },
  AGENT_WORK_ORDER_OPEN: {
    en: "The execution is still open; retry once it has ended.",
    de: "Die Ausführung läuft noch; wiederhole sie, wenn sie beendet ist.",
  },
  AGENT_OUTCOME_UNKNOWN: {
    en: "The outcome is unclear (for example a model call whose cost is unknown). Check before retrying.",
    de: "Der Ausgang ist unklar (zum Beispiel ein Modellaufruf mit unbekannten Kosten). Prüfe das vor einer Wiederholung.",
  },
  AGENT_TOOL_NOT_ALLOWED: {
    en: "The model asked for a tool the agent was not given.",
    de: "Das Modell wollte ein Tool nutzen, das der Agent nicht hat.",
  },
  AGENT_FAILED: {
    en: "The execution failed.",
    de: "Die Ausführung ist fehlgeschlagen.",
  },
  VERSION_CONFLICT: {
    en: "Someone else changed this agent. Reload and try again.",
    de: "Jemand anderes hat diesen Agenten geändert. Lade neu und versuche es erneut.",
  },
  OWNER_REQUIRED: {
    en: "Only project owners can do this.",
    de: "Nur Projekt-Owner können das.",
  },
  FORBIDDEN: {
    en: "You do not have permission for this.",
    de: "Dafür hast du keine Berechtigung.",
  },
  NOT_FOUND: {
    en: "Not found, or agents are switched off in this installation.",
    de: "Nicht gefunden, oder Agenten sind in dieser Installation ausgeschaltet.",
  },
};

/** The codes with their own readable text. */
export const AGENT_ERROR_CODES = Object.keys(ERRORS);

/** A readable sentence for an error code; unknown codes keep their code. */
export function agentErrorText(code: string, locale: Locale): string {
  const known = ERRORS[code];
  if (known) return pick(known, locale);
  return locale === "de"
    ? `Die Aktion ist fehlgeschlagen (${code}).`
    : `The action failed (${code}).`;
}

const REFUSALS: Readonly<Record<CatalogRefusal, Bilingual>> = {
  MODULE_DISABLED: {
    en: "Its module is switched off in this project.",
    de: "Sein Modul ist in diesem Projekt ausgeschaltet.",
  },
  MODULE_NOT_AVAILABLE: {
    en: "You have no access to its module.",
    de: "Du hast keinen Zugriff auf sein Modul.",
  },
  ROLE_INSUFFICIENT: {
    en: "Your role does not include this tool, so you cannot grant it.",
    de: "Deine Rolle umfasst dieses Tool nicht, daher kannst du es nicht vergeben.",
  },
  FEATURE_OFF: {
    en: "The feature behind this tool is switched off.",
    de: "Die Funktion hinter diesem Tool ist ausgeschaltet.",
  },
};

export function refusalText(
  reason: CatalogRefusal | undefined,
  locale: Locale,
) {
  return reason
    ? pick(REFUSALS[reason], locale)
    : locale === "de"
      ? "Nicht vergebbar."
      : "Not grantable.";
}

const STATUS: Readonly<Record<AgentStatus, Bilingual>> = {
  draft: { en: "Draft", de: "Entwurf" },
  active: { en: "Active", de: "Aktiv" },
  paused: { en: "Paused", de: "Pausiert" },
  disabled: { en: "Disabled", de: "Deaktiviert" },
  budget_exhausted: { en: "Budget used up", de: "Budget aufgebraucht" },
};
export const agentStatusText = (status: AgentStatus, locale: Locale) =>
  STATUS[status] ? pick(STATUS[status], locale) : status;

const WORK_STATUS: Readonly<Record<WorkOrderStatus, Bilingual>> = {
  queued: { en: "Queued", de: "Eingereiht" },
  awaiting_start: { en: "Waiting to start", de: "Wartet auf Start" },
  running: { en: "Running", de: "Läuft" },
  waiting_approval: { en: "Waiting for approval", de: "Wartet auf Freigabe" },
  succeeded: { en: "Succeeded", de: "Erfolgreich" },
  failed: { en: "Failed", de: "Fehlgeschlagen" },
  blocked: { en: "Blocked", de: "Blockiert" },
  canceled: { en: "Canceled", de: "Abgebrochen" },
  outcome_unknown: { en: "Outcome unclear", de: "Ausgang unklar" },
};
export const WORK_ORDER_STATUSES = Object.keys(
  WORK_STATUS,
) as WorkOrderStatus[];
export const workStatusText = (status: WorkOrderStatus, locale: Locale) =>
  WORK_STATUS[status] ? pick(WORK_STATUS[status], locale) : status;

/** Badge tone of a status: never the only signal, the text is always shown. */
export function statusTone(
  status: string,
): "neutral" | "success" | "warning" | "danger" | "blue" {
  if (status === "active" || status === "succeeded") return "success";
  if (
    ["failed", "blocked", "budget_exhausted", "outcome_unknown"].includes(
      status,
    )
  )
    return "danger";
  if (
    ["draft", "paused", "waiting_approval", "awaiting_start"].includes(status)
  )
    return "warning";
  if (status === "running" || status === "queued") return "blue";
  return "neutral";
}

const MODES: Readonly<
  Record<AgentMode, { label: Bilingual; hint: Bilingual }>
> = {
  read: {
    label: { en: "Read only", de: "Nur lesen" },
    hint: {
      en: "Reads and reports; changes nothing.",
      de: "Liest und berichtet; ändert nichts.",
    },
  },
  draft: {
    label: { en: "Draft", de: "Entwürfe" },
    hint: {
      en: "May create internal drafts; every external effect is a proposal for a person to decide.",
      de: "Darf interne Entwürfe anlegen; jede Wirkung nach außen ist ein Vorschlag, über den ein Mensch entscheidet.",
    },
  },
  execute: {
    label: { en: "Execute", de: "Ausführen" },
    hint: {
      en: "May also run internal actions. Proposals still need a decision unless an agent permission covers them.",
      de: "Darf auch interne Aktionen ausführen. Vorschläge brauchen weiter eine Entscheidung, sofern keine Agentenberechtigung sie abdeckt.",
    },
  },
};
export const modeText = (mode: AgentMode, locale: Locale) =>
  pick(MODES[mode].label, locale);
export const modeHint = (mode: AgentMode, locale: Locale) =>
  pick(MODES[mode].hint, locale);

const RISKS: Readonly<Record<string, Bilingual>> = {
  R0_read: { en: "Reads", de: "Liest" },
  W0_internal: { en: "Internal change", de: "Interne Änderung" },
  P_proposal: { en: "Proposal", de: "Vorschlag" },
  unknown: { en: "Unknown", de: "Unbekannt" },
};
export const riskText = (risk: string, locale: Locale) =>
  RISKS[risk] ? pick(RISKS[risk], locale) : risk;

const DATA_CLASSES: Readonly<Record<string, Bilingual>> = {
  internal: { en: "Internal data", de: "Interne Daten" },
  customer_personal: {
    en: "Personal customer data",
    de: "Personenbezogene Kundendaten",
  },
  financial: { en: "Financial data", de: "Finanzdaten" },
};
export const dataClassText = (dataClass: string, locale: Locale) =>
  DATA_CLASSES[dataClass] ? pick(DATA_CLASSES[dataClass], locale) : dataClass;

const ORIGINS: Readonly<Record<string, Bilingual>> = {
  manual: { en: "Started by hand", de: "Von Hand gestartet" },
  schedule: { en: "Schedule", de: "Zeitplan" },
  event: { en: "Event", de: "Ereignis" },
  assistant: { en: "Orbit Assistant", de: "Orbit-Assistent" },
  agent: { en: "Another agent", de: "Anderer Agent" },
  mcp: { en: "Connected app (MCP)", de: "Verbundene App (MCP)" },
};
export const originText = (origin: string, locale: Locale) =>
  ORIGINS[origin] ? pick(ORIGINS[origin], locale) : origin;

/** ISO weekday 1 (Monday) to 7 (Sunday). */
export const weekdayText = (day: number, locale: Locale) =>
  (locale === "de"
    ? ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])[day - 1] ??
  String(day);

/** Field names of the configuration, for the review diff. */
const FIELDS: Readonly<Record<string, Bilingual>> = {
  name: { en: "Name", de: "Name" },
  description: { en: "Description", de: "Beschreibung" },
  templateKey: { en: "Template", de: "Vorlage" },
  instructions: { en: "Instructions", de: "Anweisungen" },
  modules: { en: "Modules", de: "Module" },
  tools: { en: "Tools", de: "Tools" },
  knowledge: { en: "Knowledge", de: "Wissen" },
  mode: { en: "Autonomy", de: "Autonomie" },
  model: { en: "Model", de: "Modell" },
  limits: { en: "Limits", de: "Grenzen" },
  budget: { en: "Budget", de: "Budget" },
  triggers: { en: "Triggers", de: "Auslöser" },
  delegateTo: { en: "Hands work to", de: "Gibt Arbeit an" },
  outputs: { en: "Notifications", de: "Benachrichtigungen" },
};
export const fieldText = (field: string, locale: Locale) =>
  FIELDS[field] ? pick(FIELDS[field], locale) : field;

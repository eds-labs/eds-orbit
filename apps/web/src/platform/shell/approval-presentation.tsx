"use client";
import { usd } from "@/lib/api";
import { Badge } from "@/components/ui/primitives";

// How the approvals inbox explains a request (Approval UX v2): a readable
// title, what approving does (inside Orbit, paid, external, public,
// governance), why it waits for a person, when it expires, and the technical
// facts only in a collapsed diagnostics area. Module renderers keep their own
// content; this frames every request the same way.

export type Effect =
  | "internal"
  | "paid"
  | "external"
  | "public"
  | "deletion"
  | "governance";

export type Presentation = {
  module: string;
  effect: Effect;
  internal: boolean;
  mandatable: boolean;
};

type Text = { en: string; de: string };

const TITLES: Record<string, Text> = {
  "image.generate": { en: "Generate image", de: "Bild erzeugen" },
  "content.schedule": { en: "Schedule post", de: "Beitrag terminieren" },
  "content_package.start": {
    en: "Prepare content package",
    de: "Inhaltspaket vorbereiten",
  },
  "platform.task.start": {
    en: "Start an assistant work order",
    de: "Arbeitsauftrag für den Assistenten starten",
  },
  "platform.mcp.project_configuration_update": {
    en: "Change project configuration",
    de: "Projektkonfiguration ändern",
  },
  "platform.mcp.ai_spend_policy_update": {
    en: "Change AI spending authority",
    de: "KI-Ausgabenrahmen ändern",
  },
  "platform.mcp.ai_models_update": {
    en: "Change AI models",
    de: "KI-Modelle ändern",
  },
  "marketing.mcp.marketing_create_campaign": {
    en: "Create campaign draft",
    de: "Kampagnenentwurf anlegen",
  },
  "marketing.mcp.marketing_update_campaign": {
    en: "Update campaign draft",
    de: "Kampagnenentwurf ändern",
  },
  "marketing.mcp.marketing_request_image": {
    en: "Request a generated image",
    de: "KI-Bild anfordern",
  },
  "marketing.mcp.marketing_schedule_content": {
    en: "Schedule content",
    de: "Inhalt terminieren",
  },
  "marketing.mcp.marketing_prepare_package": {
    en: "Prepare content package",
    de: "Inhaltspaket vorbereiten",
  },
  "marketing.mcp.marketing_creative_preview_create": {
    en: "Create internal creative preview",
    de: "Interne Creative-Vorschau erstellen",
  },
  "marketing.mcp.marketing_policy_update": {
    en: "Change publishing rules",
    de: "Veröffentlichungsregeln ändern",
  },
  "marketing.mcp.integrations_configure": {
    en: "Change Postiz integration",
    de: "Postiz-Anbindung ändern",
  },
  "knowledge.mcp.knowledge_add_source": {
    en: "Add knowledge source",
    de: "Wissensquelle hinzufügen",
  },
  "knowledge.mcp.knowledge_add_document": {
    en: "Add document to knowledge",
    de: "Dokument zum Wissen hinzufügen",
  },
  "knowledge.mcp.knowledge_import_url": {
    en: "Import web page into knowledge",
    de: "Webseite ins Wissen importieren",
  },
  "knowledge.mcp.knowledge_propose_fact": {
    en: "Propose fact",
    de: "Fakt vorschlagen",
  },
  "knowledge.mcp.knowledge_verify_fact": {
    en: "Verify fact",
    de: "Fakt bestätigen",
  },
  "knowledge.mcp.knowledge_withdraw_fact": {
    en: "Withdraw fact",
    de: "Fakt zurückziehen",
  },
  "knowledge.mcp.knowledge_evaluate": {
    en: "Evaluate knowledge search",
    de: "Wissenssuche bewerten",
  },
  "finance.mcp.finance_retry_extraction": {
    en: "Read document again",
    de: "Beleg erneut auslesen",
  },
};

/** Lower-case words of an operation name without its module prefix. */
function words(actionType: string) {
  const name = actionType.split(".").at(-1) ?? actionType;
  const plain = name.replace(/^(marketing|support|knowledge|finance|work|issues|platform)_/u, "");
  const text = plain.replace(/[_.]+/gu, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : actionType;
}

/** A readable title for any action type; never the raw identifier. */
export function approvalTitle(actionType: string, de: boolean) {
  const known = TITLES[actionType];
  return known ? (de ? known.de : known.en) : words(actionType);
}

const MODULES: Record<string, Text> = {
  platform: { en: "Orbit", de: "Orbit" },
  marketing: { en: "Marketing", de: "Marketing" },
  support: { en: "Support", de: "Support" },
  knowledge: { en: "Knowledge", de: "Wissen" },
  finance: { en: "Finance", de: "Finanzen" },
  work: { en: "Projects", de: "Projektmanagement" },
  issues: { en: "Issues", de: "Issues" },
};
export function moduleLabel(module: string, de: boolean) {
  const known = MODULES[module];
  return known ? (de ? known.de : known.en) : module;
}

const EFFECTS: Record<
  Effect,
  {
    tone: "neutral" | "warning" | "danger" | "blue";
    label: Text;
    reason: Text;
  }
> = {
  internal: {
    tone: "neutral",
    label: { en: "Inside Orbit", de: "Nur in Orbit" },
    reason: {
      en: "It changes data in Orbit only.",
      de: "Ändert nur Daten in Orbit.",
    },
  },
  paid: {
    tone: "blue",
    label: { en: "Paid AI, inside Orbit", de: "Kostenpflichtige KI, nur in Orbit" },
    reason: {
      en: "It spends AI budget up to the amount shown. Nothing leaves Orbit.",
      de: "Verbraucht KI-Budget bis zum angezeigten Betrag. Nichts verlässt Orbit.",
    },
  },
  external: {
    tone: "warning",
    label: { en: "Leaves Orbit", de: "Verlässt Orbit" },
    reason: {
      en: "It sends or writes something outside Orbit (for example to a customer or another service). Every such action needs your decision.",
      de: "Sendet oder schreibt etwas außerhalb von Orbit (etwa an einen Kunden oder einen anderen Dienst). Jede solche Aktion braucht deine Entscheidung.",
    },
  },
  public: {
    tone: "danger",
    label: { en: "Public", de: "Öffentlich" },
    reason: {
      en: "It publishes or schedules public content. Every post needs its own approval of exactly this content.",
      de: "Veröffentlicht oder terminiert öffentliche Inhalte. Jeder Beitrag braucht eine eigene Freigabe genau dieses Inhalts.",
    },
  },
  deletion: {
    tone: "danger",
    label: { en: "Deletes", de: "Löscht" },
    reason: {
      en: "It deletes data. Deletions always need your decision.",
      de: "Löscht Daten. Löschungen brauchen immer deine Entscheidung.",
    },
  },
  governance: {
    tone: "warning",
    label: { en: "Rules and budget", de: "Regeln und Budget" },
    reason: {
      en: "It changes rules, budgets or integrations. Such changes always need an owner's decision.",
      de: "Ändert Regeln, Budgets oder Anbindungen. Solche Änderungen brauchen immer die Entscheidung eines Inhabers.",
    },
  },
};

/** "in 3 h", "in 2 days", "expired": how long the request can still be decided. */
export function expiresIn(iso: string, de: boolean, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return de ? "abgelaufen" : "expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return de ? `in ${minutes} Min.` : `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return de ? `in ${hours} Std.` : `in ${hours} h`;
  const days = Math.round(hours / 24);
  return de ? `in ${days} Tagen` : `in ${days} days`;
}

type Item = {
  id: string;
  version: number;
  actionType: string;
  riskClass?: string;
  packageHash: string;
  costCeilingMicros: number;
  expiresAt: string;
  requestedBy: { kind: string; userId: string; clientId?: string };
  presentation?: Presentation;
};

/**
 * The frame line of every request: module, effect badge, why it waits,
 * the cost limit (when there is one) and the remaining time.
 */
export function ApprovalContext({
  item,
  de,
  isOwner,
}: {
  item: Item;
  de: boolean;
  isOwner?: boolean;
}) {
  const p = item.presentation;
  if (!p) return null;
  const effect = EFFECTS[p.effect] ?? EFFECTS.internal;
  return (
    <div className="approval-context">
      <p className="approval-context-badges">
        <Badge tone="neutral">{moduleLabel(p.module, de)}</Badge>{" "}
        <Badge tone={effect.tone}>{de ? effect.label.de : effect.label.en}</Badge>
        {item.costCeilingMicros > 0 && (
          <>
            {" "}
            <Badge tone="blue">
              {de ? "höchstens" : "at most"} {usd(item.costCeilingMicros)}
            </Badge>
          </>
        )}{" "}
        <span className="chat-package-note">
          {de ? "Entscheidung möglich" : "Can be decided"}{" "}
          <time dateTime={item.expiresAt} title={item.expiresAt}>
            {expiresIn(item.expiresAt, de)}
          </time>
        </span>
      </p>
      <p className="chat-package-note">{de ? effect.reason.de : effect.reason.en}</p>
      {p.mandatable && (
        <p className="chat-package-note">
          {de
            ? "Keine Agentenberechtigung deckt diese Anfrage ab."
            : "No agent permission covers this request."}
          {isOwner &&
            (de
              ? " Du kannst Agenten diese Aktion innerhalb fester Grenzen ohne Einzelfreigabe erlauben: Einstellungen → KI & Budget → Agentenberechtigungen."
              : " You can let agents do this within fixed limits without a decision each time: Settings → AI & budget → Agent permissions.")}
        </p>
      )}
    </div>
  );
}

/** The technical facts, collapsed: identifiers an owner rarely needs. */
export function ApprovalDiagnostics({
  item,
  de,
  operation,
}: {
  item: Item;
  de: boolean;
  operation?: unknown;
}) {
  return (
    <details className="approval-diagnostics">
      <summary>{de ? "Technische Details" : "Technical details"}</summary>
      <dl>
        <dt>{de ? "Aktionstyp" : "Action type"}</dt>
        <dd>
          <code>{item.actionType}</code>
        </dd>
        {item.riskClass && (
          <>
            <dt>{de ? "Risikoklasse" : "Risk class"}</dt>
            <dd>
              <code>{item.riskClass}</code>
            </dd>
          </>
        )}
        <dt>{de ? "Anfrage" : "Request"}</dt>
        <dd>
          <code>
            {item.id} · v{item.version}
          </code>
        </dd>
        <dt>{de ? "Inhalts-Hash" : "Content hash"}</dt>
        <dd>
          <code>{item.packageHash}</code>
        </dd>
        <dt>{de ? "Angefragt von" : "Requested by"}</dt>
        <dd>
          <code>
            {item.requestedBy.kind}
            {item.requestedBy.clientId ? ` · ${item.requestedBy.clientId}` : ""}
          </code>
        </dd>
      </dl>
      {operation !== undefined && (
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {JSON.stringify(operation, null, 2)}
        </pre>
      )}
    </details>
  );
}

const HIDDEN_FIELDS = new Set(["approvalContext", "idempotencyKey"]);

/** A readable label for an argument name: `maxBudgetMicros` → "Max budget". */
function fieldLabel(key: string) {
  const plain = key
    .replace(/Micros$/u, "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/_/gu, " ")
    .toLowerCase();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}
function fieldValue(key: string, value: unknown): string {
  if (typeof value === "number" && /Micros$/u.test(key)) return usd(value);
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return value.join(", ");
  return JSON.stringify(value);
}

/** The proposed operation's arguments as labelled values, not raw JSON. */
export function OperationFields({ operation }: { operation: Record<string, unknown> }) {
  const entries = Object.entries(operation).filter(
    ([key, value]) => !HIDDEN_FIELDS.has(key) && value !== undefined && value !== null,
  );
  if (!entries.length) return null;
  return (
    <dl className="approval-fields">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>{fieldValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

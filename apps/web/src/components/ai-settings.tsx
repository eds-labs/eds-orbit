"use client";
import { useMemo, useState } from "react";
import { Brain, Coins, Gauge, Sparkles } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  usd,
  when,
} from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal, Status } from "./ui/primitives";
import { DataForm, str, type FormField } from "@/platform/ui/form";
import { Metric } from "@/platform/ui/metric";
import { useWorkspace } from "./workspace-context";

// Settings → AI (plan D-A9): the project's AI providers, the models they
// serve, the Anthropic credit budget and the usage and costs. The OpenAI
// modal (keys, verified models, routes, tiers, rate card, images) moved here
// from management.tsx unchanged; the Claude modal and the budget form save
// the provider fields through `ai-provider-configure`.

type ProviderId = "openai" | "anthropic";
type ProviderBudgetView = {
  monthlyMicros: number;
  warnMicros: number;
  warn2Micros: number;
  stopMicros: number;
  anchorDay: number;
  credit?: { amountMicros: number; verifiedAt: string; note?: string };
};
type ProviderFields = {
  defaultProvider: ProviderId;
  anthropicTierRoutes: {
    fast: string;
    standard: string;
    quality: string;
  } | null;
  models: Record<
    string,
    {
      provider: ProviderId;
      displayName?: string;
      capabilities?: string[];
      note?: string;
    }
  >;
  providerBudgets: Partial<Record<ProviderId, ProviderBudgetView>>;
  fallback: { onProviderBudgetStop: "none" | "openai" };
  providers: Record<
    ProviderId,
    {
      keyConfigured: boolean;
      source: "orbit" | "connection" | "environment" | "none";
    }
  >;
  suggestions: {
    anthropic: {
      verifiedAt: string;
      sources: string[];
      rateCard: Record<string, Rate>;
      models: ProviderFields["models"];
      tiers: { fast: string; standard: string; quality: string };
      routes: Record<string, string>;
    };
  };
};
type Rate = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedInputMicrosPerMillion?: number;
  cacheWriteMicrosPerMillion?: number;
  webSearchMicrosPerCall?: number;
  verifiedAt: string;
};
type AiBudgetView = {
  // OpenAI's budget is reported since phase 3.4; older servers omit it.
  providers: Record<"anthropic", ProviderBudgetState> &
    Partial<Record<"openai", ProviderBudgetState>>;
};
type ProviderBudgetState = {
      configured: boolean;
      budget: ProviderBudgetView | null;
      level: "ok" | "warn" | "warn2" | "stopped" | null;
      spend: {
        spentMicros: string;
        settledMicros: string;
        pendingMicros: string;
        unknownMicros: string;
        count: number;
        periodStart: string;
        periodEnd: string;
      } | null;
      creditSync: "manual";
};
/** One row of `/ai-cost`; `reservedMicros` includes reservations in flight. */
type CostRow = {
  key: string | null;
  reservedMicros: string;
  settledMicros: string;
  unknownMicros: string;
  count: number;
};

const providerName: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
};
// Where the key a call would use comes from (the API's effective status).
type KeySourceName = ProviderFields["providers"][ProviderId]["source"];
const sourceName: Record<"en" | "de", Record<KeySourceName, string>> = {
  en: {
    orbit: "project",
    connection: "granted connection",
    environment: "environment",
    none: "none",
  },
  de: {
    orbit: "Projekt",
    connection: "zugeteilte Verbindung",
    environment: "Umgebung",
    none: "keine",
  },
};
/**
 * Text, search and images as the project can use them now: Claude alone
 * covers text; semantic search and image generation need an OpenAI key.
 */
function CapabilityRows({
  capabilities,
  de,
}: {
  capabilities: NonNullable<OpenAiConfigurationView["capabilities"]>;
  de: boolean;
}) {
  const rows = [
    {
      key: "text",
      label: de ? "Text (Chat, Entwürfe, Support, Finanzen)" : "Text (chat, drafts, Support, Finance)",
      ready: capabilities.text,
      detail: capabilities.text
        ? de
          ? "Bereit."
          : "Ready."
        : de
          ? "Braucht einen Key für den Anbieter der Routen."
          : "Needs a key for the provider of its routes.",
    },
    {
      key: "search",
      label: de ? "Wissenssuche" : "Knowledge search",
      ready: true,
      detail:
        capabilities.search === "semantic"
          ? de
            ? "Semantische Suche (Embeddings über OpenAI)."
            : "Semantic search (embeddings through OpenAI)."
          : de
            ? "Volltextsuche. Semantische Suche braucht einen OpenAI-Key; Anthropic bietet keine Embeddings."
            : "Full-text search. Semantic search needs an OpenAI key; Anthropic offers no embeddings.",
    },
    {
      key: "images",
      label: de ? "Bilderzeugung" : "Image generation",
      ready: capabilities.images,
      detail: capabilities.images
        ? de
          ? "Bereit."
          : "Ready."
        : de
          ? "Aus: braucht einen OpenAI-Key, ein geprüftes Bildmodell und einen aktuellen Preis."
          : "Off: needs an OpenAI key, a verified image model and a current price.",
    },
  ];
  return (
    <>
      {rows.map((row) => (
        <div className="data-row" key={row.key}>
          <div>
            <strong>{row.label}</strong>
            <p>{row.detail}</p>
          </div>
          <Status value={row.ready ? "ready" : "not_configured"} />
        </div>
      ))}
    </>
  );
}

const perMillion = (micros: number | undefined) =>
  micros === undefined
    ? "—"
    : `$${(micros / 1_000_000).toFixed(micros % 1_000_000 ? 3 : 2)}`;
const totalMicros = (rows: CostRow[] | undefined) =>
  (rows ?? []).reduce(
    (sum, row) =>
      sum +
      Number(row.settledMicros) +
      Number(row.reservedMicros) +
      Number(row.unknownMicros),
    0,
  );
const dayStart = (now: number) => {
  const d = new Date(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  ).toISOString();
};
const providerOf = (
  model: string,
  models: ProviderFields["models"],
): ProviderId =>
  models[model]?.provider ?? (/^claude-/i.test(model) ? "anthropic" : "openai");

/** The provider fields of a view as `ai-provider-configure` expects them (a full replace). */
function providerPayload(view: ProviderFields) {
  return {
    defaultProvider: view.defaultProvider,
    ...(view.anthropicTierRoutes
      ? { anthropicTierRoutes: view.anthropicTierRoutes }
      : {}),
    models: view.models,
    providerBudgets: view.providerBudgets,
    fallback: view.fallback,
  };
}

/** Keys, default provider, suggested models and tiers, fallback. */
function AnthropicConfiguration({
  view,
  onClose,
}: {
  view: OpenAiConfigurationView & ProviderFields;
  onClose: () => void;
}) {
  const { project, refresh, locale } = useWorkspace();
  const de = locale === "de";
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const suggestion = view.suggestions.anthropic;
  const tiers = view.anthropicTierRoutes ?? suggestion.tiers;
  const fields: FormField[] = [
    {
      name: "anthropicApiKey",
      label:
        view.providers.anthropic.source === "orbit"
          ? de
            ? "Anthropic API-Key (leer lassen, um den gespeicherten zu behalten)"
            : "Anthropic API key (leave blank to keep the current key)"
          : "Anthropic API key",
      type: "password",
      min: 20,
      max: 1000,
      hint: de
        ? "Serverseitig verschlüsselt, nie wieder angezeigt. Für die reguläre Claude API (api.anthropic.com), nicht für Claude Code."
        : "Encrypted server-side, never displayed again. For the regular Claude API (api.anthropic.com), not for Claude Code.",
    },
    ...(view.providers.anthropic.source === "orbit"
      ? [
          {
            name: "clearAnthropicApiKey",
            label: de
              ? "Gespeicherten Anthropic-Key vergessen"
              : "Forget the saved Anthropic key",
            type: "checkbox" as const,
            value: false,
          },
        ]
      : []),
    {
      name: "applyCatalog",
      heading: de ? "Modelle" : "Models",
      label: de
        ? `Vorgeschlagene Claude-Modelle, Preise (geprüft ${suggestion.verifiedAt.slice(0, 10)}) und Stufen übernehmen`
        : `Add the suggested Claude models, prices (verified ${suggestion.verifiedAt.slice(0, 10)}) and tiers`,
      type: "checkbox",
      value: !view.verifiedModels.some(
        (model) => providerOf(model, view.models) === "anthropic",
      ),
      hint: de
        ? `Trägt ${Object.keys(suggestion.models).join(", ")} in die verifizierten Modelle und die Preisliste ein. Quellen: ${suggestion.sources.join(" · ")}. Bestehende Preise bleiben.`
        : `Adds ${Object.keys(suggestion.models).join(", ")} to the verified models and the rate card. Sources: ${suggestion.sources.join(" · ")}. Existing prices stay.`,
    },
    {
      name: "tier-fast",
      heading: de
        ? "Claude-Stufen (Fallback ohne Aufgaben-Route)"
        : "Claude tiers (fallback without a task route)",
      label: de ? "Schnell (einfache Aufgaben)" : "Fast (simple tasks)",
      value: tiers.fast,
      required: true,
    },
    {
      name: "tier-standard",
      label: "Standard",
      value: tiers.standard,
      required: true,
    },
    {
      name: "tier-quality",
      label: de ? "Qualität (komplexe Analysen)" : "Quality (complex analyses)",
      value: tiers.quality,
      required: true,
    },
    {
      name: "defaultProvider",
      heading: de ? "Routing" : "Routing",
      label: de
        ? "Standardprovider für Aufgaben ohne explizite Route"
        : "Default provider for task classes without an explicit route",
      type: "select",
      value: view.defaultProvider,
      options: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic (Claude)" },
      ],
      hint: de
        ? "Explizite Aufgaben-Routen (OpenAI-Dialog) gewinnen immer. Bestehende Routen werden nicht überschrieben."
        : "Explicit task routes (OpenAI dialog) always win. Existing routes are not overwritten.",
    },
    {
      name: "fallback",
      label: de
        ? "Wenn das Claude-Budget gestoppt ist"
        : "When the Claude budget is stopped",
      type: "select",
      value: view.fallback.onProviderBudgetStop,
      options: [
        {
          value: "none",
          label: de
            ? "Aufruf ablehnen (Standard)"
            : "Refuse the call (default)",
        },
        {
          value: "openai",
          label: de
            ? "Kostenpflichtig auf die OpenAI-Stufe ausweichen"
            : "Fall back to the OpenAI tier (paid)",
        },
      ],
      hint: de
        ? "Das Ausweichen verursacht OpenAI-Kosten und gilt als deine ausdrückliche Freigabe. Ein bereits gesendeter Aufruf wird nie wiederholt."
        : "The fallback incurs OpenAI costs and counts as your explicit approval. A transmitted call is never retried.",
    },
  ];
  return (
    <Modal
      title={de ? "Claude konfigurieren" : "Configure Claude"}
      onClose={onClose}
    >
      <p className="panel-note">
        {view.providers.anthropic.keyConfigured
          ? de
            ? `Key konfiguriert über ${sourceName.de[view.providers.anthropic.source]}.`
            : `Key configured through ${sourceName.en[view.providers.anthropic.source]}.`
          : de
            ? "Noch kein Anthropic-Key gespeichert."
            : "No Anthropic key saved yet."}
      </p>
      <Alert>
        {de
          ? "Jede Speicherung erhöht die Routen-Version: laufende Jobs stoppen vor ihrem nächsten bezahlten Aufruf und müssen neu gestartet werden."
          : "Every save bumps the route version: runs in progress stop before their next paid call and must be started again."}
      </Alert>
      <DataForm
        key={view.updatedAt ?? "anthropic"}
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel={
          de ? "Claude-Einstellungen speichern" : "Save Claude settings"
        }
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(async () => {
            const apiKey = str(values, "anthropicApiKey");
            return action(project.id, "ai-provider-configure", {
              ...providerPayload(view),
              applyAnthropicCatalog: values.applyCatalog === true,
              ...(apiKey ? { anthropicApiKey: apiKey } : {}),
              ...(values.clearAnthropicApiKey === true
                ? { clearAnthropicApiKey: true }
                : {}),
              defaultProvider: str(values, "defaultProvider"),
              anthropicTierRoutes: {
                fast: str(values, "tier-fast"),
                standard: str(values, "tier-standard"),
                quality: str(values, "tier-quality"),
              },
              models: view.models,
              fallback: { onProviderBudgetStop: str(values, "fallback") },
            });
          })
        }
      />
    </Modal>
  );
}

/** The Anthropic credit budget: amounts, thresholds, billing period anchor and the verified credit note. */
function ProviderBudgetForm({
  provider,
  view,
  onSaved,
}: {
  provider: ProviderId;
  view: OpenAiConfigurationView & ProviderFields;
  onSaved: () => void;
}) {
  const { project, locale } = useWorkspace();
  const de = locale === "de";
  const mutation = useMutation(onSaved);
  const current = view.providerBudgets[provider];
  const name = providerName[provider];
  const usdField = (
    name: string,
    label: string,
    micros: number,
    hint?: string,
  ): FormField => ({
    name,
    label,
    type: "number",
    min: 0,
    max: 100000,
    step: "0.01",
    value: micros / 1_000_000,
    required: true,
    ...(hint ? { hint } : {}),
  });
  const fields: FormField[] = [
    usdField(
      "monthly",
      de
        ? "Guthaben pro Abrechnungszeitraum (USD)"
        : "Credit per billing period (USD)",
      current?.monthlyMicros ?? 100_000_000,
    ),
    usdField(
      "warn",
      de ? "Erste Warnschwelle (USD)" : "First warning threshold (USD)",
      current?.warnMicros ?? 75_000_000,
    ),
    usdField(
      "warn2",
      de ? "Zweite Warnschwelle (USD)" : "Second warning threshold (USD)",
      current?.warn2Micros ?? 90_000_000,
    ),
    usdField(
      "stop",
      de ? "Interner Ausgabenstopp (USD)" : "Internal spending stop (USD)",
      current?.stopMicros ?? 95_000_000,
      de
        ? `Ab diesem berechneten Verbrauch lehnt Orbit weitere ${name}-Aufrufe ab; parallele Aufrufe werden nacheinander geprüft.`
        : `From this calculated spend Orbit refuses further ${name} calls; parallel calls are checked one after the other.`,
    ),
    {
      name: "anchorDay",
      label: de
        ? "Tag im Monat, an dem der Abrechnungszeitraum beginnt (UTC)"
        : "Day of the month the billing period starts (UTC)",
      type: "number",
      min: 1,
      max: 28,
      step: "1",
      value: current?.anchorDay ?? 1,
      required: true,
      hint: de
        ? `Der Tag, an dem ${name} das Guthaben erneuert, nicht automatisch der 1.`
        : `The day ${name} renews the credit, not necessarily the 1st.`,
    },
    {
      name: "creditAmount",
      heading: de ? "Guthabenstand (manuell)" : "Credit balance (manual)",
      label: de
        ? `Verbleibendes Guthaben laut ${name}-Konsole (USD, leer = unbekannt)`
        : `Remaining credit per the ${name} console (USD, blank = unknown)`,
      type: "number",
      min: 0,
      max: 100000,
      step: "0.01",
      value: current?.credit ? current.credit.amountMicros / 1_000_000 : "",
      hint: de
        ? "Orbit liest das Guthaben nicht beim Anbieter ab. Dieser Wert erscheint als manuell geprüft neben dem eigenen berechneten Verbrauch."
        : "Orbit does not read the credit from the provider. This value is shown as manually verified next to its own calculated spend.",
    },
    {
      name: "creditNote",
      label: de ? "Notiz" : "Note",
      value: current?.credit?.note ?? "",
      max: 200,
    },
  ];
  return (
    <DataForm
      key={`${provider}:${view.updatedAt ?? "budget"}`}
      fields={fields}
      pending={mutation.pending}
      error={mutation.error}
      submitLabel={de ? `${name}-Budget speichern` : `Save ${name} budget`}
      onSubmit={(values) =>
        mutation.run(() => {
          const micros = (key: string) =>
            Math.round(Number(values[key]) * 1_000_000);
          const creditAmount = str(values, "creditAmount");
          return action(project.id, "ai-provider-configure", {
            ...providerPayload(view),
            providerBudgets: {
              ...view.providerBudgets,
              [provider]: {
                monthlyMicros: micros("monthly"),
                warnMicros: micros("warn"),
                warn2Micros: micros("warn2"),
                stopMicros: micros("stop"),
                anchorDay: Number(values.anchorDay) || 1,
                ...(creditAmount
                  ? {
                      credit: {
                        amountMicros: micros("creditAmount"),
                        verifiedAt: new Date().toISOString(),
                        ...(str(values, "creditNote")
                          ? { note: str(values, "creditNote") }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
          });
        })
      }
    />
  );
}

/**
 * One provider's credit budget: spend, period, the manually verified credit
 * and the form (phase 3.4: OpenAI as well as Claude).
 */
function ProviderBudgetPanel({
  provider,
  entry,
  view,
  onSaved,
}: {
  provider: ProviderId;
  entry: ProviderBudgetState | undefined;
  view: (OpenAiConfigurationView & ProviderFields) | null | undefined;
  onSaved: () => void;
}) {
  const { locale } = useWorkspace();
  const de = locale === "de";
  const name = providerName[provider];
  const level = entry?.level ?? null;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{de ? `${name}: Budget` : `${name} budget`}</h2>
          <p>
            {de
              ? "Das monatliche API-Guthaben, zwei Warnschwellen und der interne Ausgabenstopp. Gilt pro Projekt; ohne eigenes Budget gilt das der Organisation oder des Systems, sonst keins."
              : "The monthly API credit, two warning thresholds and the internal spending stop. Per project; without one the organization's or the system's applies, else none."}
          </p>
        </div>
        {level && (
          <Status
            value={
              level === "ok"
                ? "active"
                : level === "stopped"
                  ? "blocked"
                  : "pending"
            }
          />
        )}
      </div>
      {entry?.configured && entry.spend && entry.budget && (
        <div className="metrics-strip metrics-four">
          <Metric
            icon={Gauge}
            label={de ? "Verbraucht (berechnet)" : "Spent (calculated)"}
            amount={usd(Number(entry.spend.spentMicros))}
            detail={`${de ? "von" : "of"} ${usd(entry.budget.stopMicros)} ${de ? "Stopp" : "stop"} · ${usd(entry.budget.monthlyMicros)} ${de ? "Guthaben" : "credit"}`}
          />
          <Metric
            icon={Coins}
            label={de ? "Davon abgerechnet" : "Settled"}
            amount={usd(Number(entry.spend.settledMicros))}
            detail={`${de ? "offen" : "pending"} ${usd(Number(entry.spend.pendingMicros))} · ${de ? "unklar" : "unclear"} ${usd(Number(entry.spend.unknownMicros))}`}
          />
          <Metric
            icon={Sparkles}
            label={de ? "Abrechnungszeitraum" : "Billing period"}
            amount={when(entry.spend.periodStart, locale).split(",")[0] ?? "—"}
            detail={`${de ? "bis" : "until"} ${when(entry.spend.periodEnd, locale)}`}
          />
          <Metric
            icon={Brain}
            label={de ? "Guthaben laut Konsole" : "Credit per console"}
            amount={
              entry.budget.credit ? usd(entry.budget.credit.amountMicros) : "—"
            }
            detail={
              entry.budget.credit
                ? `${de ? "manuell geprüft" : "manually verified"} ${when(entry.budget.credit.verifiedAt, locale)}`
                : de
                  ? "nicht live synchronisiert"
                  : "not synchronized live"
            }
          />
        </div>
      )}
      {view && (
        <ProviderBudgetForm provider={provider} view={view} onSaved={onSaved} />
      )}
    </section>
  );
}

function CostList({
  title,
  rows,
  labelOf,
}: {
  title: string;
  rows: CostRow[] | undefined;
  labelOf?: (key: string) => string;
}) {
  const { locale } = useWorkspace();
  const sorted = [...(rows ?? [])].sort(
    (a, b) => totalMicros([b]) - totalMicros([a]),
  );
  return (
    <div>
      <h3 className="usage-title">{title}</h3>
      {sorted.length ? (
        <ul className="checklist">
          {sorted.map((row) => (
            <li key={row.key ?? "none"}>
              <span className="checklist-dot" />
              {row.key === null
                ? locale === "de"
                  ? "ohne Zuordnung"
                  : "unattributed"
                : (labelOf?.(row.key) ?? row.key)}
              {": "}
              {usd(totalMicros([row]))}
              {Number(row.unknownMicros) > 0 && (
                <small>
                  {" "}
                  · {locale === "de" ? "unklar" : "unclear"}{" "}
                  {usd(Number(row.unknownMicros))}
                </small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-note">
          {locale === "de" ? "Keine Kosten." : "No cost."}
        </p>
      )}
    </div>
  );
}

export function AiSettings() {
  const { project, revision, isOwner, locale } = useWorkspace();
  const de = locale === "de";
  const configuration = useResource<OpenAiConfigurationView & ProviderFields>(
    collectionPath(project.id, `openai-configuration?revision=${revision}`),
  );
  const budget = useResource<AiBudgetView>(
    collectionPath(project.id, `ai-budget?revision=${revision}`),
  );
  const now = useMemo(() => Date.now(), [project.id, revision]);
  const costPath = (groupBy: string, from: string) =>
    collectionPath(
      project.id,
      `ai-cost?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(now).toISOString())}&groupBy=${groupBy}`,
    );
  const period = budget.data?.providers.anthropic.spend?.periodStart;
  const monthStart = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
  ).toISOString();
  const rangeStart = period ?? monthStart;
  const today = useResource<{ rows: CostRow[] }>(
    costPath("provider", dayStart(now)),
  );
  const byProvider = useResource<{ rows: CostRow[] }>(
    costPath("provider", rangeStart),
  );
  const byModel = useResource<{ rows: CostRow[] }>(
    costPath("model", rangeStart),
  );
  const byTask = useResource<{ rows: CostRow[] }>(
    costPath("taskClass", rangeStart),
  );
  const [openAi, setOpenAi] = useState(false);
  const [anthropic, setAnthropic] = useState(false);
  const view = configuration.data;
  const models = useMemo(() => {
    if (!view) return [];
    const ids = new Set([
      ...view.verifiedModels,
      ...Object.keys(view.rateCard),
      ...Object.keys(view.models),
    ]);
    return [...ids].sort().map((id) => {
      const provider = providerOf(id, view.models);
      const rate = view.rateCard[id];
      const usedBy = Object.entries(view.effectiveRoutes ?? {})
        .filter(
          ([, route]) => route && !("error" in route) && route.model === id,
        )
        .map(([taskClass]) => taskClass.replaceAll("_", " "));
      return {
        id,
        provider,
        rate,
        usedBy,
        enabled: view.verifiedModels.includes(id),
        entry: view.models[id],
      };
    });
  }, [view]);
  if (!isOwner)
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>{de ? "KI" : "AI"}</h2>
        </div>
        <p className="panel-note">
          {de
            ? "Nur Projekt-Owner verwalten die KI-Einstellungen."
            : "Only project owners manage the AI settings."}
        </p>
      </section>
    );
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "KI-Provider" : "AI providers"}</h2>
            <p>
              {de
                ? "Schlüssel liegen verschlüsselt auf dem Server. Bilderzeugung und semantische Suche (Embeddings) brauchen einen OpenAI-Key; Text läuft auch nur mit Claude."
                : "Keys are stored encrypted on the server. Image generation and semantic search (embeddings) need an OpenAI key; text also works with Claude alone."}
            </p>
          </div>
        </div>
        {configuration.loading && !view ? (
          <Loading />
        ) : view ? (
          <div className="capability-readiness">
            {view.capabilities && (
              <CapabilityRows capabilities={view.capabilities} de={de} />
            )}
            {view.routesWithoutKey?.length ? (
              <Alert kind="warning">
                {de
                  ? `Für diese Aufgaben fehlt der Key des gerouteten Anbieters, sie schlagen beim Aufruf fehl: ${view.routesWithoutKey.join(", ")}.`
                  : `These tasks are routed to a provider without a key and fail when called: ${view.routesWithoutKey.join(", ")}.`}
              </Alert>
            ) : null}
            {(["openai", "anthropic"] as const).map((id) => (
              <div className="data-row" key={id}>
                <div>
                  <strong>{providerName[id]}</strong>
                  <p>
                    {view.providers[id].keyConfigured
                      ? de
                        ? `Key konfiguriert (${sourceName.de[view.providers[id].source]})`
                        : `Key configured (${sourceName.en[view.providers[id].source]})`
                      : de
                        ? "Kein Key"
                        : "No key"}
                    {view.defaultProvider === id
                      ? de
                        ? " · Standardprovider"
                        : " · default provider"
                      : ""}
                    {id === "anthropic" &&
                    view.fallback.onProviderBudgetStop === "openai"
                      ? de
                        ? " · Fallback auf OpenAI erlaubt"
                        : " · fallback to OpenAI allowed"
                      : ""}
                  </p>
                </div>
                <Status
                  value={
                    view.providers[id].keyConfigured
                      ? "ready"
                      : "not_configured"
                  }
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    id === "openai" ? setOpenAi(true) : setAnthropic(true)
                  }
                >
                  <Brain data-icon="inline-start" />
                  {de ? "Konfigurieren" : "Configure"}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-note">{configuration.error?.message ?? "—"}</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "KI-Modelle" : "AI models"}</h2>
            <p>
              {de
                ? "Verifizierte Modelle mit Preisen und ihren Aufgaben. Routen und Preise bearbeitest du im OpenAI-Dialog; Claude-Vorschläge über „Claude konfigurieren“."
                : "Verified models with prices and their task classes. Edit routes and prices in the OpenAI dialog; Claude suggestions via “Configure Claude”."}
            </p>
          </div>
        </div>
        {models.length ? (
          <div className="capability-readiness">
            {models.map((model) => (
              <div className="data-row" key={model.id}>
                <div>
                  <strong>
                    {model.entry?.displayName
                      ? `${model.entry.displayName} · `
                      : ""}
                    {model.id}
                  </strong>
                  <p>
                    {providerName[model.provider]}
                    {" · "}
                    {model.rate
                      ? `${perMillion(model.rate.inputMicrosPerMillion)} / ${perMillion(model.rate.outputMicrosPerMillion)} ${de ? "pro Mio. Tokens (Eingabe / Ausgabe)" : "per MTok (input / output)"}${model.rate.cachedInputMicrosPerMillion !== undefined ? ` · cache ${perMillion(model.rate.cachedInputMicrosPerMillion)}` : ""}`
                      : de
                        ? "kein Preis"
                        : "no price"}
                    {model.usedBy.length
                      ? ` · ${de ? "Aufgaben" : "tasks"}: ${model.usedBy.join(", ")}`
                      : ""}
                  </p>
                </div>
                <Badge tone={model.enabled ? "success" : "neutral"}>
                  {model.enabled
                    ? de
                      ? "aktiv"
                      : "enabled"
                    : de
                      ? "inaktiv"
                      : "disabled"}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-note">
            {de ? "Noch keine Modelle verifiziert." : "No verified models yet."}
          </p>
        )}
      </section>

      {(["anthropic", "openai"] as const).map((provider) => (
        <ProviderBudgetPanel
          key={provider}
          provider={provider}
          entry={budget.data?.providers[provider]}
          view={view}
          onSaved={() => {
            configuration.refresh();
            budget.refresh();
          }}
        />
      ))}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "KI-Verbrauch & Kosten" : "AI usage & costs"}</h2>
            <p>
              {de
                ? "Orbits eigene Berechnung aus Reservierungen und abgerechneter Nutzung (USD). Keine Live-Daten des Providers."
                : "Orbit's own calculation from reservations and settled usage (USD). Not the provider's live data."}
            </p>
          </div>
        </div>
        <div className="metrics-strip">
          <Metric
            icon={Coins}
            label={de ? "Heute" : "Today"}
            amount={today.data ? usd(totalMicros(today.data.rows)) : "—"}
          />
          <Metric
            icon={Gauge}
            label={de ? "Dieser Abrechnungszeitraum" : "This billing period"}
            amount={
              byProvider.data ? usd(totalMicros(byProvider.data.rows)) : "—"
            }
            detail={
              period
                ? `${de ? "seit" : "since"} ${when(period, locale)}`
                : de
                  ? "seit Monatsbeginn (UTC)"
                  : "since the start of the month (UTC)"
            }
          />
          <Metric
            icon={Brain}
            label="Claude"
            amount={
              byProvider.data
                ? usd(
                    totalMicros(
                      byProvider.data.rows.filter(
                        (row) => row.key === "anthropic",
                      ),
                    ),
                  )
                : "—"
            }
            detail={
              byProvider.data
                ? `OpenAI ${usd(totalMicros(byProvider.data.rows.filter((row) => row.key === "openai")))}`
                : undefined
            }
          />
        </div>
        <div className="settings-grid">
          <CostList
            title={de ? "Nach Provider" : "By provider"}
            rows={byProvider.data?.rows}
            labelOf={(key) => providerName[key as ProviderId] ?? key}
          />
          <CostList
            title={de ? "Nach Modell" : "By model"}
            rows={byModel.data?.rows}
          />
          <CostList
            title={de ? "Nach Agent / Modul" : "By agent / module"}
            rows={byTask.data?.rows}
            labelOf={(key) => key.replaceAll("_", " ")}
          />
        </div>
        <p className="panel-note">
          {de
            ? "Kosten nach Projekt: diese Ansicht gilt für das gewählte Projekt; jedes Projekt reserviert und rechnet getrennt ab."
            : "Cost per project: this view is the selected project's; every project reserves and settles separately."}
        </p>
      </section>
      {openAi && (
        <OpenAiConfiguration
          onClose={() => {
            setOpenAi(false);
            configuration.refresh();
          }}
        />
      )}
      {anthropic && view && (
        <AnthropicConfiguration
          view={view}
          onClose={() => {
            setAnthropic(false);
            configuration.refresh();
            budget.refresh();
          }}
        />
      )}
    </>
  );
}

export type OpenAiConfigurationView = {
  configured: boolean;
  // Task classes routed to a provider without a usable key (effective view).
  routesWithoutKey?: string[];
  // What the project can do with its keys now (decisions E-8, E-9).
  capabilities?: {
    text: boolean;
    search: "semantic" | "full_text";
    images: boolean;
  };
  source: "orbit" | "environment" | "none";
  textKeyConfigured: boolean;
  imageKeyConfigured: boolean;
  dedicatedImageKeyConfigured: boolean;
  verifiedModels: string[];
  rateCard: Record<
    string,
    {
      inputMicrosPerMillion: number;
      outputMicrosPerMillion: number;
      cachedInputMicrosPerMillion?: number;
      cacheWriteMicrosPerMillion?: number;
      verifiedAt: string;
    }
  >;
  modelRoutes: {
    fast: string;
    standard: string;
    quality: string;
    escalation: string;
  };
  imageGeneration: {
    model: string;
    maxCostMicrosPerImage: number;
    pricingVerifiedAt?: string;
  };
  taskRoutes?: Partial<Record<TaskClass, StoredTaskRoute>>;
  effectiveRoutes?: Partial<
    Record<
      TaskClass,
      | (StoredTaskRoute & {
          price?: "current" | "missing";
          provider?: ProviderId;
        })
      | { error: "MODEL_CAPABILITY_NOT_VERIFIED" | "ROUTE_EFFORT_UNSUPPORTED" }
    >
  >;
  routeVersion?: number | null;
  updatedAt?: string;
};
const taskClasses = [
  { id: "chat_operator", label: "Chat operator", defaultTokens: 3000 },
  { id: "draft_social", label: "Social drafts", defaultTokens: 1800 },
  { id: "draft_blog", label: "Blog drafts", defaultTokens: 1800 },
  { id: "agent_strategy", label: "Agent strategy", defaultTokens: 3000 },
  { id: "agent_research", label: "Agent research", defaultTokens: 3000 },
  { id: "agent_analytics", label: "Agent analytics", defaultTokens: 1800 },
  { id: "agent_review", label: "Agent review", defaultTokens: 1800 },
  { id: "support_triage", label: "Support triage", defaultTokens: 800 },
  { id: "support_draft", label: "Support draft reply", defaultTokens: 1800 },
  { id: "finance_extraction", label: "Finance extraction", defaultTokens: 4000 },
] as const;
type TaskClass = (typeof taskClasses)[number]["id"];
const reasoningEffortValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type StoredTaskRoute = {
  model: string;
  reasoningEffort?: (typeof reasoningEffortValues)[number];
  maxOutputTokens: number;
};
function describeEffectiveRoute(
  route: NonNullable<OpenAiConfigurationView["effectiveRoutes"]>[TaskClass],
) {
  if (!route) return "Effective route: unknown.";
  if ("error" in route)
    return route.error === "ROUTE_EFFORT_UNSUPPORTED"
      ? 'Effective route: the effort "none" is not available on Claude models. Choose another effort or clear it.'
      : "Effective route: not verified. Add the model to the verified model IDs or clear the route.";
  const price =
    route.price === "missing"
      ? " No price for this model: runs are refused until the rate card has one."
      : "";
  return `Effective route: ${route.model}${route.provider ? ` (${route.provider})` : ""} · ${route.reasoningEffort ?? "default effort"} · ${route.maxOutputTokens} max tokens.${price}`;
}
export function OpenAiConfiguration({ onClose }: { onClose: () => void }) {
  const { project, refresh } = useWorkspace();
  const configuration = useResource<OpenAiConfigurationView>(
    collectionPath(project.id, "openai-configuration"),
  );
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const current = configuration.data;
  const fields: FormField[] = [
    {
      name: "apiKey",
      label:
        current?.source === "orbit"
          ? "OpenAI API key (leave blank to keep the current key)"
          : "Shared OpenAI API key (optional when an image key is entered)",
      type: "password",
      min: 20,
      max: 1000,
      hint: "Encrypted server-side. It is never displayed after saving.",
    },
    {
      name: "imageApiKey",
      label: current?.dedicatedImageKeyConfigured
        ? "Dedicated OpenAI image API key (leave blank to keep it)"
        : "Dedicated OpenAI image API key (optional)",
      type: "password",
      min: 20,
      max: 1000,
      hint: "Encrypted server-side. When blank, image generation uses the shared OpenAI key. A separate project key makes provider-side cost tracking easier.",
    },
    {
      name: "verifiedModels",
      label: "Verified model IDs (comma separated)",
      required: true,
      value: current?.verifiedModels.join(", ") ?? "",
      placeholder: "gpt-5.6-terra, text-embedding-3-small",
    },
    ...taskClasses.flatMap(({ id, label, defaultTokens }): FormField[] => {
      const stored = current?.taskRoutes?.[id];
      return [
        {
          name: `route-${id}-model`,
          heading: `${label} route`,
          label: `${label} model`,
          value: stored?.model ?? "",
          placeholder: "Leave empty to use the fallback tier",
          hint: describeEffectiveRoute(current?.effectiveRoutes?.[id]),
        },
        {
          name: `route-${id}-effort`,
          label: `${label} reasoning effort`,
          type: "select",
          value: stored?.reasoningEffort ?? "",
          options: [
            { value: "", label: "Default (not sent)" },
            ...reasoningEffortValues.map((value) => ({ value, label: value })),
          ],
        },
        {
          name: `route-${id}-max-tokens`,
          label: `${label} maximum output tokens`,
          type: "number",
          min: 256,
          max: 16000,
          step: "1",
          value: stored?.maxOutputTokens ?? defaultTokens,
          hint: "Used only when a model is entered (256 to 16000).",
        },
      ];
    }),
    ...(["fast", "standard", "quality", "escalation"] as const).map(
      (route, index): FormField => ({
        name: `model-${route}`,
        heading: index === 0 ? "Fallback tier models" : undefined,
        label: `${route.charAt(0).toUpperCase() + route.slice(1)} task model`,
        required: true,
        value: current?.modelRoutes?.[route] ?? "",
        hint:
          index === 0
            ? "Used by every task class that has no model entered above."
            : undefined,
      }),
    ),
    {
      name: "imageModel",
      label: "GPT Image 2.5 model",
      type: "select",
      value: current?.imageGeneration?.model || "gpt-image-2.5-flare",
      options: [
        {
          value: "gpt-image-2.5-flare",
          label: "GPT Image 2.5 Flare · fast generation",
        },
        {
          value: "gpt-image-2.5-sunburst",
          label: "GPT Image 2.5 Sunburst · precise editing",
        },
        {
          value: "gpt-image-2.5-flare-2026-09-08",
          label: "Flare · pinned 2026-09-08",
        },
        {
          value: "gpt-image-2.5-sunburst-2026-09-08",
          label: "Sunburst · pinned 2026-09-08",
        },
      ],
    },
    {
      name: "imageMaxCost",
      label: "Maximum reserved cost per image (USD; 0 disables)",
      type: "number",
      min: 0,
      max: 10,
      step: "0.001",
      value: (current?.imageGeneration?.maxCostMicrosPerImage || 0) / 1_000_000,
      required: true,
      hint: "This is a conservative per-image ceiling. Project daily, monthly and per-run budgets still apply.",
    },
    {
      name: "imagePricingVerifiedAt",
      label: "Image price ceiling verified at (ISO timestamp)",
      value: current?.imageGeneration?.pricingVerifiedAt || "",
      placeholder: "2026-09-19T12:00:00.000Z",
      hint: "Required when the per-image ceiling is above zero. Update it when the price changes.",
    },
    {
      name: "rateCard",
      label: "Current OpenAI rate card (JSON, USD micros per million tokens)",
      type: "textarea",
      required: true,
      value: JSON.stringify(current?.rateCard ?? {}, null, 2),
      hint: "Each model needs inputMicrosPerMillion, outputMicrosPerMillion and an ISO verifiedAt date. Optional: cachedInputMicrosPerMillion and cacheWriteMicrosPerMillion (defaults: input rate and 1.25x input).",
    },
  ];
  return (
    <Modal title="OpenAI configuration and model routes" onClose={onClose}>
      <p className="panel-note">
        {current?.configured
          ? `Configured through ${current.source}${current.updatedAt ? ` · updated ${when(current.updatedAt)}` : ""}.`
          : "No application OpenAI configuration is saved yet."}
        {current
          ? typeof current.routeVersion === "number"
            ? ` Route version ${current.routeVersion}.`
            : " Environment configuration."
          : ""}
        {current?.dedicatedImageKeyConfigured
          ? " A dedicated image key is active."
          : current?.imageKeyConfigured
            ? " Image generation uses the shared key."
            : " Image generation has no usable key."}
      </p>
      <Alert>
        A newly entered key replaces only its matching shared or image key for
        new work. Blank key fields keep saved keys. Existing budget,
        evidence-rights and policy checks still apply before any OpenAI call.
      </Alert>
      <DataForm
        key={current?.updatedAt ?? "openai-configuration-loading"}
        fields={fields}
        pending={mutation.pending || configuration.loading}
        error={mutation.error || configuration.error?.message}
        submitLabel="Save OpenAI configuration"
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() => {
            let rateCard: unknown;
            try {
              rateCard = JSON.parse(String(values.rateCard));
            } catch {
              throw new Error("RATE_CARD_JSON_INVALID");
            }
            const apiKey = String(values.apiKey).trim();
            const imageApiKey = String(values.imageApiKey).trim();
            return action(project.id, "openai-configure", {
              ...(apiKey ? { apiKey } : {}),
              ...(imageApiKey ? { imageApiKey } : {}),
              verifiedModels: String(values.verifiedModels)
                .split(",")
                .map((model) => model.trim())
                .filter(Boolean),
              rateCard,
              taskRoutes: Object.fromEntries(
                taskClasses.flatMap(({ id, defaultTokens }) => {
                  const model = String(values[`route-${id}-model`]).trim();
                  if (!model) return [];
                  const effort = String(values[`route-${id}-effort`]);
                  const maxOutputTokens =
                    Number(values[`route-${id}-max-tokens`]) || defaultTokens;
                  return [
                    [
                      id,
                      {
                        model,
                        ...(effort ? { reasoningEffort: effort } : {}),
                        maxOutputTokens,
                      },
                    ],
                  ];
                }),
              ),
              modelRoutes: {
                fast: String(values["model-fast"]),
                standard: String(values["model-standard"]),
                quality: String(values["model-quality"]),
                escalation: String(values["model-escalation"]),
              },
              imageGeneration: {
                model: String(values.imageModel),
                maxCostMicrosPerImage: Math.round(
                  Number(values.imageMaxCost) * 1_000_000,
                ),
                ...(String(values.imagePricingVerifiedAt).trim()
                  ? {
                      pricingVerifiedAt: new Date(
                        String(values.imagePricingVerifiedAt),
                      ).toISOString(),
                    }
                  : {}),
              },
            });
          })
        }
      />
    </Modal>
  );
}

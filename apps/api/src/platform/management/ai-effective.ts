import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  aiDefaultsSchema,
  imageModelSchema,
  taskClasses,
  type OpenAiRuntimeConfig,
  type ProviderBudget,
  type TaskClass,
} from "../../../../../packages/ai/src/index.ts";
import { TEXT_TASKS, textModelReady } from "../ai/openai-configuration.ts";
import {
  aiConfigurationState,
  projectAiExceptions,
  routingModeOf,
  type AiConfigurationState,
  type RoutingMode,
} from "../ai/effective-configuration.ts";

// The settings center's effective AI view of a project (phase 4): every value
// as the project saved it, as its calls use it now, and where that comes
// from, plus a readiness per provider. A pure mapping of aiConfigurationState,
// built field by field: never a key, a whole profile, a grant or a connection
// config. The origins follow the runtime's merge (withCentralAi in
// central-ai.ts, configuredRuntime and routedFields in
// openai-configuration.ts); nothing else decides an origin.

export type AiOrigin = "environment" | "system" | "organization" | "preset" | "project";
export type Traced<T> = { stored: T | null; effective: T | null; origin: AiOrigin | null };
export type TracedRoute = {
  stored: { model: string; reasoningEffort?: string; maxOutputTokens: number } | null;
  effective:
    | {
        model: string;
        reasoningEffort?: string;
        maxOutputTokens: number;
        provider: "openai" | "anthropic";
        price: "current" | "missing";
      }
    | { error: "MODEL_CAPABILITY_NOT_VERIFIED" | "ROUTE_EFFORT_UNSUPPORTED" };
  explicit: boolean;
  origin: AiOrigin | null;
};
export type KeyTrace = {
  /** The project saved its own key (for `image`: its own image key). */
  stored: boolean;
  /**
   * A call would have a key. Without a dedicated image key, image calls use
   * the OpenAI text key (`imageApiKey ?? apiKey`); `image` then reports that
   * key's origin and connection.
   */
  effective: boolean;
  origin: Exclude<AiOrigin, "preset"> | null;
  connection: { label: string; status: string; disabled: boolean } | null;
};
export type ReadinessReason =
  | "no_key"
  | "project_key_unverifiable"
  | "environment_key_unverifiable"
  | "connection_not_checked"
  | "connection_failed"
  | "connection_disabled"
  | "no_text_route"
  | "text_not_ready";
export type ProviderReadiness = {
  stored: boolean;
  verified: boolean;
  ready: boolean;
  reasons: ReadinessReason[];
};
export type ProviderBudgetValue = {
  monthlyMicros: number;
  warnMicros: number;
  warn2Micros: number;
  stopMicros: number;
  anchorDay: number;
  credit?: { amountMicros: number; verifiedAt: string; note?: string };
};
type Provider = "openai" | "anthropic";
type KeyName = "openai" | "image" | "anthropic";
const OPENAI_TIERS = ["fast", "standard", "quality", "escalation"] as const;
const ANTHROPIC_TIERS = ["fast", "standard", "quality"] as const;
const PROVIDERS = ["openai", "anthropic"] as const;
const KEY_NAMES = ["openai", "image", "anthropic"] as const;
type OpenAiTier = (typeof OPENAI_TIERS)[number];
type AnthropicTier = (typeof ANTHROPIC_TIERS)[number];

export type ProjectAiEffective = {
  projectId: string;
  routingMode: RoutingMode;
  routingApplied: boolean;
  /** Only with routingMode "organization". */
  standardSource: "organization" | "system" | null;
  exceptions: ReturnType<typeof projectAiExceptions>;
  defaultProvider: Traced<Provider>;
  tiers: {
    openai: Record<OpenAiTier, Traced<string>>;
    anthropic: Record<AnthropicTier, Traced<string>>;
  };
  taskRoutes: Record<TaskClass, TracedRoute>;
  fallback: Traced<"none" | "openai">;
  imageModel: Traced<string>;
  keys: Record<KeyName, KeyTrace>;
  providerBudgets: Record<Provider, Traced<ProviderBudgetValue>>;
  readiness: Record<Provider, ProviderReadiness>;
};

export type AiOrigins = {
  defaultProvider: AiOrigin;
  tiers: {
    openai: Record<OpenAiTier, AiOrigin>;
    anthropic: Record<AnthropicTier, AiOrigin | null>;
  };
  taskRoutes: Record<TaskClass, { explicit: boolean; origin: AiOrigin | null }>;
  fallback: AiOrigin;
  imageModel: AiOrigin;
  keys: Record<KeyName, KeyTrace["origin"]>;
  providerBudgets: Record<Provider, AiOrigin | null>;
};

type Layer = Partial<OpenAiRuntimeConfig>;

/**
 * The mode the runtime applies: a saved preset or standard counts only while
 * ORBIT_AI_DEFAULTS is on; otherwise the row's own fields apply.
 */
function appliedMode(state: AiConfigurationState): RoutingMode {
  const mode = routingModeOf(state.stored);
  return (mode === "preset" || mode === "organization") && !state.routingApplied
    ? "custom"
    : mode;
}

/** Under the project: the organization's profile, then the system's, then the environment. */
function fromLayers(
  state: AiConfigurationState,
  pick: (layer: Layer) => unknown,
): "organization" | "system" | "environment" {
  const layers = state.layers;
  if (layers?.organization && pick(layers.organization) !== undefined) return "organization";
  if (layers?.system && pick(layers.system) !== undefined) return "system";
  return "environment";
}

/**
 * The layer a task route comes from below the project. A layer's task routes
 * replace the lower layer's as a whole (withCentralAi spreads them), so the
 * highest layer that has any decides; the environment configures none.
 */
function layerTaskRoute(state: AiConfigurationState, task: TaskClass) {
  const layers = state.layers;
  for (const [origin, layer] of [
    ["organization", layers?.organization],
    ["system", layers?.system],
  ] as const)
    if (layer?.taskRoutes !== undefined) return layer.taskRoutes[task] ? origin : null;
  return null;
}

/** A provider budget as the budget check reads it (runtimeProviderBudgets). */
function budgetSource(
  state: AiConfigurationState,
  provider: Provider,
): { origin: AiOrigin; value: ProviderBudget } | null {
  const own = state.stored?.providerBudgets[provider];
  if (own) return { origin: "project", value: own };
  const organization = state.layers?.organization?.providerBudgets?.[provider];
  if (organization) return { origin: "organization", value: organization };
  const system = state.layers?.system?.providerBudgets?.[provider];
  if (system) return { origin: "system", value: system };
  return null;
}

/**
 * The key that serves calls of `key`: image calls fall back to the OpenAI
 * text key when there is no dedicated image key (the image call path uses
 * `imageApiKey ?? apiKey`; `imageKeyConfigured` counts it the same way).
 */
function servingKey(state: AiConfigurationState, key: KeyName): KeyName {
  return key === "image" &&
    state.effective.keySources.image === "none" &&
    state.effective.imageKeyConfigured
    ? "openai"
    : key;
}

function keyConnection(state: AiConfigurationState, name: KeyName) {
  const key = servingKey(state, name);
  if (state.effective.keySources[key] !== "connection") return null;
  const id = state.effective.keyConnections[key]?.connectionId;
  // A connection the project cannot read (none today) has nothing to report.
  return (id && state.keyConnections[id]) || null;
}

/** Where each effective value comes from (the origin table in docs/API_CONTRACT.md). */
export function effectiveOrigins(state: AiConfigurationState): AiOrigins {
  const mode = appliedMode(state);
  const { stored, effective } = state;
  const routing = mode === "preset" || mode === "organization" ? stored?.routing ?? null : null;
  const presetProvider = routing?.source === "preset" ? routing.provider : null;

  const defaultProvider: AiOrigin =
    mode === "preset"
      ? "preset"
      : mode === "custom"
        ? "project"
        : fromLayers(state, (l) => l.defaultProvider);
  // A Claude preset keeps the project's saved OpenAI tiers (presetRouting).
  const openaiTier = (tier: OpenAiTier): AiOrigin =>
    mode === "preset"
      ? presetProvider === "openai"
        ? "preset"
        : "project"
      : mode === "custom"
        ? "project"
        : fromLayers(state, (l) => l.modelRoutes?.[tier]);
  // The project's Claude tiers count only when stored; an OpenAI preset and
  // the standard clear them (routedFields), so the layers' apply. The
  // environment configures no Claude tiers.
  const anthropicTier = (tier: AnthropicTier): AiOrigin | null => {
    if (!effective.anthropicTierRoutes) return null;
    if (presetProvider === "anthropic") return "preset";
    if (mode === "custom" && stored?.anthropicTierRoutes) return "project";
    const origin = fromLayers(state, (l) => l.anthropicTierRoutes?.[tier]);
    return origin === "environment" ? null : origin;
  };
  // The runtime takes the organization's standard image model when it parses
  // (defaultImageModel), else the system's.
  const organizationImage = imageModelSchema.safeParse(
    (state.profiles.organization?.data as { defaults?: { imageModel?: unknown } } | null)
      ?.defaults?.imageModel,
  ).success;
  const imageModel: AiOrigin =
    mode === "organization" && state.layers?.standardImageModel
      ? organizationImage
        ? "organization"
        : "system"
      : mode === "unsaved"
        ? fromLayers(state, (l) => l.imageGeneration)
        : "project";
  const taskRoute = (task: TaskClass) => {
    const origin: AiOrigin | null =
      mode === "custom"
        ? stored?.taskRoutes[task]
          ? "project"
          : null
        : mode === "unsaved"
          ? layerTaskRoute(state, task)
          : routing?.overrides[task]
            ? "project"
            : mode === "organization"
              ? layerTaskRoute(state, task)
              : null;
    // Not explicit: the default provider's tier applies.
    return origin ? { explicit: true, origin } : { explicit: false, origin: defaultProvider };
  };
  const key = (name: KeyName): KeyTrace["origin"] => {
    const source = effective.keySources[servingKey(state, name)];
    if (source === "project" || source === "environment") return source;
    if (source !== "connection") return null;
    const connection = keyConnection(state, name);
    if (!connection) return null;
    return connection.scope === "system" ? "system" : "organization";
  };
  return {
    defaultProvider,
    tiers: {
      openai: Object.fromEntries(OPENAI_TIERS.map((t) => [t, openaiTier(t)])) as AiOrigins["tiers"]["openai"],
      anthropic: Object.fromEntries(
        ANTHROPIC_TIERS.map((t) => [t, anthropicTier(t)]),
      ) as AiOrigins["tiers"]["anthropic"],
    },
    taskRoutes: Object.fromEntries(taskClasses.map((t) => [t, taskRoute(t)])) as AiOrigins["taskRoutes"],
    fallback: mode === "unsaved" ? fromLayers(state, (l) => l.fallback) : "project",
    imageModel,
    keys: Object.fromEntries(KEY_NAMES.map((k) => [k, key(k)])) as AiOrigins["keys"],
    providerBudgets: Object.fromEntries(
      PROVIDERS.map((p) => [p, budgetSource(state, p)?.origin ?? null]),
    ) as AiOrigins["providerBudgets"],
  };
}

/** Readiness per provider (the readiness rules in docs/API_CONTRACT.md). */
export function providerReadiness(
  state: AiConfigurationState,
): Record<Provider, ProviderReadiness> {
  const { effective } = state;
  const textReady = textModelReady(effective);
  const one = (provider: Provider): ProviderReadiness => {
    const stored =
      provider === "openai" ? effective.textKeyConfigured : effective.anthropicKeyConfigured;
    if (!stored) return { stored: false, verified: false, ready: false, reasons: ["no_key"] };
    const reasons: ReadinessReason[] = [];
    const source = effective.keySources[provider];
    let verified = false;
    if (source === "connection") {
      const connection = keyConnection(state, provider);
      if (connection?.disabled) reasons.push("connection_disabled");
      else if (connection?.status === "read_verified" || connection?.status === "write_verified")
        verified = true;
      else if (connection?.status === "failed") reasons.push("connection_failed");
      else reasons.push("connection_not_checked");
    } else
      reasons.push(source === "project" ? "project_key_unverifiable" : "environment_key_unverifiable");
    const routed = TEXT_TASKS.some((task) => {
      const route = effective.effectiveRoutes[task];
      return !("error" in route) && route.provider === provider && route.price === "current";
    });
    const ready = textReady && routed;
    if (!textReady) reasons.push("text_not_ready");
    else if (!routed) reasons.push("no_text_route");
    return { stored, verified, ready, reasons };
  };
  return { openai: one("openai"), anthropic: one("anthropic") };
}

const traced = <T>(
  stored: T | null | undefined,
  effective: T | null | undefined,
  origin: AiOrigin | null,
): Traced<T> => ({
  stored: stored ?? null,
  effective: effective ?? null,
  origin: effective === null || effective === undefined ? null : origin,
});

const routeFields = (route: { model: string; reasoningEffort?: string; maxOutputTokens: number }) => ({
  model: route.model,
  ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  maxOutputTokens: route.maxOutputTokens,
});

const budgetFields = (budget: ProviderBudget | undefined): ProviderBudgetValue | null =>
  budget
    ? {
        monthlyMicros: budget.monthlyMicros,
        warnMicros: budget.warnMicros,
        warn2Micros: budget.warn2Micros,
        stopMicros: budget.stopMicros,
        anchorDay: budget.anchorDay,
        ...(budget.credit
          ? {
              credit: {
                amountMicros: budget.credit.amountMicros,
                verifiedAt: budget.credit.verifiedAt,
                ...(budget.credit.note !== undefined ? { note: budget.credit.note } : {}),
              },
            }
          : {}),
      }
    : null;

/** The standard a project on "organization" follows: the organization's, else the system's. */
function standardSource(state: AiConfigurationState) {
  if (routingModeOf(state.stored) !== "organization") return null;
  const defaults = (row: { data: unknown } | null) =>
    aiDefaultsSchema.safeParse((row?.data as { defaults?: unknown } | null)?.defaults).success;
  if (defaults(state.profiles.organization)) return "organization" as const;
  if (defaults(state.profiles.system)) return "system" as const;
  return null;
}

/** The response, field by field from the state. */
export function projectAiEffectiveOf(
  projectId: string,
  state: AiConfigurationState,
): ProjectAiEffective {
  const { stored, effective } = state;
  const origins = effectiveOrigins(state);
  const mode = appliedMode(state);
  // The route the project saved for the mode in force: its own task routes,
  // or the deviations of its preset or standard.
  const storedRoute = (task: TaskClass) =>
    mode === "custom"
      ? stored?.taskRoutes[task]
      : mode === "preset" || mode === "organization"
        ? stored?.routing?.overrides[task]
        : undefined;
  const effectiveRoute = (task: TaskClass): TracedRoute["effective"] => {
    const route = effective.effectiveRoutes[task];
    return "error" in route
      ? { error: route.error }
      : { ...routeFields(route), provider: route.provider, price: route.price };
  };
  const keyTrace = (name: KeyName): KeyTrace => {
    const connection = keyConnection(state, name);
    return {
      stored: state.ownKeys[name],
      effective:
        name === "image" ? effective.imageKeyConfigured : effective.keySources[name] !== "none",
      origin: origins.keys[name],
      connection: connection
        ? { label: connection.label, status: connection.status, disabled: connection.disabled }
        : null,
    };
  };
  return {
    projectId,
    routingMode: routingModeOf(stored),
    routingApplied: state.routingApplied,
    standardSource: standardSource(state),
    exceptions: projectAiExceptions(stored, state.ownKeys),
    defaultProvider: traced(stored?.defaultProvider, effective.defaultProvider, origins.defaultProvider),
    tiers: {
      openai: Object.fromEntries(
        OPENAI_TIERS.map((t) => [
          t,
          traced(stored?.modelRoutes[t], effective.modelRoutes[t], origins.tiers.openai[t]),
        ]),
      ) as ProjectAiEffective["tiers"]["openai"],
      anthropic: Object.fromEntries(
        ANTHROPIC_TIERS.map((t) => [
          t,
          traced(
            stored?.anthropicTierRoutes?.[t],
            effective.anthropicTierRoutes?.[t],
            origins.tiers.anthropic[t],
          ),
        ]),
      ) as ProjectAiEffective["tiers"]["anthropic"],
    },
    taskRoutes: Object.fromEntries(
      taskClasses.map((t) => {
        const own = storedRoute(t);
        return [
          t,
          {
            stored: own ? routeFields(own) : null,
            effective: effectiveRoute(t),
            ...origins.taskRoutes[t],
          },
        ];
      }),
    ) as ProjectAiEffective["taskRoutes"],
    fallback: traced(
      stored?.fallback.onProviderBudgetStop,
      effective.fallback.onProviderBudgetStop,
      origins.fallback,
    ),
    imageModel: traced(stored?.imageGeneration.model, effective.imageGeneration.model, origins.imageModel),
    keys: Object.fromEntries(KEY_NAMES.map((k) => [k, keyTrace(k)])) as ProjectAiEffective["keys"],
    providerBudgets: Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        traced(
          budgetFields(stored?.providerBudgets[p]),
          budgetFields(budgetSource(state, p)?.value),
          origins.providerBudgets[p],
        ),
      ]),
    ) as ProjectAiEffective["providerBudgets"],
    readiness: providerReadiness(state),
  };
}

export async function projectAiEffective(tx: DbTx, scope: Scope): Promise<ProjectAiEffective> {
  return projectAiEffectiveOf(scope.projectId, await aiConfigurationState(tx, scope));
}

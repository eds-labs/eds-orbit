import {
  centralRouteVersion,
  withCentralAi,
} from "./central-ai.ts";
import { z } from "zod";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  anthropicCatalog,
  anthropicCatalogRateCard,
  anthropicCatalogRegistry,
  environmentRuntimeConfig,
  fallbackConfigurationSchema,
  imageGenerationConfigurationSchema,
  modelRegistrySchema,
  providerBudgetsSchema,
  providerIdSchema,
  providerOfModel,
  providerTierRoutesSchema,
  rateCardSchema,
  rateStatus,
  resolveRoute,
  taskClasses,
  taskRoutesSchema,
  type ModelRoute,
  type OpenAiRuntimeConfig,
  type ProviderId,
  type TaskClass,
} from "../../../../../packages/ai/src/index.ts";
import {
  loadConfig,
  modelRoutes,
} from "../../../../../packages/config/src/index.ts";
import {
  create,
  data,
  decrypt,
  encrypt,
  update,
  DomainError,
} from "../shared.ts";

/**
 * The project's AI configuration: one entity of kind `openai_configuration`
 * (the name predates the second provider). `openai-configure` saves the
 * OpenAI keys, verified models, rate card, tiers, task routes and image
 * settings as before; `ai-provider-configure` saves the provider fields
 * added with the Anthropic provider (plan D-A4). Every save bumps the
 * entity version, which is the route version runs are bound to.
 */
const key = z.string().trim().min(20).max(1000);
export const openAiConfigurationInput = z
  .object({
    apiKey: key.optional(),
    imageApiKey: key.optional(),
    verifiedModels: z.array(z.string().trim().min(1).max(120)).max(40),
    rateCard: rateCardSchema,
    modelRoutes: z
      .object({
        fast: z.string().trim().min(1).max(120),
        standard: z.string().trim().min(1).max(120),
        quality: z.string().trim().min(1).max(120),
        escalation: z.string().trim().min(1).max(120),
      })
      .strict()
      .default(modelRoutes),
    taskRoutes: taskRoutesSchema.default({}),
    imageGeneration: imageGenerationConfigurationSchema.default({
      model: "gpt-image-2.5-flare",
      maxCostMicrosPerImage: 0,
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.verifiedModels).size !== value.verifiedModels.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_MODEL" });
    if (Object.keys(value.rateCard).length > 40)
      context.addIssue({ code: "custom", message: "RATE_CARD_LIMIT" });
    // Every tier, including the unused escalation tier, must name a verified model.
    // `resolveRoute` repeats the capability gate at call time.
    if (
      value.verifiedModels.length &&
      [
        value.modelRoutes.fast,
        value.modelRoutes.standard,
        value.modelRoutes.quality,
      ].some((model) => !value.verifiedModels.includes(model))
    )
      context.addIssue({
        code: "custom",
        message: "ROUTED_MODEL_NOT_VERIFIED",
      });
    if (
      value.verifiedModels.length &&
      Object.values(value.taskRoutes).some(
        (route) => !value.verifiedModels.includes(route.model),
      )
    )
      context.addIssue({
        code: "custom",
        message: "ROUTED_MODEL_NOT_VERIFIED",
      });
    if (
      value.imageGeneration.maxCostMicrosPerImage > 0 &&
      !value.verifiedModels.includes(value.imageGeneration.model)
    )
      context.addIssue({ code: "custom", message: "IMAGE_MODEL_NOT_VERIFIED" });
  });

/** The provider fields of `ai-provider-configure` (plan D-A4..D-A7). */
export const aiProviderConfigurationInput = z
  .object({
    anthropicApiKey: key.optional(),
    /** Merge the reviewed Claude catalog atomically with the provider credentials. */
    applyAnthropicCatalog: z.boolean().default(false),
    /** Forgets the saved Anthropic key (the environment fallback applies again). */
    clearAnthropicApiKey: z.boolean().default(false),
    defaultProvider: providerIdSchema.default("openai"),
    anthropicTierRoutes: providerTierRoutesSchema.optional(),
    models: modelRegistrySchema.default({}),
    providerBudgets: providerBudgetsSchema.default({}),
    fallback: fallbackConfigurationSchema.default({
      onProviderBudgetStop: "none",
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.models).length > 40)
      context.addIssue({ code: "custom", message: "MODEL_REGISTRY_LIMIT" });
    if (value.anthropicApiKey && value.clearAnthropicApiKey)
      context.addIssue({ code: "custom", message: "ANTHROPIC_KEY_CONFLICT" });
  });

type StoredConfiguration = Omit<
  z.infer<typeof openAiConfigurationInput>,
  "apiKey" | "imageApiKey"
> &
  Omit<
    z.infer<typeof aiProviderConfigurationInput>,
    "anthropicApiKey" | "clearAnthropicApiKey" | "applyAnthropicCatalog"
  > & {
    encryptedApiKey?: string;
    encryptedImageApiKey?: string;
    encryptedAnthropicApiKey?: string;
    updatedBy: string;
    updatedAt: string;
  };

const defaultProviderFields = () => aiProviderConfigurationInput.parse({});

function stored(row: { data: unknown }): StoredConfiguration {
  const value = data(row);
  const providerFields = aiProviderConfigurationInput.parse({
    ...(value.defaultProvider
      ? { defaultProvider: value.defaultProvider }
      : {}),
    ...(value.anthropicTierRoutes
      ? { anthropicTierRoutes: value.anthropicTierRoutes }
      : {}),
    ...(value.models ? { models: value.models } : {}),
    ...(value.providerBudgets
      ? { providerBudgets: value.providerBudgets }
      : {}),
    ...(value.fallback ? { fallback: value.fallback } : {}),
  });
  return {
    encryptedApiKey: z.string().optional().parse(value.encryptedApiKey),
    encryptedImageApiKey: z
      .string()
      .optional()
      .parse(value.encryptedImageApiKey),
    encryptedAnthropicApiKey: z
      .string()
      .optional()
      .parse(value.encryptedAnthropicApiKey),
    verifiedModels: z.array(z.string()).parse(value.verifiedModels ?? []),
    rateCard: rateCardSchema.parse(value.rateCard ?? {}),
    modelRoutes: z
      .object({
        fast: z.string(),
        standard: z.string(),
        quality: z.string(),
        escalation: z.string(),
      })
      .parse(value.modelRoutes ?? modelRoutes),
    // Legacy rows predate task routes.
    taskRoutes: taskRoutesSchema.default({}).parse(value.taskRoutes),
    imageGeneration: imageGenerationConfigurationSchema.parse(
      value.imageGeneration ?? {},
    ),
    defaultProvider: providerFields.defaultProvider,
    anthropicTierRoutes: providerFields.anthropicTierRoutes,
    models: providerFields.models,
    providerBudgets: providerFields.providerBudgets,
    fallback: providerFields.fallback,
    updatedBy: z.string().parse(value.updatedBy),
    updatedAt: z.iso.datetime().parse(value.updatedAt),
  };
}

type EffectiveRoute =
  | (ModelRoute & {
      provider: ProviderId;
      price: ReturnType<typeof rateStatus>;
    })
  | { error: "MODEL_CAPABILITY_NOT_VERIFIED" | "ROUTE_EFFORT_UNSUPPORTED" };

// Never throws: unverified routes and missing or stale prices are reported
// instead of failing the view; a run fails closed on either.
function effectiveRoutes(
  runtime: Pick<
    OpenAiRuntimeConfig,
    | "verifiedModels"
    | "modelRoutes"
    | "taskRoutes"
    | "rateCard"
    | "models"
    | "defaultProvider"
    | "anthropicTierRoutes"
  >,
) {
  return Object.fromEntries(
    taskClasses.map((taskClass) => {
      try {
        const route = resolveRoute(taskClass, runtime);
        return [
          taskClass,
          {
            ...route,
            provider: providerOfModel(route.model, runtime.models),
            price: rateStatus(route.model, runtime.rateCard),
          },
        ];
      } catch (error) {
        return [
          taskClass,
          {
            error:
              error instanceof Error &&
              error.message === "ROUTE_EFFORT_UNSUPPORTED"
                ? "ROUTE_EFFORT_UNSUPPORTED"
                : "MODEL_CAPABILITY_NOT_VERIFIED",
          },
        ];
      }
    }),
  ) as Record<TaskClass, EffectiveRoute>;
}

/**
 * The dated Claude suggestion the admin view can prefill (plan D-A5): model
 * ids, prices, tiers and routes as read from the official documentation on
 * `verifiedAt`, with the sources. Nothing is applied without an owner save.
 */
export function anthropicSuggestions() {
  return {
    verifiedAt: anthropicCatalog.verifiedAt,
    sources: [...anthropicCatalog.sources],
    rateCard: anthropicCatalogRateCard(),
    models: anthropicCatalogRegistry(),
    tiers: { ...anthropicCatalog.tiers },
    routes: { ...anthropicCatalog.suggestedRoutes },
  };
}

/**
 * Provider status for the admin view: configured where, never a key. It
 * follows the runtime's rule without central connections
 * (`runtimeOpenAiConfiguration`): once a configuration is saved, the
 * environment OpenAI key is no longer used, so it does not count here
 * either; the environment Anthropic key still does.
 */
function providerStatus(
  fallback: OpenAiRuntimeConfig,
  value: StoredConfiguration | null,
) {
  const source = (orbit: boolean, environment: boolean) =>
    orbit ? "orbit" : environment ? "environment" : "none";
  const environmentOpenAi = !value && Boolean(fallback.apiKey);
  return {
    openai: {
      keyConfigured: Boolean(value?.encryptedApiKey) || environmentOpenAi,
      source: source(Boolean(value?.encryptedApiKey), environmentOpenAi),
    },
    anthropic: {
      keyConfigured: Boolean(
        value?.encryptedAnthropicApiKey || fallback.anthropicApiKey,
      ),
      source: source(
        Boolean(value?.encryptedAnthropicApiKey),
        Boolean(fallback.anthropicApiKey),
      ),
    },
  };
}

type KeySource = "project" | "connection" | "environment" | "none";
/** The admin view's name for a key source: a project key is "orbit". */
const viewSource = (source: KeySource) =>
  source === "project" ? "orbit" : source;

/**
 * The admin view of the project's AI configuration, with key presence taken
 * from what calls would use now (`effectiveAiStatus`): a granted connection
 * counts, an environment key the runtime ignores does not. If a stored key
 * cannot be opened (after a key rotation, say), the view keeps the stored
 * presence flags instead of failing.
 */
export async function projectAiConfigurationView(tx: DbTx, scope: Scope) {
  const view = publicOpenAiConfiguration(await configurationRow(tx, scope));
  let status: Awaited<ReturnType<typeof effectiveAiStatus>>;
  try {
    status = await effectiveAiStatus(tx, scope);
  } catch {
    return view;
  }
  return {
    ...view,
    routesWithoutKey: routesWithoutKey(status),
    textKeyConfigured: status.textKeyConfigured,
    imageKeyConfigured: status.imageKeyConfigured,
    providers: {
      openai: {
        keyConfigured: status.textKeyConfigured,
        source: viewSource(status.keySources.openai),
      },
      anthropic: {
        keyConfigured: status.anthropicKeyConfigured,
        source: viewSource(status.keySources.anthropic),
      },
    },
  };
}

export function publicOpenAiConfiguration(
  row: { data: unknown; version?: number } | null,
  fallback = environmentRuntimeConfig(),
) {
  if (!row) {
    const providerFields = defaultProviderFields();
    const runtime = {
      verifiedModels: fallback.verifiedModels,
      modelRoutes,
      taskRoutes: fallback.taskRoutes,
      rateCard: fallback.rateCard,
      models: providerFields.models,
      defaultProvider: fallback.defaultProvider ?? "openai",
      anthropicTierRoutes: fallback.anthropicTierRoutes,
    };
    return {
      configured: Boolean(fallback.apiKey || fallback.imageApiKey),
      source: fallback.apiKey || fallback.imageApiKey ? "environment" : "none",
      textKeyConfigured: Boolean(fallback.apiKey),
      imageKeyConfigured: Boolean(fallback.imageApiKey || fallback.apiKey),
      dedicatedImageKeyConfigured: Boolean(fallback.imageApiKey),
      verifiedModels: fallback.verifiedModels,
      rateCard: fallback.rateCard,
      modelRoutes,
      taskRoutes: fallback.taskRoutes ?? {},
      effectiveRoutes: effectiveRoutes(runtime),
      routeVersion: null,
      imageGeneration:
        fallback.imageGeneration ??
        imageGenerationConfigurationSchema.parse({}),
      providers: providerStatus(fallback, null),
      defaultProvider: runtime.defaultProvider,
      anthropicTierRoutes: fallback.anthropicTierRoutes ?? null,
      models: providerFields.models,
      providerBudgets: providerFields.providerBudgets,
      fallback: providerFields.fallback,
      suggestions: { anthropic: anthropicSuggestions() },
    };
  }
  const value = stored(row);
  return {
    configured: true,
    source: "orbit",
    textKeyConfigured: Boolean(value.encryptedApiKey),
    imageKeyConfigured: Boolean(
      value.encryptedImageApiKey || value.encryptedApiKey,
    ),
    dedicatedImageKeyConfigured: Boolean(value.encryptedImageApiKey),
    verifiedModels: value.verifiedModels,
    rateCard: value.rateCard,
    modelRoutes: value.modelRoutes,
    taskRoutes: value.taskRoutes,
    effectiveRoutes: effectiveRoutes(value),
    routeVersion: row.version ?? null,
    imageGeneration: value.imageGeneration,
    providers: providerStatus(fallback, value),
    defaultProvider: value.defaultProvider,
    anthropicTierRoutes: value.anthropicTierRoutes ?? null,
    models: value.models,
    providerBudgets: value.providerBudgets,
    fallback: value.fallback,
    suggestions: { anthropic: anthropicSuggestions() },
    updatedAt: value.updatedAt,
    version: row.version,
  };
}

async function configurationRow(tx: DbTx, scope: Scope) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
  });
}

/** Entity version of the stored configuration; null for the environment fallback. No secrets are read. */
export async function openAiConfigurationVersion(
  tx: DbTx,
  scope: Scope,
): Promise<number | null> {
  const row = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
    select: { version: true },
  });
  // Central profiles and granted keys take part in the version (ADR 0014).
  return centralRouteVersion(tx, scope, row?.version ?? null);
}

export async function runtimeOpenAiConfiguration(
  tx: DbTx,
  scope: Scope,
): Promise<OpenAiRuntimeConfig> {
  const row = await configurationRow(tx, scope);
  const environment = environmentRuntimeConfig();
  const credentialKey = loadConfig().CREDENTIAL_KEY;
  const value = row ? stored(row) : null;
  // Only what the project saved itself, keys included (no fallback here).
  const project: OpenAiRuntimeConfig | null = value
    ? {
        apiKey: value.encryptedApiKey
          ? decrypt(value.encryptedApiKey, credentialKey)
          : undefined,
        imageApiKey: value.encryptedImageApiKey
          ? decrypt(value.encryptedImageApiKey, credentialKey)
          : undefined,
        anthropicApiKey: value.encryptedAnthropicApiKey
          ? decrypt(value.encryptedAnthropicApiKey, credentialKey)
          : undefined,
        verifiedModels: value.verifiedModels,
        rateCard: value.rateCard,
        modelRoutes: value.modelRoutes,
        anthropicTierRoutes: value.anthropicTierRoutes,
        taskRoutes: value.taskRoutes,
        models: value.models,
        defaultProvider: value.defaultProvider,
        providerBudgets: value.providerBudgets,
        fallback: value.fallback,
        routeVersion: row!.version,
        imageGeneration: value.imageGeneration,
      }
    : null;
  const central = await withCentralAi(
    tx,
    scope,
    project,
    environment,
    row?.version ?? null,
  );
  if (central) return central;
  if (!project) return environment;
  // The saved key wins; the environment Anthropic key is the bootstrap fallback.
  return {
    ...project,
    anthropicApiKey: project.anthropicApiKey ?? environment.anthropicApiKey,
  };
}

/**
 * What the project's calls would use now, with the central profiles and
 * granted keys applied (ADR 0014), as presence flags and models only: the
 * keys are read and dropped here, never returned. Readiness and the MCP
 * model view use it, so a project served by central keys counts as
 * configured.
 */
export async function effectiveAiStatus(tx: DbTx, scope: Scope) {
  const runtime = await runtimeOpenAiConfiguration(tx, scope);
  const imageGeneration = imageGenerationConfigurationSchema.parse(
    runtime.imageGeneration ?? {},
  );
  const row = await configurationRow(tx, scope);
  const own = row ? stored(row) : null;
  const source = (
    key: "openai" | "image" | "anthropic",
    present: boolean,
    ownKey: boolean,
  ): KeySource =>
    !present
      ? "none"
      : ownKey
        ? "project"
        : runtime.keySources?.[key]
          ? "connection"
          : "environment";
  return {
    textKeyConfigured: Boolean(runtime.apiKey),
    imageKeyConfigured: Boolean(runtime.imageApiKey || runtime.apiKey),
    anthropicKeyConfigured: Boolean(runtime.anthropicApiKey),
    keySources: {
      openai: source("openai", Boolean(runtime.apiKey), Boolean(own?.encryptedApiKey)),
      image: source(
        "image",
        Boolean(runtime.imageApiKey),
        Boolean(own?.encryptedImageApiKey),
      ),
      anthropic: source(
        "anthropic",
        Boolean(runtime.anthropicApiKey),
        Boolean(own?.encryptedAnthropicApiKey),
      ),
    },
    // The granted connections the keys come from, by id (no secret).
    keyConnections: runtime.keySources ?? {},
    verifiedModels: runtime.verifiedModels ?? [],
    rateCard: runtime.rateCard ?? {},
    modelRoutes: runtime.modelRoutes ?? modelRoutes,
    taskRoutes: runtime.taskRoutes ?? {},
    anthropicTierRoutes: runtime.anthropicTierRoutes ?? null,
    defaultProvider: runtime.defaultProvider ?? "openai",
    models: runtime.models ?? {},
    providerBudgets: runtime.providerBudgets ?? {},
    fallback: runtime.fallback ?? { onProviderBudgetStop: "none" },
    imageGeneration,
    effectiveRoutes: effectiveRoutes({
      verifiedModels: runtime.verifiedModels ?? [],
      modelRoutes: runtime.modelRoutes ?? modelRoutes,
      taskRoutes: runtime.taskRoutes,
      rateCard: runtime.rateCard ?? {},
      models: runtime.models,
      defaultProvider: runtime.defaultProvider,
      anthropicTierRoutes: runtime.anthropicTierRoutes,
    }),
    routeVersion: runtime.routeVersion ?? null,
  };
}

/** Task classes whose route decides whether chat and text drafting can run. */
const TEXT_TASKS = ["chat_operator", "draft_social"] as const;

/**
 * Whether chat and text drafting can call a verified model now: an OpenAI
 * text key with verified models (the rule before the Anthropic provider)
 * while no text route goes to Claude, or routes for chat and social drafts
 * that resolve to a verified, priced model whose provider has a key, so a
 * project on Claude counts too and one routed to Claude without an
 * Anthropic key does not.
 */
export function textModelReady(status: {
  textKeyConfigured: boolean;
  anthropicKeyConfigured: boolean;
  verifiedModels: string[];
  effectiveRoutes?: Record<string, unknown>;
}) {
  const routes = TEXT_TASKS.map(
    (task) =>
      status.effectiveRoutes?.[task] as
        | { error?: string; provider?: ProviderId; price?: string }
        | undefined,
  );
  if (
    status.textKeyConfigured &&
    status.verifiedModels.length &&
    !routes.some((route) => route?.provider === "anthropic")
  )
    return true;
  return routes.every((route) => {
    if (!route || route.error || route.price !== "current") return false;
    return route.provider === "anthropic"
      ? status.anthropicKeyConfigured
      : status.textKeyConfigured;
  });
}

/**
 * Task classes whose effective route names a model of a provider without a
 * usable key. Saving such a route is allowed (an owner may add the key
 * next), but a call on it fails with PAID_CALL_NOT_AUTHORIZED, so the
 * settings and the MCP model view show it.
 */
export function routesWithoutKey(status: {
  textKeyConfigured: boolean;
  anthropicKeyConfigured: boolean;
  effectiveRoutes?: Record<string, unknown>;
}) {
  return Object.entries(status.effectiveRoutes ?? {})
    .filter(([, value]) => {
      const route = value as
        | { error?: string; provider?: ProviderId }
        | undefined;
      if (!route || route.error || !route.provider) return false;
      return route.provider === "anthropic"
        ? !status.anthropicKeyConfigured
        : !status.textKeyConfigured;
    })
    .map(([task]) => task)
    .sort();
}

/**
 * The provider budgets and model registry of the project, for the budget
 * check inside `reserve`: one row read, no key decrypted.
 */
export async function runtimeProviderBudgets(
  tx: DbTx,
  scope: Scope,
): Promise<Pick<OpenAiRuntimeConfig, "providerBudgets" | "models">> {
  const row = await configurationRow(tx, scope);
  if (!row) return { providerBudgets: {}, models: {} };
  const value = stored(row);
  return { providerBudgets: value.providerBudgets, models: value.models };
}

export async function saveOpenAiConfiguration(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  // A granted central connection supplies the key (ADR 0014); the caller checked it.
  options: { grantedKey?: boolean } = {},
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = openAiConfigurationInput.parse(raw);
  const current = await configurationRow(tx, scope);
  const currentValue = current ? stored(current) : null;
  if (
    !current &&
    !input.apiKey &&
    !input.imageApiKey &&
    !options.grantedKey &&
    !environmentRuntimeConfig().anthropicApiKey
  )
    throw new DomainError("OPENAI_API_KEY_REQUIRED");
  // A model that leaves the verified list must not stay in a saved Anthropic tier.
  if (
    currentValue?.anthropicTierRoutes &&
    input.verifiedModels.length &&
    Object.values(currentValue.anthropicTierRoutes).some(
      (model) => !input.verifiedModels.includes(model),
    )
  )
    throw new DomainError("ROUTED_MODEL_NOT_VERIFIED");
  const next = {
    ...(currentValue ?? defaultProviderFields()),
    encryptedApiKey: input.apiKey
      ? encrypt(input.apiKey, loadConfig().CREDENTIAL_KEY)
      : currentValue?.encryptedApiKey,
    encryptedImageApiKey: input.imageApiKey
      ? encrypt(input.imageApiKey, loadConfig().CREDENTIAL_KEY)
      : currentValue?.encryptedImageApiKey,
    encryptedAnthropicApiKey: currentValue?.encryptedAnthropicApiKey,
    verifiedModels: input.verifiedModels,
    rateCard: input.rateCard,
    modelRoutes: input.modelRoutes,
    taskRoutes: input.taskRoutes,
    imageGeneration: input.imageGeneration,
    updatedBy: scope.userId,
    updatedAt: new Date().toISOString(),
  };
  const row = current
    ? await update(tx, scope, current, next)
    : await create(tx, scope, "openai_configuration", next);
  return publicOpenAiConfiguration(row);
}

/**
 * Saves the provider fields (Anthropic key, default provider, Anthropic
 * tiers, model registry, provider budgets, fallback). Tier models must be
 * verified; a Claude route may not use the effort `none`. Creating the
 * configuration with an Anthropic key alone is allowed: OpenAI then stays
 * unconfigured until its key is saved.
 */
export async function saveAiProviderConfiguration(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = aiProviderConfigurationInput.parse(raw);
  const current = await configurationRow(tx, scope);
  const currentValue = current ? stored(current) : null;
  const catalog = input.applyAnthropicCatalog ? anthropicSuggestions() : null;
  const verifiedModels = catalog
    ? [
        ...new Set([
          ...(currentValue?.verifiedModels ?? []),
          ...Object.keys(catalog.models),
        ]),
      ]
    : (currentValue?.verifiedModels ?? []);
  const models = catalog
    ? { ...catalog.models, ...input.models }
    : input.models;
  if (verifiedModels.length > 40 || Object.keys(models).length > 40)
    throw new DomainError("MODEL_REGISTRY_LIMIT");
  if (
    input.anthropicTierRoutes &&
    Object.values(input.anthropicTierRoutes).some(
      (model) => !verifiedModels.includes(model),
    )
  )
    throw new DomainError("ROUTED_MODEL_NOT_VERIFIED");
  for (const route of Object.values(currentValue?.taskRoutes ?? {}))
    if (
      route.reasoningEffort === "none" &&
      providerOfModel(route.model, models) === "anthropic"
    )
      throw new DomainError("ROUTE_EFFORT_UNSUPPORTED");
  const encryptedAnthropicApiKey = input.anthropicApiKey
    ? encrypt(input.anthropicApiKey, loadConfig().CREDENTIAL_KEY)
    : input.clearAnthropicApiKey
      ? undefined
      : currentValue?.encryptedAnthropicApiKey;
  if (
    !current &&
    !encryptedAnthropicApiKey &&
    !environmentRuntimeConfig().anthropicApiKey &&
    !environmentRuntimeConfig().apiKey
  )
    throw new DomainError("ANTHROPIC_API_KEY_REQUIRED");
  const base = currentValue ?? {
    verifiedModels: [],
    rateCard: {},
    modelRoutes,
    taskRoutes: {},
    imageGeneration: imageGenerationConfigurationSchema.parse({}),
  };
  const rateCard = catalog
    ? { ...catalog.rateCard, ...base.rateCard }
    : base.rateCard;
  if (Object.keys(rateCard).length > 40)
    throw new DomainError("RATE_CARD_LIMIT");
  const next = {
    ...base,
    verifiedModels,
    rateCard,
    encryptedAnthropicApiKey,
    defaultProvider: input.defaultProvider,
    anthropicTierRoutes: input.anthropicTierRoutes,
    models,
    providerBudgets: input.providerBudgets,
    fallback: input.fallback,
    updatedBy: scope.userId,
    updatedAt: new Date().toISOString(),
  };
  const row = current
    ? await update(tx, scope, current, next)
    : await create(tx, scope, "openai_configuration", next);
  return publicOpenAiConfiguration(row);
}

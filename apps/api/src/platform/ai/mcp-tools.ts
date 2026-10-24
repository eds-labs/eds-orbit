import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  anthropicCatalog,
  anthropicCatalogRateCard,
  anthropicCatalogRegistry,
  fallbackConfigurationSchema,
  imageGenerationConfigurationSchema,
  imagePriceConfigured,
  providerBudgetsSchema,
  providerIdSchema,
  providerOfModel,
  providerTierRoutesSchema,
  rateStatus,
  taskRoutesSchema,
} from "../../../../../packages/ai/src/index.ts";
import { audit, data, DomainError } from "../shared.ts";
import { connectionsEnabled, grantedConnections } from "../connections/central.ts";
import {
  assertSameChanges,
  requireChanges,
  settingChanges,
} from "../configuration/changes.ts";
import { projectAdministrationEnabled } from "../configuration/configuration.ts";
import { approvedOperation, readOperation } from "../tasks/operation-tools.ts";
import { PROJECT_OWN, PROJECT_READ } from "../tenancy/permissions.ts";
import {
  aiProviderConfigurationInput,
  effectiveAiStatus,
  openAiConfigurationInput,
  publicOpenAiConfiguration,
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "./openai-configuration.ts";

// AI models over MCP (docs/MCP_PROJECT_ADMINISTRATION.md). Providers, keys
// and the system's and organization's AI profiles are global and managed
// in the administration; a project selects among their verified, priced
// models and sets its routes and budgets. Keys are never read here: a
// missing key is set up in Orbit (Administration → Connections, or the
// project's Settings → AI).

const modelName = z.string().trim().min(1).max(120);

async function configurationRow(tx: DbTx, scope: Scope) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
  });
}

/** The project configuration's version; 0 while the project has none. */
const versionOf = (row: { version: number } | null) => row?.version ?? 0;

const grantView = (g: Awaited<ReturnType<typeof grantedConnections>>[number] | undefined) =>
  g
    ? {
        connectionId: g.connection.id,
        label: g.connection.label,
        scope: g.connection.scope,
        status: g.connection.status,
        monthlyBudgetMicros:
          g.grant.monthlyBudgetMicros === null ? null : Number(g.grant.monthlyBudgetMicros),
      }
    : null;

/** Model checks the readiness of drafting and images depends on. */
function modelChecks(effective: Awaited<ReturnType<typeof effectiveAiStatus>>) {
  const routed = [
    effective.modelRoutes.fast,
    effective.modelRoutes.standard,
    effective.modelRoutes.quality,
    ...Object.values(effective.taskRoutes).map((route) => route!.model),
  ];
  const image = effective.imageGeneration;
  return {
    textModelVerified: Boolean(
      effective.textKeyConfigured && effective.verifiedModels.length,
    ),
    unverifiedRoutedModels: [
      ...new Set(routed.filter((m) => !effective.verifiedModels.includes(m))),
    ],
    unpricedVerifiedModels: effective.verifiedModels.filter(
      (m) => !/^(gpt-image|dall-e)/i.test(m) && rateStatus(m, effective.rateCard) !== "current",
    ),
    imageKeyConfigured: effective.imageKeyConfigured,
    imagePricingCurrent: imagePriceConfigured(image),
    imageModelVerified: effective.verifiedModels.includes(image.model),
  };
}

export async function readAiModels(tx: DbTx, scope: Scope) {
  const row = await configurationRow(tx, scope);
  const effective = await effectiveAiStatus(tx, scope);
  const project = row ? publicOpenAiConfiguration(row) : null;
  const profiles = connectionsEnabled()
    ? await tx.aiProfile.findMany({
        where: { OR: [{ scope: "system" }, { workspaceId: scope.workspaceId }] },
      })
    : [];
  const profile = (kind: string) => {
    const p = profiles.find((x) => x.scope === kind);
    if (!p) return null;
    const d = data(p);
    return {
      version: p.version,
      verifiedModels: d.verifiedModels ?? [],
      defaultProvider: d.defaultProvider ?? null,
      imageModel: d.imageGeneration?.model ?? null,
      pricedModels: Object.keys(d.rateCard ?? {}),
    };
  };
  const [text, image, anthropic] = await Promise.all([
    grantedConnections(tx, scope, { provider: "openai", purpose: "text" }),
    grantedConnections(tx, scope, { provider: "openai", purpose: "image" }),
    grantedConnections(tx, scope, { provider: "anthropic", purpose: "text" }),
  ]);
  const catalog = anthropicCatalogRateCard();
  const candidates = [
    ...new Set([...effective.verifiedModels, ...Object.keys(catalog)]),
  ].map((model) => ({
    model,
    provider: providerOfModel(model, effective.models),
    verified: effective.verifiedModels.includes(model),
    price:
      rateStatus(model, effective.rateCard) === "current" || catalog[model]
        ? "current"
        : "missing",
    source: effective.verifiedModels.includes(model)
      ? "configured"
      : "anthropic_catalog",
  }));
  return {
    projectId: scope.projectId,
    // Pass as expectedVersion to ai_models_update.
    version: versionOf(row),
    global: {
      connectionsEnabled: connectionsEnabled(),
      profiles: { system: profile("system"), organization: profile("workspace") },
      grantedKeys: {
        openaiText: grantView(text[0]),
        openaiImage: grantView(image[0]),
        anthropic: grantView(anthropic[0]),
      },
      anthropicCatalogVerifiedAt: anthropicCatalog.verifiedAt,
    },
    project: project
      ? {
          configured: true,
          verifiedModels: project.verifiedModels,
          modelRoutes: project.modelRoutes,
          taskRoutes: project.taskRoutes,
          imageGeneration: project.imageGeneration,
          defaultProvider: project.defaultProvider,
          anthropicTierRoutes: project.anthropicTierRoutes,
          providerBudgets: project.providerBudgets,
          fallback: project.fallback,
          pricedModels: Object.keys(project.rateCard),
        }
      : { configured: false },
    effective: {
      keys: {
        openaiText: effective.textKeyConfigured,
        image: effective.imageKeyConfigured,
        anthropic: effective.anthropicKeyConfigured,
      },
      keySources: effective.keySources,
      verifiedModels: effective.verifiedModels,
      prices: Object.fromEntries(
        effective.verifiedModels.map((m) => [m, rateStatus(m, effective.rateCard)]),
      ),
      modelRoutes: effective.modelRoutes,
      routes: effective.effectiveRoutes,
      defaultProvider: effective.defaultProvider,
      anthropicTierRoutes: effective.anthropicTierRoutes,
      providerBudgets: effective.providerBudgets,
      fallback: effective.fallback,
      imageGeneration: effective.imageGeneration,
    },
    checks: modelChecks(effective),
    candidates,
    notes: {
      keys: "API keys are never returned. A missing key is added in Orbit: Administration → Connections (granted to the project) or Settings → AI.",
      selection:
        "ai_models_update accepts verified models only; prices come from the configured rate cards or the reviewed Anthropic catalog, never from the request.",
    },
  };
}

const imageChange = z
  .object({
    model: imageGenerationConfigurationSchema.shape.model.unwrap(),
    maxCostMicrosPerImage: z.number().int().min(0).max(10_000_000),
    pricingVerifiedAt: z.iso.datetime().optional(),
  })
  .strict();
export const aiModelsChange = z
  .object({
    expectedVersion: z.number().int().min(0),
    changes: z
      .object({
        verifiedModels: z.array(modelName).max(40).optional(),
        modelRoutes: z
          .object({
            fast: modelName,
            standard: modelName,
            quality: modelName,
            escalation: modelName,
          })
          .strict()
          .optional(),
        taskRoutes: taskRoutesSchema.optional(),
        imageGeneration: imageChange.optional(),
        defaultProvider: providerIdSchema.optional(),
        anthropicTierRoutes: providerTierRoutesSchema.nullable().optional(),
        providerBudgets: providerBudgetsSchema.optional(),
        fallback: fallbackConfigurationSchema.optional(),
      })
      .strict(),
  })
  .strict();
type AiModelsChange = z.infer<typeof aiModelsChange>;

const MODEL_FIELDS = [
  "verifiedModels",
  "rateCard",
  "modelRoutes",
  "taskRoutes",
  "imageGeneration",
] as const;
const PROVIDER_FIELDS = [
  "defaultProvider",
  "anthropicTierRoutes",
  "models",
  "providerBudgets",
  "fallback",
] as const;
const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, value[k] ?? null]));

/** The configuration after the change, validated like the AI settings form. */
async function proposedAi(tx: DbTx, scope: Scope, change: AiModelsChange) {
  const row = await configurationRow(tx, scope);
  if (versionOf(row) !== change.expectedVersion)
    throw new DomainError("AI_CONFIGURATION_VERSION_CONFLICT", 409);
  const effective = await effectiveAiStatus(tx, scope);
  // A project without its own settings starts from what it uses now.
  const base: Record<string, any> = row
    ? publicOpenAiConfiguration(row)
    : {
        verifiedModels: effective.verifiedModels,
        rateCard: effective.rateCard,
        modelRoutes: effective.modelRoutes,
        taskRoutes: effective.taskRoutes,
        imageGeneration: effective.imageGeneration,
        defaultProvider: effective.defaultProvider,
        anthropicTierRoutes: effective.anthropicTierRoutes,
        models: effective.models,
        providerBudgets: effective.providerBudgets,
        fallback: effective.fallback,
      };
  // Saving project settings replaces the environment key fallback: only a
  // project served by a granted (or its own) key may start its own settings.
  const grantedKey = effective.keySources.openai === "connection";
  if (!row && (!grantedKey || effective.keySources.image === "environment"))
    throw new DomainError("AI_KEY_SETUP_REQUIRED", 409);
  const c = change.changes;
  const next: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(c))
    if (value !== undefined) next[key] = value ?? undefined;
  const catalogRates = anthropicCatalogRateCard();
  const catalogModels = anthropicCatalogRegistry();
  const known = new Set([
    ...effective.verifiedModels,
    ...(base.verifiedModels as string[]),
    ...Object.keys(catalogRates),
  ]);
  const unknown = (next.verifiedModels as string[]).filter((m) => !known.has(m));
  if (unknown.length) throw new DomainError(`MODEL_NOT_VERIFIED:${unknown.join(",")}`, 409);
  // Prices come from the configured rate cards or the reviewed catalog.
  const rateCard: Record<string, unknown> = {};
  const models: Record<string, unknown> = { ...(base.models ?? {}) };
  for (const m of next.verifiedModels as string[]) {
    const rate =
      (base.rateCard as Record<string, unknown>)[m] ??
      effective.rateCard[m] ??
      catalogRates[m];
    if (rate) rateCard[m] = rate;
    if (catalogModels[m] && !models[m]) models[m] = catalogModels[m];
  }
  next.rateCard = rateCard;
  next.models = models;
  const routed = [
    next.modelRoutes.fast,
    next.modelRoutes.standard,
    next.modelRoutes.quality,
    ...Object.values(next.taskRoutes ?? {}).map((r: any) => r.model),
    ...(next.anthropicTierRoutes ? Object.values(next.anthropicTierRoutes) : []),
  ] as string[];
  const unpriced = [...new Set(routed)].filter(
    (m) => next.verifiedModels.includes(m) && !rateCard[m],
  );
  if (unpriced.length)
    throw new DomainError(`MODEL_PRICE_NOT_VERIFIED:${unpriced.join(",")}`, 409);
  // The forms' own validation: routed models verified, image model verified.
  const modelInput = openAiConfigurationInput.parse(pick(next, MODEL_FIELDS));
  const providerInput = aiProviderConfigurationInput.parse(
    Object.fromEntries(
      PROVIDER_FIELDS.filter((k) => next[k] != null).map((k) => [k, next[k]]),
    ),
  );
  const changes = requireChanges([
    ...settingChanges(pick(base, MODEL_FIELDS), pick(next, MODEL_FIELDS)),
    ...settingChanges(pick(base, PROVIDER_FIELDS), pick(next, PROVIDER_FIELDS)),
  ]);
  // A first save writes the provider fields too, as the owner saw them;
  // otherwise the new settings would reset them to the defaults.
  const providerChanged =
    !row ||
    changes.some((x) => (PROVIDER_FIELDS as readonly string[]).includes(x.setting));
  return { modelInput, providerInput, providerChanged, grantedKey, changes };
}

const getTool = readOperation({
  name: "ai_models_get",
  module: "platform",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the AI configuration: the global providers and AI profiles, which keys are available (presence and source only, never a key), the project's own model selection, the effective verified models with price status, routes, image model and pricing, provider budgets, readiness checks and selectable models.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readAiModels(tx, scope),
});

const update = approvedOperation({
  name: "ai_models_update",
  module: "platform",
  feature: "project_administration",
  proposable: projectAdministrationEnabled,
  policyRequired: false,
  mcpProjectRequired: true,
  description:
    "Proposes the project's AI model selection: changes = {verifiedModels, modelRoutes, taskRoutes, imageGeneration, defaultProvider, anthropicTierRoutes, providerBudgets, fallback} with only the fields to change, against expectedVersion from ai_models_get. Only verified, priced models; no keys. Owners only.",
  input: aiModelsChange,
  permission: PROJECT_OWN,
  validate: async (tx, scope, args) => {
    await proposedAi(tx, scope, args);
  },
  approvalContext: async (tx, scope, args) => ({
    changes: (await proposedAi(tx, scope, args)).changes,
  }),
  revalidateContext: async (tx, scope, args, saved) =>
    assertSameChanges(saved, (await proposedAi(tx, scope, args)).changes),
  run: async (tx, scope, args) => {
    const p = await proposedAi(tx, scope, args);
    let result = await saveOpenAiConfiguration(tx, scope, p.modelInput, {
      grantedKey: p.grantedKey,
    });
    if (p.providerChanged)
      result = await saveAiProviderConfiguration(tx, scope, p.providerInput);
    await audit(tx, scope, "openai_configuration.update", "openai_configuration", {
      source: "mcp",
      modelCount: result.verifiedModels.length,
      settings: p.changes.map((x) => x.setting),
    });
    return { version: result.version, verifiedModels: result.verifiedModels };
  },
  executionResult: async (_tx, _scope, saved) => saved,
});

export const aiModelTools = [getTool, update.tool];
export const aiModelActionTypes = { [update.actionType]: update.action };

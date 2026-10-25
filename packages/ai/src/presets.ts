import { z } from "zod";
import { modelRoutes as defaultTierRoutes } from "../../config/src/index.ts";
import { taskRoutesSchema } from "./routing.ts";
import { providerIdSchema, type ProviderId } from "./provider.ts";

// Model presets (plans/ai-central-management.md, phase B): one choice of
// provider and level instead of tiers and task routes. A preset names the
// tier models of its provider; tasks without an own route use the tier
// their task class always used (`legacyTier`), so a preset changes models,
// never which tasks get the stronger tier.

export const presetLevels = ["economy", "balanced", "quality"] as const;
export type PresetLevel = (typeof presetLevels)[number];

type Tiers = { fast: string; standard: string; quality: string };

export const modelPresets: Record<
  ProviderId,
  Record<PresetLevel, Tiers & { escalation?: string }>
> = {
  openai: {
    economy: {
      fast: "gpt-6-luna",
      standard: "gpt-6-luna",
      quality: "gpt-6.1-sol",
      escalation: "gpt-6.1-sol",
    },
    balanced: {
      fast: "gpt-6-luna",
      standard: "gpt-6.1-sol",
      quality: "gpt-6.1-sol",
      escalation: "gpt-6-astra",
    },
    quality: {
      fast: "gpt-6.1-sol",
      standard: "gpt-6.1-sol",
      quality: "gpt-6-astra",
      escalation: "gpt-6-astra",
    },
  },
  anthropic: {
    economy: {
      fast: "claude-haiku-5-5",
      standard: "claude-haiku-5-5",
      quality: "claude-sonnet-5-5",
    },
    balanced: {
      fast: "claude-haiku-5-5",
      standard: "claude-sonnet-5-5",
      quality: "claude-opus-5-5",
    },
    quality: {
      fast: "claude-sonnet-5-5",
      standard: "claude-opus-5-5",
      quality: "claude-opus-5-5",
    },
  },
};

const model = z.string().trim().min(1).max(120);

/** The organization's (or system's) standard models. */
export const aiDefaultsSchema = z
  .object({
    provider: providerIdSchema,
    level: z.enum(presetLevels),
    imageModel: model.optional(),
    /** Advanced: one model per task, over the preset. */
    taskRoutes: taskRoutesSchema.default({}),
  })
  .strict();
export type AiDefaults = z.infer<typeof aiDefaultsSchema>;

/**
 * How a project chooses its models: the organization's standard or an own
 * preset, each with optional per-task deviations. Absent, the project's own
 * tiers and task routes apply as before ("custom").
 */
export const projectRoutingSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("organization"),
      overrides: taskRoutesSchema.default({}),
    })
    .strict(),
  z
    .object({
      source: z.literal("preset"),
      provider: providerIdSchema,
      level: z.enum(presetLevels),
      overrides: taskRoutesSchema.default({}),
    })
    .strict(),
]);
export type ProjectRouting = z.infer<typeof projectRoutingSchema>;

/**
 * The runtime fields a preset sets: the default provider and its tiers.
 * A Claude preset keeps `fallbackRoutes` as the OpenAI tiers, which only
 * the budget fallback to OpenAI uses.
 */
export function presetRouting(
  provider: ProviderId,
  level: PresetLevel,
  fallbackRoutes: Record<keyof typeof defaultTierRoutes, string> = defaultTierRoutes,
) {
  const tiers = modelPresets[provider][level];
  return provider === "anthropic"
    ? {
        defaultProvider: "anthropic" as const,
        anthropicTierRoutes: {
          fast: tiers.fast,
          standard: tiers.standard,
          quality: tiers.quality,
        },
        modelRoutes: fallbackRoutes,
      }
    : {
        defaultProvider: "openai" as const,
        modelRoutes: {
          fast: tiers.fast,
          standard: tiers.standard,
          quality: tiers.quality,
          escalation: tiers.escalation ?? tiers.quality,
        },
      };
}

/** Every model a preset names. */
export function presetModels(provider: ProviderId, level: PresetLevel) {
  return [...new Set(Object.values(modelPresets[provider][level]))];
}

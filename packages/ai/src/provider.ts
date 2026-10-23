import { z } from "zod";
import type { Rate } from "./cost.ts";

/** The runtime text providers Orbit can call. Images and embeddings stay on OpenAI. */
export const providerIds = ["openai", "anthropic"] as const;
export type ProviderId = (typeof providerIds)[number];
export const providerIdSchema = z.enum(providerIds);

/** Capabilities a model entry may declare; informational for the admin view. */
export const modelCapabilities = [
  "text",
  "streaming",
  "tools",
  "structured_output",
  "web_search",
  "prompt_caching",
  "vision",
  "image_generation",
  "embedding",
] as const;
export type ModelCapability = (typeof modelCapabilities)[number];

/**
 * One entry of the owner-maintained model registry: which provider serves
 * the model and how the admin view labels it. Whether a model may be used is
 * still the verified-model allowlist, its price the rate card and its use
 * the task routes; the registry adds nothing to those checks.
 */
export const modelEntrySchema = z
  .object({
    provider: providerIdSchema,
    displayName: z.string().trim().min(1).max(80).optional(),
    capabilities: z.array(z.enum(modelCapabilities)).max(12).optional(),
    /** Free text for the owner (for example the source of the price). */
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export const modelRegistrySchema = z.record(
  z.string().trim().min(1).max(120),
  modelEntrySchema,
);
export type ModelRegistry = z.infer<typeof modelRegistrySchema>;

/**
 * The provider that serves `model`: the registry entry when the owner made
 * one, otherwise the `claude-` prefix means Anthropic and everything else is
 * OpenAI (every model Orbit has used so far).
 */
export function providerOfModel(
  model: string,
  registry?: ModelRegistry | null,
): ProviderId {
  const entry = registry?.[model];
  if (entry) return entry.provider;
  return /^claude-/i.test(model.trim()) ? "anthropic" : "openai";
}

/** Span name of one model call of a provider, as Operations → AI runs shows it. */
export function providerCallName(
  provider: ProviderId,
  kind: "create" | "stream",
) {
  return provider === "anthropic" ? `messages.${kind}` : `responses.${kind}`;
}

/**
 * Suggested Anthropic models, prices and capabilities, read from the official
 * documentation on `verifiedAt`. This is a prefill for the owner's
 * configuration, never a runtime default: a model is used only after the
 * owner saved it in the verified list and the rate card, where the price
 * stays until the owner changes it (MODEL_ROUTING.md).
 *
 * Prices are USD micros per million tokens. Cache reads are 0.05x the input
 * price on Opus 5.5 and Sonnet 5.5 and 0.1x on Haiku 5.5; a 5-minute cache
 * write is 1.25x. Haiku 5.5 is priced for prompts up to 100,000 tokens;
 * Orbit's request limits keep every prompt far below that. Web search is
 * USD 10 per 1,000 searches on every model.
 */
export const anthropicCatalog = {
  verifiedAt: "2026-10-19T00:00:00.000Z",
  sources: [
    "https://platform.claude.com/docs/en/about-claude/models/overview",
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool",
  ],
  models: {
    "claude-haiku-5-5": {
      displayName: "Claude Haiku 5.5",
      use: "Simple tasks, classification and routing",
      rate: {
        inputMicrosPerMillion: 100_000,
        outputMicrosPerMillion: 500_000,
        cachedInputMicrosPerMillion: 10_000,
        cacheWriteMicrosPerMillion: 125_000,
        webSearchMicrosPerCall: 10_000,
      },
    },
    "claude-sonnet-5-5": {
      displayName: "Claude Sonnet 5.5",
      use: "Default model for agents, copywriting and knowledge work",
      rate: {
        inputMicrosPerMillion: 2_000_000,
        outputMicrosPerMillion: 10_000_000,
        cachedInputMicrosPerMillion: 100_000,
        cacheWriteMicrosPerMillion: 2_500_000,
        webSearchMicrosPerCall: 10_000,
      },
    },
    "claude-opus-5-5": {
      displayName: "Claude Opus 5.5",
      use: "Complex analyses and strategy",
      rate: {
        inputMicrosPerMillion: 4_000_000,
        outputMicrosPerMillion: 20_000_000,
        cachedInputMicrosPerMillion: 200_000,
        cacheWriteMicrosPerMillion: 5_000_000,
        webSearchMicrosPerCall: 10_000,
      },
    },
  },
  capabilities: [
    "text",
    "streaming",
    "tools",
    "structured_output",
    "web_search",
    "prompt_caching",
    "vision",
  ] satisfies ModelCapability[],
  /** Suggested task routes (the request's start configuration); the owner applies them. */
  suggestedRoutes: {
    chat_operator: "claude-sonnet-5-5",
    draft_social: "claude-sonnet-5-5",
    draft_blog: "claude-sonnet-5-5",
    agent_strategy: "claude-opus-5-5",
    agent_research: "claude-sonnet-5-5",
    agent_analytics: "claude-haiku-5-5",
    agent_review: "claude-sonnet-5-5",
    support_triage: "claude-haiku-5-5",
    support_draft: "claude-sonnet-5-5",
    finance_extraction: "claude-sonnet-5-5",
  },
  tiers: {
    fast: "claude-haiku-5-5",
    standard: "claude-sonnet-5-5",
    quality: "claude-opus-5-5",
  },
} as const;

/** The catalog's rate card entries, dated with the catalog's verification date. */
export function anthropicCatalogRateCard(): Record<string, Rate> {
  return Object.fromEntries(
    Object.entries(anthropicCatalog.models).map(([model, entry]) => [
      model,
      { ...entry.rate, verifiedAt: anthropicCatalog.verifiedAt },
    ]),
  );
}

/** The catalog's model registry entries. */
export function anthropicCatalogRegistry(): ModelRegistry {
  return Object.fromEntries(
    Object.entries(anthropicCatalog.models).map(([model, entry]) => [
      model,
      {
        provider: "anthropic" as const,
        displayName: entry.displayName,
        capabilities: [...anthropicCatalog.capabilities],
        note: `${entry.use}; price read ${anthropicCatalog.verifiedAt.slice(0, 10)} from the official pricing page.`,
      },
    ]),
  );
}

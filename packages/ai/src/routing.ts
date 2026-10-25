import { z } from "zod";
import { modelRoutes as defaultTierRoutes } from "../../config/src/index.ts";
import type { OpenAiRuntimeConfig } from "./index.ts";
import { providerOfModel, type ProviderId } from "./provider.ts";

export const taskClasses = [
  "chat_operator",
  "draft_social",
  "draft_blog",
  // Orbit Agents specialists; copy keeps the draft routes, visual the image route.
  "agent_strategy",
  "agent_research",
  "agent_analytics",
  "agent_review",
  // Support AI (WP5.6): ticket triage and grounded draft replies for agents.
  "support_triage",
  "support_draft",
  // Finance module: structured extraction from receipt PDFs and images.
  "finance_extraction",
  // AI project manager (ADR 0017): plans and coding briefs; reports and analyses.
  "pm_plan",
  "pm_analysis",
] as const;
export type TaskClass = (typeof taskClasses)[number];
export const reasoningEfforts = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const modelRouteSchema = z
  .object({
    model: z.string().trim().min(1).max(120),
    reasoningEffort: z.enum(reasoningEfforts).optional(),
    maxOutputTokens: z.number().int().min(256).max(16000),
  })
  .strict();
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export const taskRoutesSchema = z
  .object({
    chat_operator: modelRouteSchema.optional(),
    draft_social: modelRouteSchema.optional(),
    draft_blog: modelRouteSchema.optional(),
    agent_strategy: modelRouteSchema.optional(),
    agent_research: modelRouteSchema.optional(),
    agent_analytics: modelRouteSchema.optional(),
    agent_review: modelRouteSchema.optional(),
    support_triage: modelRouteSchema.optional(),
    support_draft: modelRouteSchema.optional(),
    finance_extraction: modelRouteSchema.optional(),
    pm_plan: modelRouteSchema.optional(),
    pm_analysis: modelRouteSchema.optional(),
  })
  .strict();
/** The tier models of a second provider (Anthropic); the OpenAI tiers stay `modelRoutes`. */
export const providerTierRoutesSchema = z
  .object({
    fast: z.string().trim().min(1).max(120),
    standard: z.string().trim().min(1).max(120),
    quality: z.string().trim().min(1).max(120),
  })
  .strict();
export type ProviderTierRoutes = z.infer<typeof providerTierRoutesSchema>;
export const defaultOutputTokens: Record<TaskClass, number> = {
  chat_operator: 3000,
  draft_social: 1800,
  draft_blog: 1800,
  agent_strategy: 3000,
  agent_research: 3000,
  agent_analytics: 1800,
  agent_review: 1800,
  support_triage: 800,
  support_draft: 1800,
  finance_extraction: 4000,
  // A plan of up to 80 tasks with criteria and dependencies.
  pm_plan: 12000,
  pm_analysis: 3000,
};
// Tier used when no explicit task route is configured.
export const legacyTier: Record<TaskClass, "standard" | "quality"> = {
  chat_operator: "standard",
  draft_social: "standard",
  draft_blog: "quality",
  agent_strategy: "standard",
  agent_research: "standard",
  agent_analytics: "standard",
  agent_review: "quality",
  support_triage: "standard",
  support_draft: "quality",
  finance_extraction: "standard",
  pm_plan: "quality",
  pm_analysis: "standard",
};

// Blog drafts use the blog route; every other content type uses the social route.
export function draftTaskClass(contentType: string): TaskClass {
  return contentType === "blog" ? "draft_blog" : "draft_social";
}

export type RoutingRuntime = Pick<
  OpenAiRuntimeConfig,
  | "verifiedModels"
  | "modelRoutes"
  | "taskRoutes"
  | "models"
  | "defaultProvider"
  | "anthropicTierRoutes"
>;

/** `ROUTE_EFFORT_UNSUPPORTED` when the route names an effort its provider has no value for. */
export function assertRouteEffort(route: ModelRoute, provider: ProviderId) {
  if (provider === "anthropic" && route.reasoningEffort === "none")
    throw new Error("ROUTE_EFFORT_UNSUPPORTED");
}

/**
 * The route of a task class: the owner's explicit task route, otherwise the
 * tier model of the default provider (the Anthropic tiers when the owner set
 * `defaultProvider: "anthropic"` and saved them, else the OpenAI tiers). With
 * `provider` the tier fallback of that provider is forced (the budget
 * fallback, plan D-A7). The model must be verified; fail closed otherwise.
 */
export function resolveRoute(
  taskClass: TaskClass,
  runtime: RoutingRuntime,
  options: { provider?: ProviderId } = {},
): ModelRoute {
  const tier = legacyTier[taskClass];
  const tierRoutes = options.provider
    ? options.provider === "anthropic"
      ? runtime.anthropicTierRoutes
      : (runtime.modelRoutes ?? defaultTierRoutes)
    : runtime.defaultProvider === "anthropic" && runtime.anthropicTierRoutes
      ? runtime.anthropicTierRoutes
      : (runtime.modelRoutes ?? defaultTierRoutes);
  if (!tierRoutes) throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
  const explicit = options.provider
    ? undefined
    : runtime.taskRoutes?.[taskClass];
  const route: ModelRoute = explicit ?? {
    model: tierRoutes[tier],
    maxOutputTokens: defaultOutputTokens[taskClass],
  };
  if (!runtime.verifiedModels.includes(route.model))
    throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
  const provider = providerOfModel(route.model, runtime.models);
  if (options.provider && provider !== options.provider)
    throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
  assertRouteEffort(route, provider);
  return route;
}

/** The provider of a resolved route. */
export function routeProvider(
  route: Pick<ModelRoute, "model">,
  runtime: Pick<OpenAiRuntimeConfig, "models">,
): ProviderId {
  return providerOfModel(route.model, runtime.models);
}

// Escalation is allowed once, only after two failed corrections.
export function escalationEligible(
  correctionAttempts: number,
  escalationsUsed: number,
): boolean {
  if (correctionAttempts > 2) throw new Error("RETRY_LIMIT");
  return correctionAttempts >= 2 && escalationsUsed === 0;
}

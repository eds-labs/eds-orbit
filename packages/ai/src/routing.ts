import { z } from "zod";
import { modelRoutes as defaultTierRoutes } from "../../config/src/index.ts";
import type { OpenAiRuntimeConfig } from "./index.ts";

export const taskClasses = [
  "chat_operator",
  "draft_social",
  "draft_blog",
  // Orbit Agents specialists; copy keeps the draft routes, visual the image route.
  "agent_strategy",
  "agent_research",
  "agent_analytics",
  "agent_review",
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
  })
  .strict();
export const defaultOutputTokens: Record<TaskClass, number> = {
  chat_operator: 3000,
  draft_social: 1800,
  draft_blog: 1800,
  agent_strategy: 1800,
  agent_research: 1800,
  agent_analytics: 1800,
  agent_review: 1800,
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
};

// Blog drafts use the blog route; every other content type uses the social route.
export function draftTaskClass(contentType: string): TaskClass {
  return contentType === "blog" ? "draft_blog" : "draft_social";
}

export function resolveRoute(
  taskClass: TaskClass,
  runtime: Pick<
    OpenAiRuntimeConfig,
    "verifiedModels" | "modelRoutes" | "taskRoutes"
  >,
): ModelRoute {
  const route: ModelRoute = runtime.taskRoutes?.[taskClass] ?? {
    model: (runtime.modelRoutes ?? defaultTierRoutes)[legacyTier[taskClass]],
    maxOutputTokens: defaultOutputTokens[taskClass],
  };
  if (!runtime.verifiedModels.includes(route.model))
    throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
  return route;
}

// Escalation is allowed once, only after two failed corrections.
export function escalationEligible(
  correctionAttempts: number,
  escalationsUsed: number,
): boolean {
  if (correctionAttempts > 2) throw new Error("RETRY_LIMIT");
  return correctionAttempts >= 2 && escalationsUsed === 0;
}

// Mirror of the effective AI view of apps/api
// (platform/management/ai-effective.ts and RoutingMode of
// platform/ai/effective-configuration.ts). The web app never imports server
// code, so the shapes are copied by hand; types.test.tsx fails when the value
// lists or the field names drift.

export const AI_ORIGINS = [
  "environment",
  "system",
  "organization",
  "preset",
  "project",
] as const;
export type AiOrigin = (typeof AI_ORIGINS)[number];

export const ROUTING_MODES = [
  "unsaved",
  "custom",
  "preset",
  "organization",
] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const READINESS_REASONS = [
  "no_key",
  "project_key_unverifiable",
  "environment_key_unverifiable",
  "connection_not_checked",
  "connection_failed",
  "connection_disabled",
  "no_text_route",
  "text_not_ready",
] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];

export const OPENAI_TIERS = [
  "fast",
  "standard",
  "quality",
  "escalation",
] as const;
export const ANTHROPIC_TIERS = ["fast", "standard", "quality"] as const;
export const AI_PROVIDERS = ["openai", "anthropic"] as const;
export const KEY_NAMES = ["openai", "image", "anthropic"] as const;
type Provider = (typeof AI_PROVIDERS)[number];
type KeyName = (typeof KEY_NAMES)[number];

export type Traced<T> = {
  stored: T | null;
  effective: T | null;
  origin: AiOrigin | null;
};
export type TracedRoute = {
  stored: {
    model: string;
    reasoningEffort?: string;
    maxOutputTokens: number;
  } | null;
  effective:
    | {
        model: string;
        reasoningEffort?: string;
        maxOutputTokens: number;
        provider: Provider;
        price: "current" | "missing";
      }
    | { error: string };
  explicit: boolean;
  origin: AiOrigin | null;
};
export type KeyTrace = {
  /** The project saved its own key (for `image`: its own image key). */
  stored: boolean;
  /** A call would have a key; image calls fall back to the OpenAI text key. */
  effective: boolean;
  origin: Exclude<AiOrigin, "preset"> | null;
  connection: { label: string; status: string; disabled: boolean } | null;
};
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

/** GET /management/projects/:projectId/ai/effective. */
export type ProjectAiEffective = {
  projectId: string;
  routingMode: RoutingMode;
  routingApplied: boolean;
  /** Only with routingMode "organization". */
  standardSource: "organization" | "system" | null;
  exceptions: {
    models: boolean;
    routes: boolean;
    prices: boolean;
    providerBudgets: boolean;
    keys: KeyName[];
  };
  defaultProvider: Traced<Provider>;
  tiers: {
    openai: Record<(typeof OPENAI_TIERS)[number], Traced<string>>;
    anthropic: Record<(typeof ANTHROPIC_TIERS)[number], Traced<string>>;
  };
  /** By task class; a class this build does not know shows by its id. */
  taskRoutes: Record<string, TracedRoute>;
  fallback: Traced<"none" | "openai">;
  imageModel: Traced<string>;
  keys: Record<KeyName, KeyTrace>;
  providerBudgets: Record<Provider, Traced<ProviderBudgetValue>>;
  readiness: Record<Provider, ProviderReadiness>;
};

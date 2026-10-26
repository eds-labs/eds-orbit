import {
  aiDefaultsSchema,
  modelPresets,
  presetModels,
  type AiDefaults,
} from "../../../../../packages/ai/src/index.ts";
import { aiDefaultsEnabled } from "../ai/catalog.ts";
import type { AiProfileData } from "../ai/central-ai.ts";
import { DomainError } from "../shared.ts";
import { listModelPrices } from "./ai-catalog.ts";
import { aiProfile, saveAiProfile } from "./ai-profiles.ts";

// "Standard-Modelle" of the system (administrators) and of an organization
// (its owners), plans/ai-central-management.md phase B: a provider and a
// level instead of tiers and task routes, an image model and, advanced,
// one model per task. Stored on the AI profile as `defaults`; they apply
// while ORBIT_AI_DEFAULTS (and the catalog) is on, to projects without own
// settings and to projects that chose the organization's standard.

type Target = { scope: "system" } | { scope: "workspace"; workspaceId: string };

/** The target's standard models, the presets and whether they apply now. */
export async function aiDefaults(target: Target) {
  const profile = await aiProfile(target);
  const parsed = aiDefaultsSchema.safeParse(
    (profile.data as { defaults?: unknown }).defaults,
  );
  return {
    scope: target.scope,
    enabled: aiDefaultsEnabled(),
    defaults: parsed.success ? parsed.data : null,
    presets: modelPresets,
    version: profile.version,
  };
}

/**
 * Saves the target's standard models: every model they name must be an
 * active catalog model of the right purpose in the target's catalog, and a
 * Claude task route may not use the effort `none`.
 */
export async function saveAiDefaults(actorId: string, target: Target, raw: unknown) {
  const defaults = aiDefaultsSchema.parse(raw);
  const catalog = new Map(
    (await listModelPrices(target)).models
      .filter((m) => m.active)
      .map((m) => [m.id, m]),
  );
  const text = (model: string) => catalog.get(model)?.purpose === "text";
  if (presetModels(defaults.provider, defaults.level).some((m) => !text(m)))
    throw new DomainError("PRESET_MODEL_INACTIVE");
  if (defaults.imageModel && catalog.get(defaults.imageModel)?.purpose !== "image")
    throw new DomainError("IMAGE_MODEL_NOT_VERIFIED");
  for (const route of Object.values(defaults.taskRoutes)) {
    if (!text(route!.model)) throw new DomainError("ROUTED_MODEL_NOT_VERIFIED");
    if (
      route!.reasoningEffort === "none" &&
      catalog.get(route!.model)?.provider === "anthropic"
    )
      throw new DomainError("ROUTE_EFFORT_UNSUPPORTED");
  }
  await saveProfileDefaults(actorId, target, defaults);
  return aiDefaults(target);
}

/** Removes the target's standard models; its profile fields apply again. */
export async function clearAiDefaults(actorId: string, target: Target) {
  const profile = (await aiProfile(target)).data as AiProfileData;
  if (profile.defaults) await saveProfileDefaults(actorId, target, undefined);
  return aiDefaults(target);
}

async function saveProfileDefaults(
  actorId: string,
  target: Target,
  defaults: AiDefaults | undefined,
) {
  const { defaults: _previous, ...rest } = (await aiProfile(target))
    .data as AiProfileData;
  await saveAiProfile(actorId, target, defaults ? { ...rest, defaults } : rest);
}

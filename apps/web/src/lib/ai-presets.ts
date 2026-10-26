import type { Locale } from "./i18n";
import { budgetRefusalText } from "./budget-refusals";

// Shared wording for the organization's standard models and the project's
// model choice (plans/ai-central-management.md, phase B).

export type AiProvider = "openai" | "anthropic";
export type PresetLevel = "economy" | "balanced" | "quality";
export type PresetTiers = {
  fast: string;
  standard: string;
  quality: string;
  escalation?: string;
};
export type Presets = Record<AiProvider, Record<PresetLevel, PresetTiers>>;
export type TaskRoute = {
  model: string;
  reasoningEffort?: string;
  maxOutputTokens: number;
};
export type AiDefaults = {
  provider: AiProvider;
  level: PresetLevel;
  imageModel?: string;
  taskRoutes: Partial<Record<string, TaskRoute>>;
};

export const presetLevels: PresetLevel[] = ["economy", "balanced", "quality"];
export const aiProviderName: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
};

const levelText = {
  en: { economy: "Economy", balanced: "Balanced", quality: "Best quality" },
  de: { economy: "Günstig", balanced: "Ausgewogen", quality: "Beste Qualität" },
} as const;
export const levelName = (level: PresetLevel, locale: Locale) =>
  levelText[locale === "de" ? "de" : "en"][level];

/** "Claude · Balanced" */
export const presetName = (
  preset: { provider: AiProvider; level: PresetLevel },
  locale: Locale,
) => `${aiProviderName[preset.provider]} · ${levelName(preset.level, locale)}`;

/** "fast Haiku, standard Sonnet, quality Opus" from a preset's tiers. */
export function tiersText(tiers: PresetTiers, locale: Locale) {
  const de = locale === "de";
  return [
    `${de ? "schnell" : "fast"} ${tiers.fast}`,
    `${de ? "Standard" : "standard"} ${tiers.standard}`,
    `${de ? "Qualität" : "quality"} ${tiers.quality}`,
  ].join(", ");
}

/** The task classes with their names and default output tokens. */
export const aiTasks = [
  { id: "chat_operator", en: "Assistant chat", de: "Assistent-Chat", tokens: 3000 },
  { id: "draft_social", en: "Social drafts", de: "Social-Entwürfe", tokens: 1800 },
  { id: "draft_blog", en: "Blog drafts", de: "Blog-Entwürfe", tokens: 1800 },
  { id: "agent_strategy", en: "Agent strategy", de: "Agent Strategie", tokens: 3000 },
  { id: "agent_research", en: "Agent research", de: "Agent Recherche", tokens: 3000 },
  { id: "agent_analytics", en: "Agent analytics", de: "Agent Analyse", tokens: 1800 },
  { id: "agent_review", en: "Agent review", de: "Agent Prüfung", tokens: 1800 },
  { id: "support_triage", en: "Support triage", de: "Support-Einordnung", tokens: 800 },
  { id: "support_draft", en: "Support replies", de: "Support-Antworten", tokens: 1800 },
  { id: "finance_extraction", en: "Finance extraction", de: "Finanz-Auslesen", tokens: 4000 },
  // AI project manager (ADR 0017).
  { id: "pm_plan", en: "Project manager plans", de: "KI-Projektleiter: Pläne", tokens: 12000 },
  { id: "pm_analysis", en: "Project manager reports", de: "KI-Projektleiter: Berichte", tokens: 3000 },
] as const;
export const taskName = (task: (typeof aiTasks)[number], locale: Locale) =>
  locale === "de" ? task.de : task.en;

/**
 * Task deviations from form values `task-<id>`: a chosen model keeps the
 * route's effort and tokens if it had one, else the task's default tokens.
 */
export function taskRoutesFrom(
  values: Record<string, unknown>,
  current: Partial<Record<string, TaskRoute>> = {},
) {
  return Object.fromEntries(
    aiTasks.flatMap((task) => {
      const model = String(values[`task-${task.id}`] ?? "");
      if (!model) return [];
      const previous = current[task.id];
      return [
        [
          task.id,
          previous && previous.model === model
            ? previous
            : { model, maxOutputTokens: previous?.maxOutputTokens ?? task.tokens },
        ],
      ];
    }),
  );
}

const errors: Record<string, { en: string; de: string }> = {
  PRESET_MODEL_INACTIVE: {
    en: "A model of this level is switched off under “Models & prices”. Switch it on or pick another level.",
    de: "Ein Modell dieser Stufe ist unter „Modelle & Preise“ ausgeschaltet. Schalte es ein oder wähle eine andere Stufe.",
  },
  ROUTED_MODEL_NOT_VERIFIED: {
    en: "A chosen task model is not available. Pick a model from the list.",
    de: "Ein gewähltes Aufgabenmodell ist nicht verfügbar. Wähle ein Modell aus der Liste.",
  },
  IMAGE_MODEL_NOT_VERIFIED: {
    en: "The image model is not available. Pick an image model from the list.",
    de: "Das Bildmodell ist nicht verfügbar. Wähle ein Bildmodell aus der Liste.",
  },
  ROUTE_EFFORT_UNSUPPORTED: {
    en: "Claude models do not support the effort “none”.",
    de: "Claude-Modelle unterstützen den Aufwand „none“ nicht.",
  },
  AI_DEFAULTS_DISABLED: {
    en: "Standard models are not switched on for this installation yet.",
    de: "Standard-Modelle sind für diese Installation noch nicht eingeschaltet.",
  },
  AI_KEY_REQUIRED: {
    en: "Add an API key first, or ask the organization owner to grant one.",
    de: "Hinterlege zuerst einen API-Key oder lass dir einen von der Organisation zuteilen.",
  },
  OPENAI_API_KEY_REQUIRED: {
    en: "Enter an OpenAI API key.",
    de: "Gib einen OpenAI-API-Key ein.",
  },
  ANTHROPIC_API_KEY_REQUIRED: {
    en: "Enter a Claude API key.",
    de: "Gib einen Claude-API-Key ein.",
  },
};

/** A readable message for an AI settings error code; the code otherwise. */
export function aiErrorText(message: string | null | undefined, locale: Locale) {
  if (!message) return null;
  return (
    errors[message.replaceAll(" ", "_")]?.[locale === "de" ? "de" : "en"] ??
    budgetRefusalText(message, locale === "de") ??
    message
  );
}

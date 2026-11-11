import { describe, expect, it } from "vitest";
import type { FormField } from "@/platform/ui/form";
import {
  anthropicFields,
  anthropicPayload,
  firstSaveConfirmed,
  firstSaveFields,
  imageModelOptions,
  modelsPayload,
  openAiFields,
  providerBudgetFields,
  providerPayload,
  routeTaskClasses,
  taskRoutesPayload,
  type AiConfigurationData,
  type StoredAiView,
} from "./ai-settings";

// CS-D6 (R64): the Creative Studio's vision review gets a route only while it is on.
describe("routeTaskClasses", () => {
  it("lists the creative vision review only with the Creative Studio on", () => {
    const ids = (studio: boolean) =>
      routeTaskClasses(studio).map((task) => task.id);
    expect(ids(false)).not.toContain("creative_review");
    expect(ids(true)).toContain("creative_review");
    expect(ids(false)).toContain("issue_triage");
  });
});

const tiers = {
  fast: "gpt-5.6-luna",
  standard: "gpt-5.6-terra",
  quality: "gpt-5.6-sol",
  escalation: "gpt-5.6-sol",
};
const preset: NonNullable<StoredAiView["routing"]> = {
  source: "preset",
  provider: "openai",
  level: "balanced",
  overrides: {},
};

function storedFixture(over: Partial<StoredAiView> = {}): StoredAiView {
  return {
    version: 3,
    verifiedModels: ["gpt-5.6-terra"],
    rateCard: {},
    modelRoutes: tiers,
    taskRoutes: {},
    imageGeneration: { model: "gpt-image-2.5-flare", maxCostMicrosPerImage: 0 },
    defaultProvider: "openai",
    anthropicTierRoutes: null,
    models: {},
    providerBudgets: {},
    fallback: { onProviderBudgetStop: "none" },
    routing: null,
    ...over,
  };
}

// An effective view as the API returns it; `stored` is the project's own part.
function view(over: Partial<AiConfigurationData>): AiConfigurationData {
  return {
    configured: true,
    source: "environment",
    textKeyConfigured: true,
    imageKeyConfigured: true,
    dedicatedImageKeyConfigured: false,
    verifiedModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    rateCard: {},
    modelRoutes: tiers,
    imageGeneration: { model: "gpt-image-2.5-flare", maxCostMicrosPerImage: 0 },
    taskRoutes: {},
    catalog: null,
    stored: null,
    defaultProvider: "openai",
    anthropicTierRoutes: null,
    models: {},
    providerBudgets: {
      openai: {
        monthlyMicros: 50_000_000,
        warnMicros: 30_000_000,
        warn2Micros: 40_000_000,
        stopMicros: 45_000_000,
        anchorDay: 5,
      },
    },
    fallback: { onProviderBudgetStop: "none" },
    providers: {
      openai: { keyConfigured: true, source: "environment" },
      anthropic: { keyConfigured: false, source: "none" },
    },
    suggestions: {
      anthropic: {
        verifiedAt: "2026-11-01T00:00:00.000Z",
        sources: ["https://docs.anthropic.com"],
        rateCard: {},
        models: {},
        tiers: {
          fast: "claude-suggested-fast",
          standard: "claude-suggested-standard",
          quality: "claude-suggested-quality",
        },
        routes: {},
      },
    },
    ...over,
  };
}

const field = (fields: FormField[], name: string) => {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
};

describe("project AI dialogs save only what they show (F-8)", () => {
  it("saves the stored default provider of a project on a preset (risk 2)", () => {
    const v = view({ defaultProvider: "anthropic", stored: storedFixture({ defaultProvider: "openai", routing: preset }) });
    expect(providerPayload(v).defaultProvider).toBe("openai");
    expect(field(anthropicFields(v, "en"), "defaultProvider").value).toBe("openai");
  });
  it("saves the stored model section, not the view's (risk 1 and 2)", () => {
    const v = view({ verifiedModels: ["env-model"], stored: storedFixture({ verifiedModels: ["own-model"] }) });
    expect(modelsPayload(v).verifiedModels).toEqual(["own-model"]);
  });
  it("asks before a first save and only then (risk 1)", () => {
    expect(firstSaveFields(view({ stored: null }), "en")).toEqual([
      expect.objectContaining({ name: "firstSave", type: "checkbox", required: true, value: false }),
    ]);
    expect(firstSaveFields(view({ stored: storedFixture() }), "en")).toEqual([]);
    expect(firstSaveConfirmed(view({ stored: null }), {})).toBe(false);
    expect(firstSaveConfirmed(view({ stored: null }), { firstSave: true })).toBe(true);
  });
  it("keeps the route of a task the dialog does not show (risk 3)", () => {
    const stored = { creative_review: { model: "gpt-5.6-terra", maxOutputTokens: 1500 } };
    const routes = taskRoutesPayload({ "route-chat_operator-model": "gpt-5.6-luna" }, routeTaskClasses(false), stored);
    expect(routes.creative_review).toEqual(stored.creative_review);
    expect(routes.chat_operator).toMatchObject({ model: "gpt-5.6-luna", maxOutputTokens: 3000 });
  });
  it("writes nothing by preselection (risk 4)", () => {
    const v = view({ verifiedModels: [], stored: storedFixture({ anthropicTierRoutes: null, providerBudgets: {} }) });
    expect(field(anthropicFields(v, "en"), "applyCatalog").value).toBe(false);
    expect(field(anthropicFields(v, "en"), "tier-fast").value).toBe("");
    expect(field(openAiFields(v, "en"), "imagePriceChecked").value).toBe(false);
    expect(field(providerBudgetFields("openai", v, "en"), "monthly").value).toBe("");
    expect(anthropicPayload(v, { defaultProvider: "openai", fallback: "none" })).not.toHaveProperty("providers.anthropicTierRoutes");
    expect(anthropicPayload(v, { "tier-fast": "claude-x", fallback: "none" })).toEqual({ error: "CLAUDE_TIERS_INCOMPLETE" });
  });
  it("keeps a stored image model that is not in the list (risk 4)", () => {
    expect(imageModelOptions("gpt-image-legacy", "en").map((o) => o.value)).toContain("gpt-image-legacy");
    expect(imageModelOptions("gpt-image-2.5-flare", "en")).toHaveLength(4);
  });
  it("leaves model fields out while the project follows the standard", () => {
    const names = anthropicFields(view({}), "en", { followsStandard: true }).map((f) => f.name);
    expect(names).not.toContain("tier-fast");
    expect(names).not.toContain("defaultProvider");
    expect(names).not.toContain("applyCatalog");
    expect(openAiFields(view({}), "en", { followsStandard: true }).map((f) => f.name)).not.toContain("model-fast");
  });
});

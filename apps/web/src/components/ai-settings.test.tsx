import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Identity, Project } from "@/lib/api";
import type { FormField } from "@/platform/ui/form";
import { WorkspaceContext } from "./workspace-context";
import {
  AiModelsPanel,
  AiProviderBudgetPanels,
  AiProvidersPanel,
  anthropicFields,
  anthropicPayload,
  firstSaveConfirmed,
  firstSaveFields,
  imageModelOptions,
  modelChoiceProps,
  modelsPayload,
  openAiFields,
  providerBudgetFields,
  providerPayload,
  routeTaskClasses,
  setupKeyProps,
  taskRouteFields,
  taskRoutesPayload,
  type AiBudgetView,
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
  it("words the first save for the section it writes (review I3)", () => {
    const hint = (section?: "models" | "settings", locale: "en" | "de" = "en") =>
      firstSaveFields(view({ stored: null }), locale, section)[0]!.hint;
    expect(hint()).toBe(hint("models"));
    expect(hint("models")).toBe(
      "This project has no AI settings of its own yet. Saving copies the models, prices and tiers shown here into the project. From then on the environment's key no longer serves it, and the organization's and system's model settings no longer apply to the fields saved here.",
    );
    expect(hint("settings")).toBe(
      "This project has no AI settings of its own yet. Saving creates them, at first without models and prices of its own. From then on the environment's key no longer serves the project, and values it took over so far from the organization, the system or the environment can stop applying. Check models, keys and budgets afterwards.",
    );
    expect(hint("settings", "de")).toBe(
      "Dieses Projekt hat noch keine eigenen KI-Einstellungen. Beim Speichern werden sie angelegt, zunächst ohne eigene Modelle und Preise. Danach gilt der Schlüssel aus der Umgebung für das Projekt nicht mehr, und Werte, die es bisher von Organisation, System oder Umgebung übernommen hat, können entfallen. Prüfe danach Modelle, Schlüssel und Budgets.",
    );
    expect(firstSaveFields(view({ stored: null }), "en", "settings")[0]!.label).toBe(
      firstSaveFields(view({ stored: null }), "en", "models")[0]!.label,
    );
    expect(firstSaveFields(view({ stored: storedFixture() }), "en", "settings")).toEqual([]);
    expect(firstSaveFields(view({ stored: storedFixture() }), "en", "models")).toEqual([]);
  });
  it("gives the setup wizard's models step the first-save confirmation (review I2)", () => {
    const unsaved = setupKeyProps("p-1", view({ stored: null }), "en");
    expect(unsaved.modelsFields).toEqual(firstSaveFields(view({ stored: null }), "en", "settings"));
    expect(unsaved.modelsConfirmed({ source: "organization" })).toBe(false);
    expect(unsaved.modelsConfirmed({ source: "organization", firstSave: true })).toBe(true);
    const saved = setupKeyProps("p-1", view({ stored: storedFixture() }), "en");
    expect(saved.modelsFields).toEqual([]);
    expect(saved.modelsConfirmed({ source: "preset" })).toBe(true);
  });
  it("gives the model choice the first-save confirmation unless the source writes nothing (review I2)", () => {
    const unsaved = modelChoiceProps(view({ stored: null }), "en");
    expect(unsaved.routingFields).toEqual([
      expect.objectContaining({
        name: "firstSave",
        required: true,
        hint: firstSaveFields(view({ stored: null }), "en", "settings")[0]!.hint,
        showWhen: { name: "source", values: ["organization", "preset"] },
      }),
    ]);
    expect(unsaved.routingConfirmed({ source: "organization" })).toBe(false);
    expect(unsaved.routingConfirmed({ source: "preset" })).toBe(false);
    expect(unsaved.routingConfirmed({ source: "preset", firstSave: true })).toBe(true);
    // "custom" on a project without own settings stores nothing.
    expect(unsaved.routingConfirmed({ source: "custom" })).toBe(true);
    const saved = modelChoiceProps(view({ stored: storedFixture() }), "en");
    expect(saved.routingFields).toEqual([]);
    expect(saved.routingConfirmed({ source: "organization" })).toBe(true);
  });
  it("gives the setup wizard's key step the first-save confirmation (F-8 risk 5)", () => {
    const unsaved = setupKeyProps("p-1", view({ stored: null }), "en");
    expect(unsaved.keyFields).toEqual(firstSaveFields(view({ stored: null }), "en", "settings"));
    expect(unsaved.keyFields.map((field) => field.name)).toEqual(["firstSave"]);
    expect(unsaved.keyConfirmed({})).toBe(false);
    const saved = setupKeyProps("p-1", view({ stored: storedFixture() }), "en");
    expect(saved.keyFields).toEqual([]);
    expect(saved.keyConfirmed({})).toBe(true);
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

  it("prefills the tiers and task routes from the stored values", () => {
    const v = view({
      modelRoutes: { ...tiers, fast: "gpt-5.6-env" },
      taskRoutes: { chat_operator: { model: "gpt-5.6-env", maxOutputTokens: 900 } },
      stored: storedFixture({
        modelRoutes: { ...tiers, fast: "gpt-5.6-own" },
        taskRoutes: { chat_operator: { model: "gpt-5.6-own", reasoningEffort: "low", maxOutputTokens: 2500 } },
      }),
    });
    expect(field(openAiFields(v, "en"), "model-fast").value).toBe("gpt-5.6-own");
    const routes = taskRouteFields(v, routeTaskClasses(false), "en");
    expect(field(routes, "route-chat_operator-model").value).toBe("gpt-5.6-own");
    expect(field(routes, "route-chat_operator-effort").value).toBe("low");
    expect(field(routes, "route-chat_operator-max-tokens").value).toBe(2500);
  });
  it("sends exactly the three tiers when all are filled", () => {
    const v = view({ stored: storedFixture() });
    const tiersIn = { "tier-fast": "claude-a", "tier-standard": "claude-b", "tier-quality": "claude-c" };
    expect(anthropicPayload(v, { ...tiersIn, fallback: "none" })).toMatchObject({
      providers: { anthropicTierRoutes: { fast: "claude-a", standard: "claude-b", quality: "claude-c" } },
    });
  });
  it("adds the suggested tiers when the catalog box is ticked and no tiers exist (review I1)", () => {
    const empty = { "tier-fast": "", "tier-standard": "", "tier-quality": "", fallback: "none" };
    const suggested = view({}).suggestions.anthropic.tiers;
    const saved = view({ stored: storedFixture({ anthropicTierRoutes: null }) });
    expect(anthropicPayload(saved, { ...empty, applyCatalog: true })).toMatchObject({
      providers: { anthropicTierRoutes: suggested },
    });
    // Before a first save, too, when the view has no Claude tiers.
    expect(anthropicPayload(view({ stored: null }), { ...empty, applyCatalog: true })).toMatchObject({
      providers: { anthropicTierRoutes: suggested },
    });
    // Unticked: nothing is preselected.
    expect(anthropicPayload(saved, { ...empty, applyCatalog: false })).not.toHaveProperty(
      "providers.anthropicTierRoutes",
    );
  });
  it("keeps stored tiers and entered tiers over the suggestion (review I1)", () => {
    const own = { fast: "claude-own-f", standard: "claude-own-s", quality: "claude-own-q" };
    const empty = { "tier-fast": "", "tier-standard": "", "tier-quality": "", fallback: "none" };
    const withOwn = view({ stored: storedFixture({ anthropicTierRoutes: own }) });
    expect(anthropicPayload(withOwn, { ...empty, applyCatalog: true })).toMatchObject({
      providers: { anthropicTierRoutes: own },
    });
    const saved = view({ stored: storedFixture({ anthropicTierRoutes: null }) });
    const entered = { "tier-fast": "claude-a", "tier-standard": "claude-b", "tier-quality": "claude-c" };
    expect(anthropicPayload(saved, { ...entered, fallback: "none", applyCatalog: true })).toMatchObject({
      providers: { anthropicTierRoutes: { fast: "claude-a", standard: "claude-b", quality: "claude-c" } },
    });
    expect(
      anthropicPayload(saved, { ...empty, "tier-fast": "claude-a", applyCatalog: true }),
    ).toEqual({ error: "CLAUDE_TIERS_INCOMPLETE" });
  });
  it("sends no tiers for a ticked box when the view offers no suggestion (review I1)", () => {
    const empty = { "tier-fast": "", "tier-standard": "", "tier-quality": "", fallback: "none" };
    const bare = view({ stored: storedFixture({ anthropicTierRoutes: null }) });
    const noSuggestion = {
      ...bare,
      suggestions: undefined,
    } as unknown as AiConfigurationData;
    expect(anthropicPayload(noSuggestion, { ...empty, applyCatalog: true })).not.toHaveProperty(
      "providers.anthropicTierRoutes",
    );
  });
  it("keeps the stored tiers when all three fields are empty", () => {
    const own = { fast: "claude-own-f", standard: "claude-own-s", quality: "claude-own-q" };
    const v = view({ stored: storedFixture({ anthropicTierRoutes: own }) });
    const payload = anthropicPayload(v, { "tier-fast": "", "tier-standard": "", "tier-quality": "", fallback: "none" });
    expect(payload).toMatchObject({ providers: { anthropicTierRoutes: own } });
  });
  it("ignores a form default provider while the project follows the standard", () => {
    const v = view({ defaultProvider: "anthropic", stored: storedFixture({ defaultProvider: "openai" }) });
    const payload = anthropicPayload(v, { defaultProvider: "anthropic", fallback: "none" }, { followsStandard: true });
    expect(payload).toMatchObject({ providers: { defaultProvider: "openai" } });
  });
  it("drops the stored route of a shown task whose model was cleared", () => {
    const stored = { chat_operator: { model: "gpt-5.6-terra", maxOutputTokens: 3000 } };
    const routes = taskRoutesPayload({ "route-chat_operator-model": "" }, routeTaskClasses(false), stored);
    expect(routes).not.toHaveProperty("chat_operator");
  });
  it("needs no confirmation once the project saved its own settings", () => {
    expect(firstSaveConfirmed(view({ stored: storedFixture() }), {})).toBe(true);
  });
});

// The panels render from fixture resources, as the hook would hand them over.
const resource = <T,>(data: T | null) => ({
  data,
  loading: false,
  error: null,
  refresh() {},
  path: null,
  errorPath: null,
});

const balanced = { fast: "luna", standard: "terra", quality: "sol" };
// Everything the page can show: the setup (text not ready), the model
// choice (defaults present), warnings, models with prices and both budgets.
function fullView(): AiConfigurationData {
  return view({
    capabilities: { text: false, search: "full_text", images: false },
    defaults: {
      standard: {
        provider: "openai",
        level: "balanced",
        taskRoutes: {},
        source: "organization",
      },
      presets: {
        openai: { economy: balanced, balanced, quality: balanced },
        anthropic: { economy: balanced, balanced, quality: balanced },
      },
    },
    routing: { source: "organization", overrides: {} },
    routesWithoutKey: ["support_reply"],
    routesNotAllowedForData: [
      {
        task: "support_reply",
        dataClass: "customer_personal",
        provider: "anthropic",
        allowed: ["openai"],
        enforced: true,
      },
    ],
    rateCard: {
      "gpt-5.6-terra": {
        inputMicrosPerMillion: 1_250_000,
        outputMicrosPerMillion: 10_000_000,
        cachedInputMicrosPerMillion: 125_000,
        verifiedAt: "2026-11-01T00:00:00.000Z",
      },
    },
    models: {
      "claude-terra": { provider: "anthropic", displayName: "Claude Terra" },
    },
    effectiveRoutes: {
      chat_operator: { model: "gpt-5.6-terra", maxOutputTokens: 3000 },
    },
    defaultProvider: "anthropic",
    fallback: { onProviderBudgetStop: "openai" },
  });
}

function budgetFixture(): AiBudgetView {
  const state = (spent: string) => ({
    configured: true,
    budget: {
      monthlyMicros: 50_000_000,
      warnMicros: 30_000_000,
      warn2Micros: 40_000_000,
      stopMicros: 45_000_000,
      anchorDay: 5,
      credit: {
        amountMicros: 12_000_000,
        verifiedAt: "2026-11-05T10:00:00.000Z",
        note: "console",
      },
    },
    level: "warn" as const,
    spend: {
      spentMicros: spent,
      settledMicros: "20000000",
      pendingMicros: "1000000",
      unknownMicros: "0",
      count: 4,
      periodStart: "2026-11-05T00:00:00.000Z",
      periodEnd: "2026-12-05T00:00:00.000Z",
    },
    creditSync: "manual" as const,
  });
  return {
    providers: { anthropic: state("31000000"), openai: state("2000000") },
  };
}

function inWorkspace(node: ReactNode, owner = true) {
  return renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project: { id: "p-1", name: "Fixture" } as unknown as Project,
        identity: {} as Identity,
        locale: "en",
        t: (key: string) => key,
        canEdit: owner,
        isOwner: owner,
        revision: 0,
        refresh: () => {},
        href: (path: string) => path,
      }}
    >
      {node}
    </WorkspaceContext.Provider>,
  );
}

describe("project AI settings as panels", () => {
  it("renders the providers panel from a configuration", () => {
    const html = inWorkspace(
      <AiProvidersPanel
        configuration={resource(fullView())}
        refreshAll={() => {}}
      />,
    );
    expect(html).toContain("AI providers");
    expect(html.match(/Configure/g)).toHaveLength(2);
    expect(html).toContain("OpenAI");
    expect(html).toContain("Anthropic (Claude)");
  });

  it("offers the task routes only while editable", () => {
    const editable = inWorkspace(
      <AiModelsPanel configuration={resource(fullView())} />,
    );
    expect(editable).toContain("Task routes");
    expect(editable).toContain("Models &amp; prices");
    expect(editable).not.toContain("organization&#x27;s standard");
    const readOnly = inWorkspace(
      <AiModelsPanel configuration={resource(fullView())} editable={false} />,
    );
    expect(readOnly).not.toContain("Task routes");
    expect(readOnly).not.toContain("Models &amp; prices");
    expect(readOnly).toContain(
      "The project follows the organization&#x27;s standard, so models and task routes are not chosen here. To choose others, change the model choice to a level or own settings.",
    );
    // The verified models stay visible either way.
    expect(readOnly).toContain("gpt-5.6-terra");
  });

  it("renders both budget panels, Claude first", () => {
    const html = inWorkspace(
      <AiProviderBudgetPanels
        configuration={resource(fullView())}
        budget={resource(budgetFixture())}
      />,
    );
    const claude = html.indexOf("Anthropic (Claude) budget");
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(claude).toBeLessThan(html.indexOf("OpenAI budget"));
  });
});

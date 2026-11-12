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
  AiSettingsView,
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

  it("renders AiSettings in today's order", () => {
    const html = inWorkspace(
      <AiSettingsView
        configuration={resource(fullView())}
        budget={resource(budgetFixture())}
        refreshAll={() => {}}
      />,
    );
    const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(
      (match) => match[1],
    );
    expect(headings).toEqual([
      "Set up AI",
      "AI providers",
      "Model choice",
      "AI models",
      "Anthropic (Claude) budget",
      "OpenAI budget",
      "AI usage &amp; costs",
    ]);
  });

  // Taken from the page before it was split into panels: the old page must
  // render exactly the same markup.
  it("renders the page as before the split", () => {
    expect(
      inWorkspace(
        <AiSettingsView
          configuration={resource(fullView())}
          budget={resource(budgetFixture())}
          refreshAll={() => {}}
        />,
      ),
    ).toMatchInlineSnapshot(`"<section class="panel"><div class="panel-head"><div><h2>Set up AI</h2><p>Three steps: access, models and budget. Nothing is charged before you allow paid use in the last step.</p></div><button data-slot="button" class="button button-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles lucide-stars" aria-hidden="true" data-icon="inline-start"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg>Start setup</button></div></section><section class="panel"><div class="panel-head"><div><h2>AI providers</h2><p>Keys are stored encrypted on the server. Image generation and semantic search (embeddings) need an OpenAI key; text also works with Claude alone.</p></div></div><div class="capability-readiness"><div class="data-row"><div><strong>Text (chat, drafts, Support, Finance)</strong><p>Needs a key for the provider of its routes.</p></div><span class="badge badge-neutral">Not configured</span></div><div class="data-row"><div><strong>Knowledge search</strong><p>Full-text search. Semantic search needs an OpenAI key; Anthropic offers no embeddings.</p></div><span class="badge badge-success">Ready</span></div><div class="data-row"><div><strong>Image generation</strong><p>Off: needs an OpenAI key, a verified image model and a current price.</p></div><span class="badge badge-neutral">Not configured</span></div><div class="alert alert-warning" role="status"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert lucide-alert-circle" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg><div>These tasks are routed to a provider without a key and fail when called: support_reply.</div></div><div class="alert alert-warning" role="status"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert lucide-alert-circle" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg><div>Customer data may only go to OpenAI. These tasks are routed to another provider and are stopped before anything is sent (AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA): support_reply (Claude). Set the route to a verified OpenAI model under “Task routes”. Orbit does not switch the provider automatically.</div></div><div class="data-row"><div><strong>OpenAI</strong><p>Key configured (environment)</p></div><span class="badge badge-success">Ready</span><button data-slot="button" class="button button-outline"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true" data-icon="inline-start"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg>Configure</button></div><div class="data-row"><div><strong>Anthropic (Claude)</strong><p>No key · default provider · fallback to OpenAI allowed</p></div><span class="badge badge-neutral">Not configured</span><button data-slot="button" class="button button-outline"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true" data-icon="inline-start"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg>Configure</button></div></div></section><section class="panel"><div class="panel-head"><div><h2>Model choice</h2><p>Which models this project&#x27;s tasks use. The organization&#x27;s standard keeps every project alike; deviate per task only where needed.</p></div><button data-slot="button" class="button button-outline">Change</button></div><div class="capability-readiness"><div class="data-row"><div><strong>Organization standard: OpenAI · Balanced</strong><p>fast luna, standard terra, quality sol</p></div><span class="badge badge-success">Organization standard</span></div></div></section><section class="panel"><div class="panel-head"><div><h2>AI models</h2><p>Verified models with prices and the tasks that use them.</p></div><div class="page-actions"><button data-slot="button" class="button button-outline">Task routes</button><button data-slot="button" class="button button-outline">Models &amp; prices</button></div></div><div class="capability-readiness"><div class="data-row"><div><strong>Claude Terra · claude-terra</strong><p>Anthropic (Claude) · no price</p></div><span class="badge badge-neutral">disabled</span></div><div class="data-row"><div><strong>gpt-5.6-luna</strong><p>OpenAI · no price</p></div><span class="badge badge-success">enabled</span></div><div class="data-row"><div><strong>gpt-5.6-sol</strong><p>OpenAI · no price</p></div><span class="badge badge-success">enabled</span></div><div class="data-row"><div><strong>gpt-5.6-terra</strong><p>OpenAI · $1.250 / $10.00 per MTok (input / output) · cache $0.125 · tasks: chat operator</p></div><span class="badge badge-success">enabled</span></div></div></section><section class="panel"><div class="panel-head"><div><h2>Anthropic (Claude) budget</h2><p>The monthly API credit, two warning thresholds and the internal spending stop. Per project; without one the organization&#x27;s or the system&#x27;s applies, else none.</p></div><span class="badge badge-warning">Pending</span></div><div class="metrics-strip metrics-four"><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg></span><div><span class="metric-label">Spent (calculated)</span><strong>$31.00</strong><small>of $45.00 stop · $50.00 credit</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-coins" aria-hidden="true"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"></path><path d="M15 6h1v4"></path><path d="m6.134 14.768.866-.5 2 3.464"></path><circle cx="16" cy="8" r="6"></circle></svg></span><div><span class="metric-label">Settled</span><strong>$20.00</strong><small>pending $1.00 · unclear $0.00</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles lucide-stars" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg></span><div><span class="metric-label">Billing period</span><strong>Nov 5</strong><small>until Dec 5, 2026, 1:00 AM</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg></span><div><span class="metric-label">Credit per console</span><strong>$12.00</strong><small>manually verified Nov 5, 2026, 11:00 AM</small></div></div></div><form><div data-slot="field-group" class="field-group"><div class="field" data-slot="field"><label for="form-monthly" class="field-label">Credit per billing period (USD)<span aria-hidden="true"> *</span></label><input id="form-monthly" type="number" required="" min="0" max="100000" step="0.01" placeholder="100" autoComplete="off" class="input" name="monthly" value=""/> </div><div class="field" data-slot="field"><label for="form-warn" class="field-label">First warning threshold (USD)<span aria-hidden="true"> *</span></label><input id="form-warn" type="number" required="" min="0" max="100000" step="0.01" placeholder="75" autoComplete="off" class="input" name="warn" value=""/> </div><div class="field" data-slot="field"><label for="form-warn2" class="field-label">Second warning threshold (USD)<span aria-hidden="true"> *</span></label><input id="form-warn2" type="number" required="" min="0" max="100000" step="0.01" placeholder="90" autoComplete="off" class="input" name="warn2" value=""/> </div><div class="field" data-slot="field"><label for="form-stop" class="field-label">Internal spending stop (USD)<span aria-hidden="true"> *</span></label><input id="form-stop" type="number" required="" min="0" max="100000" step="0.01" placeholder="95" autoComplete="off" class="input" name="stop" value=""/> <p class="field-hint">From this calculated spend Orbit refuses further Anthropic (Claude) calls; parallel calls are checked one after the other.</p></div><div class="field" data-slot="field"><label for="form-anchorDay" class="field-label">Day of the month the billing period starts (UTC)<span aria-hidden="true"> *</span></label><input id="form-anchorDay" type="number" required="" min="1" max="28" step="1" placeholder="1" autoComplete="off" class="input" name="anchorDay" value=""/> <p class="field-hint">The day Anthropic (Claude) renews the credit, not necessarily the 1st.</p></div><h3 class="field-heading">Credit balance (manual)</h3><div class="field" data-slot="field"><label for="form-creditAmount" class="field-label">Remaining credit per the Anthropic (Claude) console (USD, blank = unknown)</label><input id="form-creditAmount" type="number" min="0" max="100000" step="0.01" autoComplete="off" class="input" name="creditAmount" value=""/> <p class="field-hint">Orbit does not read the credit from the provider. This value is shown as manually verified next to its own calculated spend.</p></div><div class="field" data-slot="field"><label for="form-creditNote" class="field-label">Note</label><input id="form-creditNote" type="text" max="200" autoComplete="off" class="input" name="creditNote" value=""/> </div><div class="field field-check" data-slot="field"><label for="form-firstSave" class="field-label">Save as this project&#x27;s own AI settings<span aria-hidden="true"> *</span></label><input id="form-firstSave" type="checkbox" required="" class="input" name="firstSave"/> <p class="field-hint">This project has no AI settings of its own yet. Saving creates them, at first without models and prices of its own. From then on the environment&#x27;s key no longer serves the project, and values it took over so far from the organization, the system or the environment can stop applying. Check models, keys and budgets afterwards.</p></div></div><div class="form-actions"><button data-slot="button" class="button button-primary" type="submit">Save Anthropic (Claude) budget</button></div></form></section><section class="panel"><div class="panel-head"><div><h2>OpenAI budget</h2><p>The monthly API credit, two warning thresholds and the internal spending stop. Per project; without one the organization&#x27;s or the system&#x27;s applies, else none.</p></div><span class="badge badge-warning">Pending</span></div><div class="metrics-strip metrics-four"><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg></span><div><span class="metric-label">Spent (calculated)</span><strong>$2.00</strong><small>of $45.00 stop · $50.00 credit</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-coins" aria-hidden="true"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"></path><path d="M15 6h1v4"></path><path d="m6.134 14.768.866-.5 2 3.464"></path><circle cx="16" cy="8" r="6"></circle></svg></span><div><span class="metric-label">Settled</span><strong>$20.00</strong><small>pending $1.00 · unclear $0.00</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles lucide-stars" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg></span><div><span class="metric-label">Billing period</span><strong>Nov 5</strong><small>until Dec 5, 2026, 1:00 AM</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg></span><div><span class="metric-label">Credit per console</span><strong>$12.00</strong><small>manually verified Nov 5, 2026, 11:00 AM</small></div></div></div><form><div data-slot="field-group" class="field-group"><div class="field" data-slot="field"><label for="form-monthly" class="field-label">Credit per billing period (USD)<span aria-hidden="true"> *</span></label><input id="form-monthly" type="number" required="" min="0" max="100000" step="0.01" placeholder="100" autoComplete="off" class="input" name="monthly" value=""/> </div><div class="field" data-slot="field"><label for="form-warn" class="field-label">First warning threshold (USD)<span aria-hidden="true"> *</span></label><input id="form-warn" type="number" required="" min="0" max="100000" step="0.01" placeholder="75" autoComplete="off" class="input" name="warn" value=""/> </div><div class="field" data-slot="field"><label for="form-warn2" class="field-label">Second warning threshold (USD)<span aria-hidden="true"> *</span></label><input id="form-warn2" type="number" required="" min="0" max="100000" step="0.01" placeholder="90" autoComplete="off" class="input" name="warn2" value=""/> </div><div class="field" data-slot="field"><label for="form-stop" class="field-label">Internal spending stop (USD)<span aria-hidden="true"> *</span></label><input id="form-stop" type="number" required="" min="0" max="100000" step="0.01" placeholder="95" autoComplete="off" class="input" name="stop" value=""/> <p class="field-hint">From this calculated spend Orbit refuses further OpenAI calls; parallel calls are checked one after the other.</p></div><div class="field" data-slot="field"><label for="form-anchorDay" class="field-label">Day of the month the billing period starts (UTC)<span aria-hidden="true"> *</span></label><input id="form-anchorDay" type="number" required="" min="1" max="28" step="1" placeholder="1" autoComplete="off" class="input" name="anchorDay" value=""/> <p class="field-hint">The day OpenAI renews the credit, not necessarily the 1st.</p></div><h3 class="field-heading">Credit balance (manual)</h3><div class="field" data-slot="field"><label for="form-creditAmount" class="field-label">Remaining credit per the OpenAI console (USD, blank = unknown)</label><input id="form-creditAmount" type="number" min="0" max="100000" step="0.01" autoComplete="off" class="input" name="creditAmount" value=""/> <p class="field-hint">Orbit does not read the credit from the provider. This value is shown as manually verified next to its own calculated spend.</p></div><div class="field" data-slot="field"><label for="form-creditNote" class="field-label">Note</label><input id="form-creditNote" type="text" max="200" autoComplete="off" class="input" name="creditNote" value=""/> </div><div class="field field-check" data-slot="field"><label for="form-firstSave" class="field-label">Save as this project&#x27;s own AI settings<span aria-hidden="true"> *</span></label><input id="form-firstSave" type="checkbox" required="" class="input" name="firstSave"/> <p class="field-hint">This project has no AI settings of its own yet. Saving creates them, at first without models and prices of its own. From then on the environment&#x27;s key no longer serves the project, and values it took over so far from the organization, the system or the environment can stop applying. Check models, keys and budgets afterwards.</p></div></div><div class="form-actions"><button data-slot="button" class="button button-primary" type="submit">Save OpenAI budget</button></div></form></section><section class="panel"><div class="panel-head"><div><h2>AI usage &amp; costs</h2><p>Orbit&#x27;s own calculation from reservations and settled usage (USD). Not the provider&#x27;s live data.</p></div></div><div class="metrics-strip"><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-coins" aria-hidden="true"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"></path><path d="M15 6h1v4"></path><path d="m6.134 14.768.866-.5 2 3.464"></path><circle cx="16" cy="8" r="6"></circle></svg></span><div><span class="metric-label">Today</span><strong>—</strong></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg></span><div><span class="metric-label">This billing period</span><strong>—</strong><small>since Nov 5, 2026, 1:00 AM</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg></span><div><span class="metric-label">Claude</span><strong>—</strong></div></div></div><div class="settings-grid"><div><h3 class="usage-title">By provider</h3><p class="panel-note">No cost.</p></div><div><h3 class="usage-title">By model</h3><p class="panel-note">No cost.</p></div><div><h3 class="usage-title">By agent / module</h3><p class="panel-note">No cost.</p></div></div><p class="panel-note">Cost per project: this view is the selected project&#x27;s; every project reserves and settles separately.</p></section>"`);
  });

  it("renders the page as before the split while loading", () => {
    expect(
      inWorkspace(
        <AiSettingsView
          configuration={{ ...resource<AiConfigurationData>(null), loading: true }}
          budget={{ ...resource<AiBudgetView>(null), loading: true }}
          refreshAll={() => {}}
        />,
      ),
    ).toMatchInlineSnapshot(`"<section class="panel"><div class="panel-head"><div><h2>AI providers</h2><p>Keys are stored encrypted on the server. Image generation and semantic search (embeddings) need an OpenAI key; text also works with Claude alone.</p></div></div><div class="loading" role="status"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg><p>Loading…</p><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div></div></section><section class="panel"><div class="panel-head"><div><h2>AI models</h2><p>Verified models with prices and the tasks that use them.</p></div><div class="page-actions"><button data-slot="button" class="button button-outline">Task routes</button><button data-slot="button" class="button button-outline">Models &amp; prices</button></div></div><p class="panel-note">No verified models yet.</p></section><section class="panel"><div class="panel-head"><div><h2>Anthropic (Claude) budget</h2><p>The monthly API credit, two warning thresholds and the internal spending stop. Per project; without one the organization&#x27;s or the system&#x27;s applies, else none.</p></div></div></section><section class="panel"><div class="panel-head"><div><h2>OpenAI budget</h2><p>The monthly API credit, two warning thresholds and the internal spending stop. Per project; without one the organization&#x27;s or the system&#x27;s applies, else none.</p></div></div></section><section class="panel"><div class="panel-head"><div><h2>AI usage &amp; costs</h2><p>Orbit&#x27;s own calculation from reservations and settled usage (USD). Not the provider&#x27;s live data.</p></div></div><div class="metrics-strip"><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-coins" aria-hidden="true"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"></path><path d="M15 6h1v4"></path><path d="m6.134 14.768.866-.5 2 3.464"></path><circle cx="16" cy="8" r="6"></circle></svg></span><div><span class="metric-label">Today</span><strong>—</strong></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg></span><div><span class="metric-label">This billing period</span><strong>—</strong><small>since the start of the month (UTC)</small></div></div><div class="metric"><span class="metric-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg></span><div><span class="metric-label">Claude</span><strong>—</strong></div></div></div><div class="settings-grid"><div><h3 class="usage-title">By provider</h3><p class="panel-note">No cost.</p></div><div><h3 class="usage-title">By model</h3><p class="panel-note">No cost.</p></div><div><h3 class="usage-title">By agent / module</h3><p class="panel-note">No cost.</p></div></div><p class="panel-note">Cost per project: this view is the selected project&#x27;s; every project reserves and settles separately.</p></section>"`);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { centralLayers } from "../src/platform/ai/central-ai.ts";
import {
  anthropicCatalog,
  anthropicCatalogRateCard,
} from "../../../packages/ai/src/index.ts";
import {
  createConnection,
  grantConnection,
} from "../src/platform/administration/connections.ts";
import { saveAiProfile } from "../src/platform/administration/ai-profiles.ts";
import {
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import { readAiModels } from "../src/platform/ai/mcp-tools.ts";
import {
  aiConfigurationState,
  projectAiExceptions,
  routingModeOf,
} from "../src/platform/ai/effective-configuration.ts";
import type { StoredAiFields } from "../src/platform/ai/openai-configuration.ts";

// Pins what ai_models_get returns (readAiModels) for a project served by
// its organization's granted key and AI profile, and for a project with its
// own saved configuration, so moving the read into a shared service keeps
// the MCP output byte for byte. Keys are synthetic and nothing reaches a
// provider: no key check, no paid call.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The deployment's own AI settings would leak into the effective view.
const ENV_KEYS = [
  "ORBIT_CONNECTIONS",
  "ORBIT_AI_CATALOG",
  "ORBIT_AI_DEFAULTS",
  "ORBIT_AI_KEY_RULE_V2",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_DEFAULT_PROVIDER",
  "OPENAI_VERIFIED_MODELS",
  "OPENAI_RATE_CARD_JSON",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_IMAGE_MAX_COST_MICROS",
  "OPENAI_IMAGE_PRICE_VERIFIED_AT",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
// Top level, so the environment is restored even when the database tests skip.
beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ORBIT_CONNECTIONS = "true";
});
afterAll(() => {
  for (const k of ENV_KEYS)
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
});

const VERIFIED_AT = "2026-11-01T00:00:00.000Z";
const rate = { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000, verifiedAt: VERIFIED_AT };
const IMAGE_MODEL = "gpt-image-2.5-flare";
/**
 * The system layer centralLayers reports for the system profile row: none
 * without a row; an empty profile (the only kind these expectations allow,
 * see systemProfile) contributes no runtime fields.
 */
const systemLayerFor = (row: { data: unknown } | null) => (row ? {} : null);

describe.skipIf(!enabled)("ai_models_get read (characterization)", () => {
  const users: string[] = [];
  let workspaceId: string;
  let granted: Scope, own: Scope, editor: Scope;
  let connectionId: string;
  // The system AI profile is global and other test files leave data in it;
  // the tests below describe a database without one, so the row is set aside
  // here and put back exactly as it was in afterAll.
  type SystemProfileRow = NonNullable<Awaited<ReturnType<typeof authDb.aiProfile.findFirst>>>;
  let systemBefore: SystemProfileRow | null | undefined;

  async function user() {
    const row = await authDb.user.create({
      data: { id: randomUUID(), name: "Synthetic AI read", email: `${randomUUID()}@example.invalid` },
    });
    users.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    systemBefore = await authDb.aiProfile.findFirst({ where: { scope: "system" } });
    await authDb.aiProfile.deleteMany({ where: { scope: "system" } });
    const ownerId = await user();
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic AI read", members: { create: { userId: ownerId, role: "owner" } } },
    });
    workspaceId = workspace.id;
    const project = (name: string) =>
      authDb.project.create({ data: { workspaceId, name, timezone: "Europe/Berlin" } });
    const a = await project("Synthetic granted project");
    const b = await project("Synthetic own project");
    granted = { workspaceId, projectId: a.id, userId: ownerId, role: "owner" };
    own = { workspaceId, projectId: b.id, userId: ownerId, role: "owner" };
    // A project editor, not an organization owner, as the add-member action makes one.
    const editorId = await user();
    await authDb.workspaceMember.create({ data: { workspaceId, userId: editorId, role: "viewer" } });
    await authDb.projectMember.create({
      data: { workspaceId, projectId: a.id, userId: editorId, role: "editor" },
    });
    editor = { workspaceId, projectId: a.id, userId: editorId, role: "editor" };
    const actor = { userId: ownerId, role: "owner" as const, workspaceId };
    const openai = await createConnection(actor, {
      provider: "openai",
      label: "Organization OpenAI",
      config: {},
      secret: `sk-synthetic-${randomBytes(16).toString("hex")}`,
    });
    connectionId = openai.id;
    await grantConnection(actor, connectionId, {
      projectId: granted.projectId,
      purposes: ["text", "image"],
      monthlyBudgetMicros: 5_000_000,
    });
    await saveAiProfile(ownerId, { scope: "workspace", workspaceId }, {
      verifiedModels: ["synthetic-org", "synthetic-org-quality", IMAGE_MODEL],
      rateCard: { "synthetic-org": rate, "synthetic-org-quality": rate },
      modelRoutes: {
        fast: "synthetic-org",
        standard: "synthetic-org",
        quality: "synthetic-org-quality",
        escalation: "synthetic-org-quality",
      },
      defaultProvider: "anthropic",
    });
    await scoped(workspaceId, own.projectId, async (tx) => {
      await saveOpenAiConfiguration(tx, own, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-own", IMAGE_MODEL],
        rateCard: { "synthetic-own": rate },
        modelRoutes: {
          fast: "synthetic-own",
          standard: "synthetic-own",
          quality: "synthetic-own",
          escalation: "synthetic-own",
        },
        imageGeneration: { model: IMAGE_MODEL, maxCostMicrosPerImage: 40_000, pricingVerifiedAt: VERIFIED_AT },
      });
      await saveAiProviderConfiguration(tx, own, {
        providerBudgets: {
          openai: { monthlyMicros: 3_000_000, warnMicros: 1_000_000, warn2Micros: 2_000_000, stopMicros: 2_500_000 },
        },
      });
    });
  });

  afterAll(async () => {
    if (systemBefore !== undefined) {
      await authDb.aiProfile.deleteMany({ where: { scope: "system" } });
      if (systemBefore) await authDb.aiProfile.create({ data: { ...systemBefore, data: systemBefore.data as object } });
    }
    if (workspaceId) {
      await authDb.aiProfile.deleteMany({ where: { workspaceId } });
      await authDb.connection.deleteMany({ where: { workspaceId } });
      await authDb.workspace.delete({ where: { id: workspaceId } });
    }
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  /** Today's view of a profile row in ai_models_get. */
  const profileView = (row: { version: number; data: unknown } | null) => {
    if (!row) return null;
    const d = row.data as Record<string, any>;
    return {
      version: row.version,
      verifiedModels: d.verifiedModels ?? [],
      defaultProvider: d.defaultProvider ?? null,
      imageModel: d.imageGeneration?.model ?? null,
      pricedModels: Object.keys(d.rateCard ?? {}),
    };
  };
  // The system profile row is set aside for this file (beforeAll), so the
  // effective values below see no system profile at all.
  async function systemProfile() {
    const row = await authDb.aiProfile.findFirst({ where: { scope: "system" } });
    expect(row).toBeNull();
    return profileView(row);
  }
  const organizationProfile = async () =>
    profileView(await authDb.aiProfile.findFirst({ where: { workspaceId } }));
  /** Every task route, in the order effectiveRoutes lists them. */
  const routes = (fast: string, quality: string) => {
    const table: Array<[string, number, "fast" | "quality"]> = [
      ["chat_operator", 3000, "fast"],
      ["draft_social", 1800, "fast"],
      ["draft_blog", 1800, "quality"],
      ["agent_strategy", 3000, "fast"],
      ["agent_research", 3000, "fast"],
      ["agent_analytics", 1800, "fast"],
      ["agent_review", 1800, "quality"],
      ["support_triage", 800, "fast"],
      ["support_draft", 1800, "quality"],
      ["finance_extraction", 4000, "fast"],
      ["pm_plan", 12000, "quality"],
      ["pm_analysis", 3000, "fast"],
      ["knowledge_evaluation", 6000, "fast"],
      ["knowledge_analysis", 12000, "fast"],
      ["issue_triage", 1500, "fast"],
      ["creative_review", 1500, "fast"],
      ["agent_custom", 3000, "fast"],
    ];
    return Object.fromEntries(
      table.map(([task, maxOutputTokens, tier]) => [
        task,
        { model: tier === "fast" ? fast : quality, maxOutputTokens, provider: "openai", price: "current" },
      ]),
    );
  };
  const catalogCandidates = () =>
    Object.keys(anthropicCatalogRateCard()).map((model) => ({
      model,
      provider: "anthropic",
      verified: false,
      price: "current",
      source: "anthropic_catalog",
    }));
  const notes = {
    keys: "API keys are never returned. A missing key is added in Orbit: Administration → Connections (granted to the project) or Settings → AI.",
    selection:
      "ai_models_update accepts verified models only (in use, verified globally, or in the reviewed Anthropic catalog); prices come from the configured or global rate cards or that catalog, never from the request.",
  };
  /** Same values and the same key order: the MCP output byte for byte. */
  function expectExactly(actual: unknown, expected: unknown) {
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  }

  it("reads a project served by its organization's granted key and profile", async () => {
    const result = await scoped(workspaceId, granted.projectId, (tx) => readAiModels(tx, granted));
    const grant = {
      connectionId,
      label: "Organization OpenAI",
      scope: "workspace",
      status: "configured",
      monthlyBudgetMicros: 5_000_000,
    };
    expectExactly(result, {
      projectId: granted.projectId,
      version: 0,
      global: {
        connectionsEnabled: true,
        profiles: { system: await systemProfile(), organization: await organizationProfile() },
        grantedKeys: { openaiText: grant, openaiImage: grant, anthropic: null },
        anthropicCatalogVerifiedAt: anthropicCatalog.verifiedAt,
      },
      project: { configured: false },
      effective: {
        keys: { openaiText: true, image: true, anthropic: false },
        keySources: { openai: "connection", image: "connection", anthropic: "none" },
        verifiedModels: ["synthetic-org", "synthetic-org-quality", IMAGE_MODEL],
        prices: { "synthetic-org": "current", "synthetic-org-quality": "current", [IMAGE_MODEL]: "missing" },
        // Merged over the environment's tiers, hence this key order.
        modelRoutes: {
          fast: "synthetic-org",
          quality: "synthetic-org-quality",
          standard: "synthetic-org",
          escalation: "synthetic-org-quality",
        },
        routes: routes("synthetic-org", "synthetic-org-quality"),
        defaultProvider: "anthropic",
        anthropicTierRoutes: null,
        providerBudgets: {},
        fallback: { onProviderBudgetStop: "none" },
        imageGeneration: { model: IMAGE_MODEL, maxCostMicrosPerImage: 0 },
      },
      checks: {
        textModelVerified: true,
        routesWithoutKey: [],
        capabilities: { text: true, search: "semantic", images: false },
        unverifiedRoutedModels: [],
        unpricedVerifiedModels: [],
        imageKeyConfigured: true,
        imagePricingCurrent: false,
        imageModelVerified: true,
      },
      candidates: [
        { model: "synthetic-org", provider: "openai", verified: true, price: "current", source: "configured" },
        { model: "synthetic-org-quality", provider: "openai", verified: true, price: "current", source: "configured" },
        { model: IMAGE_MODEL, provider: "openai", verified: true, price: "missing", source: "configured" },
        ...catalogCandidates(),
      ],
      notes,
    });
  });

  it("reads a project with its own saved configuration", async () => {
    const { result, row } = await scoped(workspaceId, own.projectId, async (tx) => ({
      result: await readAiModels(tx, own),
      row: await tx.entity.findFirst({
        where: { projectId: own.projectId, kind: "openai_configuration" },
      }),
    }));
    const routesOwn = { fast: "synthetic-own", standard: "synthetic-own", quality: "synthetic-own", escalation: "synthetic-own" };
    const image = { model: IMAGE_MODEL, maxCostMicrosPerImage: 40_000, pricingVerifiedAt: VERIFIED_AT };
    const budgets = {
      openai: { monthlyMicros: 3_000_000, warnMicros: 1_000_000, warn2Micros: 2_000_000, stopMicros: 2_500_000, anchorDay: 1 },
    };
    expectExactly(result, {
      projectId: own.projectId,
      version: row!.version,
      global: {
        connectionsEnabled: true,
        profiles: { system: await systemProfile(), organization: await organizationProfile() },
        grantedKeys: { openaiText: null, openaiImage: null, anthropic: null },
        anthropicCatalogVerifiedAt: anthropicCatalog.verifiedAt,
      },
      project: {
        configured: true,
        verifiedModels: ["synthetic-own", IMAGE_MODEL],
        modelRoutes: routesOwn,
        taskRoutes: {},
        imageGeneration: image,
        defaultProvider: "openai",
        anthropicTierRoutes: null,
        providerBudgets: budgets,
        fallback: { onProviderBudgetStop: "none" },
        pricedModels: ["synthetic-own"],
      },
      effective: {
        keys: { openaiText: true, image: true, anthropic: false },
        keySources: { openai: "project", image: "none", anthropic: "none" },
        verifiedModels: ["synthetic-own", IMAGE_MODEL],
        prices: { "synthetic-own": "current", [IMAGE_MODEL]: "missing" },
        modelRoutes: routesOwn,
        routes: routes("synthetic-own", "synthetic-own"),
        defaultProvider: "openai",
        anthropicTierRoutes: null,
        providerBudgets: budgets,
        fallback: { onProviderBudgetStop: "none" },
        imageGeneration: image,
      },
      checks: {
        textModelVerified: true,
        routesWithoutKey: [],
        capabilities: { text: true, search: "semantic", images: true },
        unverifiedRoutedModels: [],
        unpricedVerifiedModels: [],
        imageKeyConfigured: true,
        imagePricingCurrent: true,
        imageModelVerified: true,
      },
      candidates: [
        { model: "synthetic-own", provider: "openai", verified: true, price: "current", source: "configured" },
        { model: IMAGE_MODEL, provider: "openai", verified: true, price: "missing", source: "configured" },
        { model: "synthetic-org", provider: "openai", verified: false, price: "current", source: "global" },
        { model: "synthetic-org-quality", provider: "openai", verified: false, price: "current", source: "global" },
        ...catalogCandidates(),
      ],
      notes,
    });
  });

  it("reads the state of the connection serving a key for a project member who is no owner", async () => {
    const state = await scoped(workspaceId, granted.projectId, (tx) =>
      aiConfigurationState(tx, editor),
    );
    expect(state.effective.keyConnections).toEqual({
      openai: { connectionId, grantId: expect.any(String) },
      image: { connectionId, grantId: expect.any(String) },
    });
    expect(state.keyConnections).toEqual({
      [connectionId]: { status: "configured", disabled: false, scope: "workspace", label: "Organization OpenAI" },
    });
    expect(state).toMatchObject({
      version: 0,
      stored: null,
      ownKeys: { openai: false, image: false, anthropic: false },
      routingApplied: false,
      layers: { standardImageModel: undefined },
    });
    // No system profile row exists for this file (beforeAll).
    expect(await authDb.aiProfile.findFirst({ where: { scope: "system" } })).toBeNull();
    expect(state.layers!.system).toEqual(systemLayerFor(null));
    expect(state.layers!.organization).toMatchObject({ defaultProvider: "anthropic" });
    expect(Object.keys(state.grants)).toEqual(["openaiText", "openaiImage"]);
    expect(routingModeOf(state.stored)).toBe("unsaved");
  });

  it("reads a project with its own key: no connection serves it", async () => {
    const state = await scoped(workspaceId, own.projectId, (tx) => aiConfigurationState(tx, own));
    expect(state.keyConnections).toEqual({});
    expect(state.ownKeys).toEqual({ openai: true, image: false, anthropic: false });
    expect(state.stored!.version).toBe(state.version);
    expect(state.grants).toEqual({});
    expect(routingModeOf(state.stored)).toBe("custom");
    expect(projectAiExceptions(state.stored, state.ownKeys)).toEqual({
      models: true,
      routes: true,
      prices: true,
      providerBudgets: true,
      keys: ["openai"],
    });
  });
});

// The two system-row outcomes of the editor test above, on a stubbed
// transaction, so the no-row branch is proven without touching the shared
// test database: centralLayers must agree with systemLayerFor for both.
describe("centralLayers and the system profile row", () => {
  const organizationRow = { scope: "workspace", version: 1, data: { defaultProvider: "anthropic" } };
  const stub = (rows: object[]) =>
    ({
      aiProfile: { findMany: async () => rows },
      connectionGrant: { findMany: async () => [] },
    }) as unknown as DbTx;
  const scope = { workspaceId: randomUUID(), projectId: randomUUID(), userId: randomUUID(), role: "owner" } as Scope;
  it("reports no system layer without a system profile row", async () => {
    const layers = await centralLayers(stub([organizationRow]), scope);
    expect(layers!.system).toBeNull();
    expect(layers!.system).toEqual(systemLayerFor(null));
    expect(layers!.organization).toEqual({ defaultProvider: "anthropic" });
  });
  it("reports an empty system layer for an empty system profile row", async () => {
    const systemRow = { scope: "system", version: 4, data: {} };
    const layers = await centralLayers(stub([systemRow, organizationRow]), scope);
    expect(layers!.system).toEqual({});
    expect(layers!.system).toEqual(systemLayerFor(systemRow));
  });
});

describe("routingModeOf", () => {
  it("is unsaved without saved fields", () => {
    expect(routingModeOf(null)).toBe("unsaved");
  });
  it("is the saved routing source when one is set", () => {
    expect(routingModeOf(storedFields({ routing: { source: "organization", overrides: {} } }))).toBe("organization");
    expect(
      routingModeOf(storedFields({ routing: { source: "preset", provider: "openai", level: "balanced", overrides: {} } })),
    ).toBe("preset");
  });
  it("is custom for saved fields without a routing source", () => {
    expect(routingModeOf(storedFields({ routing: null }))).toBe("custom");
  });
});

describe("projectAiExceptions", () => {
  const noKeys = { openai: false, image: false, anthropic: false };
  const organization = { routing: { source: "organization" as const, overrides: {} } };
  it("reports nothing without saved fields or own keys", () => {
    expect(projectAiExceptions(null, noKeys)).toEqual({
      models: false,
      routes: false,
      prices: false,
      providerBudgets: false,
      keys: [],
    });
  });
  it("models: saved fields with verified models", () => {
    expect(projectAiExceptions(storedFields({ ...organization, verifiedModels: ["m"] }), noKeys).models).toBe(true);
    expect(projectAiExceptions(storedFields({ ...organization, verifiedModels: [] }), noKeys).models).toBe(false);
  });
  it("prices: saved fields with a rate card entry", () => {
    expect(projectAiExceptions(storedFields({ ...organization, rateCard: { m: rate } }), noKeys).prices).toBe(true);
    expect(projectAiExceptions(storedFields({ ...organization, rateCard: {} }), noKeys).prices).toBe(false);
  });
  it("routes: the custom mode, or a routing override", () => {
    expect(projectAiExceptions(storedFields({ routing: null }), noKeys).routes).toBe(true);
    expect(projectAiExceptions(storedFields(organization), noKeys).routes).toBe(false);
    expect(
      projectAiExceptions(
        storedFields({
          routing: { source: "organization", overrides: { draft_social: { model: "m", maxOutputTokens: 1000 } } },
        }),
        noKeys,
      ).routes,
    ).toBe(true);
  });
  it("providerBudgets: saved fields with a budget for a provider", () => {
    const budget = { monthlyMicros: 4, warnMicros: 1, warn2Micros: 2, stopMicros: 3, anchorDay: 1 };
    expect(
      projectAiExceptions(storedFields({ ...organization, providerBudgets: { anthropic: budget } }), noKeys).providerBudgets,
    ).toBe(true);
    expect(projectAiExceptions(storedFields({ ...organization, providerBudgets: {} }), noKeys).providerBudgets).toBe(false);
  });
  it("keys: the project's own keys, in the order openai, image, anthropic", () => {
    expect(projectAiExceptions(null, { openai: false, image: true, anthropic: true }).keys).toEqual(["image", "anthropic"]);
    expect(projectAiExceptions(null, { openai: true, image: true, anthropic: true }).keys).toEqual([
      "openai",
      "image",
      "anthropic",
    ]);
  });
});

/** Saved fields with nothing set beyond the defaults, plus `overrides`. */
function storedFields(overrides: Partial<StoredAiFields>): StoredAiFields {
  return {
    version: 1,
    verifiedModels: [],
    rateCard: {},
    modelRoutes: { fast: "m", standard: "m", quality: "m", escalation: "m" },
    taskRoutes: {},
    imageGeneration: { model: IMAGE_MODEL, maxCostMicrosPerImage: 0 },
    defaultProvider: "openai",
    anthropicTierRoutes: null,
    models: {},
    providerBudgets: {},
    fallback: { onProviderBudgetStop: "none" },
    routing: null,
    ...overrides,
  };
}

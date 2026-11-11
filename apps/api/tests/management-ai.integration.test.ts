import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { taskClasses } from "../../../packages/ai/src/index.ts";
import {
  createConnection,
  grantConnection,
} from "../src/platform/administration/connections.ts";
import { saveAiProfile } from "../src/platform/administration/ai-profiles.ts";
import { saveAiDefaults } from "../src/platform/administration/ai-defaults.ts";
import {
  saveAiRouting,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import type { AiConfigurationState } from "../src/platform/ai/effective-configuration.ts";
import {
  effectiveOrigins,
  providerReadiness,
  type ProjectAiEffective,
} from "../src/platform/management/ai-effective.ts";

// The settings center's effective AI view of a project (phase 4): every value
// with its origin and a readiness per provider. The pure rules first, one case
// per row of the origin and readiness tables (docs/API_CONTRACT.md); then the
// route against real fixtures. Keys are synthetic and nothing reaches a
// provider: connection status values are set directly, never by a check.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The deployment's own AI settings would leak into the effective view.
const ENV_KEYS = [
  "ORBIT_CONNECTIONS",
  "ORBIT_AI_CATALOG",
  "ORBIT_AI_DEFAULTS",
  "ORBIT_AI_KEY_RULE_V2",
  "ORBIT_SETTINGS_CENTER",
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
const VERIFIED_AT = "2026-11-01T00:00:00.000Z";
const rate = { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000, verifiedAt: VERIFIED_AT };
const ENV_KEY = `sk-env-${randomBytes(16).toString("hex")}`;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
// Top level, so the environment is restored even when the database tests skip.
beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, {
    ORBIT_CONNECTIONS: "true",
    ORBIT_AI_CATALOG: "true",
    ORBIT_AI_DEFAULTS: "true",
    ORBIT_SETTINGS_CENTER: "preview",
    OPENAI_API_KEY: ENV_KEY,
    OPENAI_VERIFIED_MODELS: "synthetic-env-a,synthetic-env-b",
    OPENAI_RATE_CARD_JSON: JSON.stringify({ "synthetic-env-a": rate, "synthetic-env-b": rate }),
  });
});
afterAll(() => {
  for (const k of ENV_KEYS)
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
});

// ---------------------------------------------------------------------------
// Pure rules

type Layer = Record<string, unknown>;
const TIERS = { fast: "e-fast", standard: "e-standard", quality: "e-quality", escalation: "e-escalation" };
/** A state as aiConfigurationState returns it, with only what the rules read. */
function state(o: {
  stored?: Record<string, unknown> | null;
  system?: Layer | null;
  organization?: Layer | null;
  layers?: null;
  standardImageModel?: string;
  organizationDefaults?: Record<string, unknown>;
  routingApplied?: boolean;
  effective?: Record<string, unknown>;
  ownKeys?: Partial<AiConfigurationState["ownKeys"]>;
  keyConnections?: AiConfigurationState["keyConnections"];
}): AiConfigurationState {
  const stored =
    o.stored === null || o.stored === undefined
      ? null
      : {
          version: 1,
          verifiedModels: [],
          rateCard: {},
          modelRoutes: TIERS,
          taskRoutes: {},
          imageGeneration: { model: "gpt-image-2.5-flare", maxCostMicrosPerImage: 0 },
          defaultProvider: "openai",
          anthropicTierRoutes: null,
          models: {},
          providerBudgets: {},
          fallback: { onProviderBudgetStop: "none" },
          routing: null,
          ...o.stored,
        };
  return {
    version: stored ? 1 : 0,
    stored,
    ownKeys: { openai: false, image: false, anthropic: false, ...o.ownKeys },
    effective: {
      textKeyConfigured: false,
      imageKeyConfigured: false,
      anthropicKeyConfigured: false,
      keySources: { openai: "none", image: "none", anthropic: "none" },
      keyConnections: {},
      verifiedModels: [],
      rateCard: {},
      modelRoutes: TIERS,
      taskRoutes: {},
      anthropicTierRoutes: { fast: "c-fast", standard: "c-standard", quality: "c-quality" },
      defaultProvider: "openai",
      models: {},
      providerBudgets: {},
      fallback: { onProviderBudgetStop: "none" },
      imageGeneration: { model: "gpt-image-2.5-flare", maxCostMicrosPerImage: 0 },
      effectiveRoutes: {},
      routeVersion: null,
      ...o.effective,
    },
    profiles: {
      system: null,
      organization: o.organizationDefaults
        ? ({ data: { defaults: o.organizationDefaults } } as never)
        : null,
    },
    layers:
      o.layers === null
        ? null
        : {
            system: (o.system ?? null) as never,
            organization: (o.organization ?? null) as never,
            standardImageModel: o.standardImageModel,
          },
    grants: {},
    global: { verified: new Set(), rates: {} },
    keyConnections: o.keyConnections ?? {},
    routingApplied: o.routingApplied ?? true,
  } as unknown as AiConfigurationState;
}
const budget = { monthlyMicros: 10, warnMicros: 5, warn2Micros: 7, stopMicros: 9, anchorDay: 1 };
const preset = (provider: "openai" | "anthropic", overrides = {}) => ({
  routing: { source: "preset", provider, level: "economy", overrides },
});
const organization = (overrides = {}) => ({ routing: { source: "organization", overrides } });

describe("effective origins (one case per table row)", () => {
  it("preset applied: the default provider and the preset provider's tiers come from the preset", () => {
    const openai = effectiveOrigins(state({ stored: preset("openai"), organization: { defaultProvider: "anthropic" } }));
    expect(openai.defaultProvider).toBe("preset");
    expect(Object.values(openai.tiers.openai)).toEqual(["preset", "preset", "preset", "preset"]);
    // Runtime: an OpenAI preset clears the project's Claude tiers, so the layers' apply;
    // the environment has none.
    const cleared = state({ stored: preset("openai"), effective: { anthropicTierRoutes: null } });
    expect(effectiveOrigins(cleared).tiers.anthropic.fast).toBeNull();
    const layered = state({ stored: preset("openai"), system: { anthropicTierRoutes: { fast: "a", standard: "b", quality: "c" } } });
    expect(effectiveOrigins(layered).tiers.anthropic.fast).toBe("system");
    const claude = effectiveOrigins(state({ stored: preset("anthropic") }));
    expect(claude.tiers.anthropic).toEqual({ fast: "preset", standard: "preset", quality: "preset" });
    // Runtime: a Claude preset keeps the project's saved OpenAI tiers.
    expect(claude.tiers.openai.fast).toBe("project");
  });

  it("organization standard applied: the last layer that defines the field, else the environment", () => {
    const both = state({
      stored: organization(),
      system: { defaultProvider: "openai", modelRoutes: TIERS },
      organization: { defaultProvider: "anthropic" },
    });
    const o = effectiveOrigins(both);
    expect(o.defaultProvider).toBe("organization");
    expect(o.tiers.openai.fast).toBe("system");
    expect(effectiveOrigins(state({ stored: organization() })).defaultProvider).toBe("environment");
  });

  it("a stored row defines its fields: custom settings, and fields a routing does not replace", () => {
    const custom = effectiveOrigins(
      state({
        stored: {},
        organization: {
          defaultProvider: "anthropic", modelRoutes: TIERS, fallback: {}, imageGeneration: {},
          anthropicTierRoutes: { fast: "a", standard: "b", quality: "c" },
        },
      }),
    );
    expect(custom.defaultProvider).toBe("project");
    expect(custom.tiers.openai.escalation).toBe("project");
    expect(custom.fallback).toBe("project");
    expect(custom.imageModel).toBe("project");
    // Claude tiers only when stored.
    expect(custom.tiers.anthropic.fast).toBe("organization");
    const withTiers = state({ stored: { anthropicTierRoutes: { fast: "a", standard: "b", quality: "c" } } });
    expect(effectiveOrigins(withTiers).tiers.anthropic.fast).toBe("project");
    // A saved routing that the runtime does not apply leaves the row in charge.
    expect(effectiveOrigins(state({ stored: preset("openai"), routingApplied: false })).defaultProvider).toBe("project");
    // Fallback and image settings stay the project's under a preset or the standard.
    expect(effectiveOrigins(state({ stored: preset("openai") })).fallback).toBe("project");
    expect(effectiveOrigins(state({ stored: organization() })).imageModel).toBe("project");
  });

  it("without a row: the last layer that defines the field, else the environment", () => {
    const o = effectiveOrigins(
      state({ system: { modelRoutes: TIERS, fallback: {} }, organization: { imageGeneration: {} } }),
    );
    expect(o.defaultProvider).toBe("environment");
    expect(o.tiers.openai.quality).toBe("system");
    expect(o.fallback).toBe("system");
    expect(o.imageModel).toBe("organization");
    // Connections off: only the environment.
    expect(effectiveOrigins(state({ layers: null })).defaultProvider).toBe("environment");
  });

  it("image model under the organization's standard: that standard's layer", () => {
    const fromOrganization = state({
      stored: organization(),
      standardImageModel: "gpt-image-2.5-sunburst",
      organizationDefaults: { provider: "openai", level: "economy", imageModel: "gpt-image-2.5-sunburst" },
    });
    expect(effectiveOrigins(fromOrganization).imageModel).toBe("organization");
    const fromSystem = state({ stored: organization(), standardImageModel: "gpt-image-2.5-sunburst" });
    expect(effectiveOrigins(fromSystem).imageModel).toBe("system");
    // An organization value the runtime does not accept falls through to the system's.
    const invalid = state({
      stored: organization(),
      standardImageModel: "gpt-image-2.5-sunburst",
      organizationDefaults: { provider: "openai", level: "economy", imageModel: "not-an-image-model" },
    });
    expect(effectiveOrigins(invalid).imageModel).toBe("system");
    // Not applied: the project's own image settings.
    expect(effectiveOrigins({ ...fromSystem, routingApplied: false }).imageModel).toBe("project");
  });

  it("task route, custom: the project when stored, else not explicit", () => {
    const route = { model: "m", maxOutputTokens: 1000 };
    const o = effectiveOrigins(state({ stored: { taskRoutes: { chat_operator: route } }, organization: { taskRoutes: { draft_blog: route } } }));
    expect(o.taskRoutes.chat_operator).toEqual({ explicit: true, origin: "project" });
    expect(o.taskRoutes.draft_blog).toEqual({ explicit: false, origin: "project" });
  });

  it("task route, preset: the project for its deviations, else not explicit", () => {
    const route = { model: "m", maxOutputTokens: 1000 };
    const o = effectiveOrigins(state({ stored: { ...preset("openai", { pm_plan: route }), taskRoutes: { draft_blog: route } } }));
    expect(o.taskRoutes.pm_plan).toEqual({ explicit: true, origin: "project" });
    expect(o.taskRoutes.draft_blog).toEqual({ explicit: false, origin: "preset" });
  });

  it("task route, organization: the project's deviation, else the layer whose task routes apply", () => {
    const route = { model: "m", maxOutputTokens: 1000 };
    const o = effectiveOrigins(
      state({
        stored: organization({ pm_plan: route }),
        system: { taskRoutes: { draft_blog: route, pm_plan: route } },
      }),
    );
    expect(o.taskRoutes.pm_plan).toEqual({ explicit: true, origin: "project" });
    expect(o.taskRoutes.draft_blog).toEqual({ explicit: true, origin: "system" });
    expect(o.taskRoutes.chat_operator.explicit).toBe(false);
    // Runtime: a layer's task routes replace the lower layer's as a whole.
    const replaced = effectiveOrigins(
      state({ stored: organization(), system: { taskRoutes: { draft_blog: route } }, organization: { taskRoutes: {} } }),
    );
    expect(replaced.taskRoutes.draft_blog.explicit).toBe(false);
  });

  it("task route, unsaved: the layer whose task routes apply", () => {
    const route = { model: "m", maxOutputTokens: 1000 };
    const o = effectiveOrigins(state({ organization: { taskRoutes: { draft_social: route } } }));
    expect(o.taskRoutes.draft_social).toEqual({ explicit: true, origin: "organization" });
    expect(effectiveOrigins(state({ layers: null })).taskRoutes.draft_social.explicit).toBe(false);
  });

  it("not explicit: the default provider's origin", () => {
    const o = effectiveOrigins(state({ organization: { defaultProvider: "anthropic" } }));
    for (const task of taskClasses) expect(o.taskRoutes[task]).toEqual({ explicit: false, origin: "organization" });
  });

  it("provider budgets: the project's, else the organization's, else the system's, else none", () => {
    const o = effectiveOrigins(
      state({
        stored: { providerBudgets: { anthropic: budget } },
        system: { providerBudgets: { openai: budget, anthropic: budget } },
      }),
    );
    expect(o.providerBudgets).toEqual({ openai: "system", anthropic: "project" });
    expect(effectiveOrigins(state({ organization: { providerBudgets: { openai: budget } } })).providerBudgets).toEqual({
      openai: "organization",
      anthropic: null,
    });
  });

  it("keys: the key source, a connection by its scope", () => {
    const o = effectiveOrigins(
      state({
        effective: {
          keySources: { openai: "connection", image: "project", anthropic: "connection" },
          keyConnections: { openai: { connectionId: "c1", grantId: "g1" }, anthropic: { connectionId: "c2", grantId: "g2" } },
        },
        keyConnections: {
          c1: { status: "read_verified", disabled: false, scope: "system", label: "S" },
          c2: { status: "configured", disabled: false, scope: "workspace", label: "W" },
        },
      }),
    );
    expect(o.keys).toEqual({ openai: "system", image: "project", anthropic: "organization" });
    const env = effectiveOrigins(state({ effective: { keySources: { openai: "environment", image: "none", anthropic: "none" } } }));
    expect(env.keys).toEqual({ openai: "environment", image: null, anthropic: null });
    // A connection the project cannot read has no scope to report.
    const hidden = effectiveOrigins(
      state({ effective: { keySources: { openai: "connection", image: "none", anthropic: "none" }, keyConnections: { openai: { connectionId: "c9", grantId: "g9" } } } }),
    );
    expect(hidden.keys.openai).toBeNull();
    // Without a dedicated image key, image calls use the OpenAI text key.
    const textOnly = effectiveOrigins(
      state({
        effective: {
          textKeyConfigured: true,
          imageKeyConfigured: true,
          keySources: { openai: "connection", image: "none", anthropic: "none" },
          keyConnections: { openai: { connectionId: "c1", grantId: "g1" } },
        },
        keyConnections: { c1: { status: "read_verified", disabled: false, scope: "workspace", label: "W" } },
      }),
    );
    expect(textOnly.keys.image).toBe("organization");
  });
});

describe("provider readiness (one case per rule)", () => {
  const priced = { model: "e-fast", maxOutputTokens: 1000, provider: "openai", price: "current" };
  const ready = {
    textKeyConfigured: true,
    verifiedModels: ["e-fast"],
    effectiveRoutes: { chat_operator: priced, draft_social: priced },
  };
  const source = (openai: string) => ({ keySources: { openai, image: "none", anthropic: "none" } });

  it("stored: a key in the chain, else no_key", () => {
    const r = providerReadiness(state({}));
    expect(r.openai).toEqual({ stored: false, verified: false, ready: false, reasons: ["no_key"] });
    expect(r.anthropic).toEqual({ stored: false, verified: false, ready: false, reasons: ["no_key"] });
  });

  it("verified: a checked connection that is not disabled", () => {
    const connection = (status: string, disabled = false) =>
      providerReadiness(
        state({
          effective: { ...ready, ...source("connection"), keyConnections: { openai: { connectionId: "c1", grantId: "g1" } } },
          keyConnections: { c1: { status, disabled, scope: "workspace", label: "W" } },
        }),
      ).openai;
    expect(connection("read_verified")).toEqual({ stored: true, verified: true, ready: true, reasons: [] });
    expect(connection("write_verified").verified).toBe(true);
    expect(connection("configured").reasons).toEqual(["connection_not_checked"]);
    expect(connection("failed").reasons).toEqual(["connection_failed"]);
    expect(connection("read_verified", true).reasons).toEqual(["connection_disabled"]);
  });

  it("a project or environment key is never more than stored", () => {
    const project = providerReadiness(state({ effective: { ...ready, ...source("project") } })).openai;
    expect(project).toEqual({ stored: true, verified: false, ready: true, reasons: ["project_key_unverifiable"] });
    const environment = providerReadiness(state({ effective: { ...ready, ...source("environment") } })).openai;
    expect(environment.reasons).toEqual(["environment_key_unverifiable"]);
  });

  it("ready: text is ready and a text task routes to the provider at a current price", () => {
    const unpriced = { ...priced, price: "missing" };
    const noRoute = providerReadiness(
      state({ effective: { ...ready, ...source("project"), effectiveRoutes: { chat_operator: unpriced, draft_social: unpriced } } }),
    ).openai;
    // textModelReady accepts an OpenAI key with verified models; the price still counts here.
    expect(noRoute).toMatchObject({ stored: true, ready: false });
    expect(noRoute.reasons).toContain("no_text_route");
    const claude = { ...priced, model: "c", provider: "anthropic" };
    const notReady = providerReadiness(
      state({
        effective: {
          ...ready,
          anthropicKeyConfigured: true,
          keySources: { openai: "project", image: "none", anthropic: "environment" },
          effectiveRoutes: { chat_operator: claude, draft_social: { error: "MODEL_CAPABILITY_NOT_VERIFIED" } },
        },
      }),
    );
    expect(notReady.anthropic.reasons).toEqual(["environment_key_unverifiable", "text_not_ready"]);
    expect(notReady.openai.reasons).toContain("text_not_ready");
  });
});

// ---------------------------------------------------------------------------
// The route

type Person = { id: string; email: string; cookie?: string };

describe.skipIf(!enabled)("GET /api/management/projects/:projectId/ai/effective", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  const connections: string[] = [];
  const people = {} as Record<"owner" | "projectOwner" | "editor" | "outsider", Person>;
  let orgId = "";
  let standardOrgId = "";
  // One project per fixture.
  const fx = {
    envOnly: "", system: "", standard: "", preset: "", own: "", ownKey: "",
    granted: "", revoked: "", missing: "", failed: "", foreign: "",
  };
  const SECRETS = {
    env: ENV_KEY,
    preset: `sk-preset-${randomBytes(16).toString("hex")}`,
    own: `sk-own-${randomBytes(16).toString("hex")}`,
    ownKey: `sk-ownkey-${randomBytes(16).toString("hex")}`,
    standard: `sk-synthetic-${randomBytes(16).toString("hex")}`,
    granted: `sk-synthetic-${randomBytes(16).toString("hex")}`,
    revoked: `sk-synthetic-${randomBytes(16).toString("hex")}`,
    failed: `sk-synthetic-${randomBytes(16).toString("hex")}`,
  };
  const CHECKED_LABEL = "Synthetic checked OpenAI";
  // The system AI profile is global; other test files expect it as it was.
  let systemBefore: { id: string; data: unknown; version: number } | null | undefined;

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name, password } });
    users.push(r.user.id);
    return { id: r.user.id, email };
  }
  async function signIn(email: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  }
  const url = (projectId: string) => `/api/management/projects/${projectId}/ai/effective`;
  const get = (projectId: string, who?: Person) =>
    app.inject({
      method: "GET",
      url: url(projectId),
      headers: { origin, [CLIENT_IP_HEADER]: ip(), ...(who ? { cookie: who.cookie! } : {}) },
    });
  async function effective(projectId: string) {
    const r = await get(projectId, people.owner);
    expect(r.statusCode).toBe(200);
    return r.json() as ProjectAiEffective;
  }
  async function withoutEnvironmentKey<T>(fn: () => Promise<T>) {
    delete process.env.OPENAI_API_KEY;
    try {
      return await fn();
    } finally {
      process.env.OPENAI_API_KEY = ENV_KEY;
    }
  }
  const scopeOf = (workspaceId: string, projectId: string): Scope => ({
    workspaceId, projectId, userId: people.owner.id, role: "owner",
  });
  const inProject = <T>(workspaceId: string, projectId: string, fn: (tx: DbTx, scope: Scope) => Promise<T>) =>
    scoped(workspaceId, projectId, (tx) => fn(tx, scopeOf(workspaceId, projectId)));
  /** An organization OpenAI connection granted to one project, with the given status. */
  async function grantedConnection(workspaceId: string, projectId: string, label: string, secret: string, status: string) {
    const actor = { userId: people.owner.id, role: "owner" as const, workspaceId };
    const created = await createConnection(actor, { provider: "openai", label, config: {}, secret });
    connections.push(created.id);
    await grantConnection(actor, created.id, { projectId, purposes: ["text"], monthlyBudgetMicros: 5_000_000 });
    await authDb.connection.update({ where: { id: created.id }, data: { status } });
    return created.id;
  }
  async function restoreSystemProfile() {
    if (systemBefore === undefined) return;
    if (systemBefore === null) await authDb.aiProfile.deleteMany({ where: { scope: "system" } });
    else
      await authDb.aiProfile.update({
        where: { id: systemBefore.id },
        data: { data: systemBefore.data as object, version: systemBefore.version },
      });
  }

  beforeAll(async () => {
    const row = await authDb.aiProfile.findFirst({ where: { scope: "system" } });
    systemBefore = row ? { id: row.id, data: row.data, version: row.version } : null;
    app = await buildServer();
    for (const key of ["owner", "projectOwner", "editor", "outsider"] as const)
      people[key] = await signUp(`Synthetic ${key}`);
    orgId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic AI effective",
          members: {
            create: [
              { userId: people.owner.id, role: "owner" },
              { userId: people.projectOwner.id, role: "viewer" },
              { userId: people.editor.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    // The organization standard lives on an organization profile, which would
    // shape every project of its organization: a second organization.
    standardOrgId = (
      await authDb.workspace.create({
        data: { name: "Synthetic AI standard", members: { create: { userId: people.owner.id, role: "owner" } } },
      })
    ).id;
    const foreignOrg = (
      await authDb.workspace.create({
        data: { name: "Synthetic foreign AI", members: { create: { userId: people.outsider.id, role: "owner" } } },
      })
    ).id;
    workspaces.push(orgId, standardOrgId, foreignOrg);
    const project = async (workspaceId: string, name: string) =>
      (await authDb.project.create({ data: { workspaceId, name } })).id;
    fx.envOnly = (
      await authDb.project.create({
        data: {
          workspaceId: orgId,
          name: "Synthetic environment only",
          members: {
            create: [
              { userId: people.projectOwner.id, role: "owner" },
              { userId: people.editor.id, role: "editor" },
            ],
          },
        },
      })
    ).id;
    for (const key of ["system", "preset", "own", "ownKey", "granted", "revoked", "missing", "failed"] as const)
      fx[key] = await project(orgId, `Synthetic ${key}`);
    fx.standard = await project(standardOrgId, "Synthetic standard");
    fx.foreign = await project(foreignOrg, "Synthetic foreign project");
    for (const key of ["owner", "projectOwner", "editor", "outsider"] as const)
      people[key].cookie = await signIn(people[key].email);

    // Organization standard: Claude, balanced; the project follows it with a granted key.
    await saveAiDefaults(people.owner.id, { scope: "workspace", workspaceId: standardOrgId }, { provider: "anthropic", level: "balanced" });
    await grantedConnection(standardOrgId, fx.standard, "Synthetic standard OpenAI", SECRETS.standard, "read_verified");
    await inProject(standardOrgId, fx.standard, (tx, s) => saveAiRouting(tx, s, { source: "organization", overrides: {} }));
    // Own preset.
    await inProject(orgId, fx.preset, async (tx, s) => {
      await saveOpenAiConfiguration(tx, s, { apiKey: SECRETS.preset, verifiedModels: [], rateCard: {} });
      await saveAiRouting(tx, s, { source: "preset", provider: "openai", level: "economy", overrides: {} });
    });
    // Own choice: verified model, price and one task route of its own.
    await inProject(orgId, fx.own, (tx, s) =>
      saveOpenAiConfiguration(tx, s, {
        apiKey: SECRETS.own,
        verifiedModels: ["synthetic-own"],
        rateCard: { "synthetic-own": rate },
        taskRoutes: { chat_operator: { model: "synthetic-own", maxOutputTokens: 1000 } },
      }),
    );
    // Own key only.
    await inProject(orgId, fx.ownKey, (tx, s) =>
      saveOpenAiConfiguration(tx, s, { apiKey: SECRETS.ownKey, verifiedModels: [], rateCard: {} }),
    );
    await grantedConnection(orgId, fx.granted, CHECKED_LABEL, SECRETS.granted, "read_verified");
    const revoked = await grantedConnection(orgId, fx.revoked, "Synthetic revoked OpenAI", SECRETS.revoked, "read_verified");
    await authDb.connectionGrant.updateMany({ where: { connectionId: revoked }, data: { revokedAt: new Date() } });
    await grantedConnection(orgId, fx.failed, "Synthetic failed OpenAI", SECRETS.failed, "failed");
  });
  afterAll(async () => {
    await restoreSystemProfile();
    if (workspaces.length) {
      await authDb.aiProfile.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await authDb.aiModelPrice.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await authDb.connection.deleteMany({ where: { id: { in: connections } } });
      await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    }
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("answers 404 before authentication while the settings center is off", async () => {
    process.env.ORBIT_SETTINGS_CENTER = "off";
    try {
      expect((await get(fx.envOnly)).statusCode).toBe(404);
    } finally {
      process.env.ORBIT_SETTINGS_CENTER = "preview";
    }
  });

  it("is for project owners only", async () => {
    expect((await get(fx.envOnly, people.projectOwner)).statusCode).toBe(200);
    expect((await get(fx.envOnly, people.owner)).statusCode).toBe(200);
    const editor = await get(fx.envOnly, people.editor);
    expect(editor.statusCode).toBe(403);
    expect(editor.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await get(fx.envOnly, people.outsider)).statusCode).toBe(404);
    expect((await get(fx.envOnly)).statusCode).toBe(401);
  });

  it("environment only", async () => {
    const body = await effective(fx.envOnly);
    expect(body.projectId).toBe(fx.envOnly);
    expect(body.routingMode).toBe("unsaved");
    expect(body.defaultProvider.origin).toBe("environment");
    expect(body.keys.openai).toMatchObject({ origin: "environment", stored: false, effective: true, connection: null });
    expect(body.readiness.openai).toMatchObject({ stored: true, verified: false });
    expect(body.readiness.openai.reasons).toContain("environment_key_unverifiable");
  });

  it("system profile", async () => {
    try {
      await saveAiProfile(people.owner.id, { scope: "system" }, {
        verifiedModels: ["sys-fast", "sys-standard", "sys-quality"],
        modelRoutes: { fast: "sys-fast", standard: "sys-standard", quality: "sys-quality", escalation: "sys-quality" },
      });
      const body = await effective(fx.system);
      expect(body.tiers.openai.fast).toEqual({ stored: null, effective: "sys-fast", origin: "system" });
    } finally {
      await restoreSystemProfile();
    }
  });

  it("organization standard", async () => {
    const body = await effective(fx.standard);
    expect(body.routingMode).toBe("organization");
    expect(body.routingApplied).toBe(true);
    expect(body.standardSource).toBe("organization");
    expect(body.defaultProvider).toEqual({ origin: "organization", effective: "anthropic", stored: "openai" });
  });

  it("preset", async () => {
    const body = await effective(fx.preset);
    expect(body.routingMode).toBe("preset");
    expect(body.standardSource).toBeNull();
    expect(body.tiers.openai.fast.origin).toBe("preset");
    expect(body.exceptions.routes).toBe(false);
  });

  it("own choice", async () => {
    const body = await effective(fx.own);
    expect(body.routingMode).toBe("custom");
    expect(body.taskRoutes.chat_operator).toMatchObject({
      explicit: true,
      origin: "project",
      stored: { model: "synthetic-own", maxOutputTokens: 1000 },
      effective: { model: "synthetic-own", provider: "openai", price: "current" },
    });
    expect(body.taskRoutes.draft_blog.explicit).toBe(false);
    expect(body.exceptions).toMatchObject({ models: true, routes: true, prices: true });
  });

  it("own key", async () => {
    const body = await effective(fx.ownKey);
    expect(body.keys.openai).toMatchObject({ stored: true, origin: "project" });
    expect(body.readiness.openai.verified).toBe(false);
    expect(body.readiness.openai.reasons).toContain("project_key_unverifiable");
  });

  it("granted key, checked", async () => {
    const body = await effective(fx.granted);
    expect(body.keys.openai).toMatchObject({
      stored: false,
      effective: true,
      origin: "organization",
      connection: { label: CHECKED_LABEL, status: "read_verified", disabled: false },
    });
    expect(body.readiness.openai).toMatchObject({ verified: true, ready: true });
    // Granted for text only: image calls run on the text key (imageApiKey ?? apiKey).
    expect(body.keys.image).toEqual({
      stored: false,
      effective: true,
      origin: "organization",
      connection: { label: CHECKED_LABEL, status: "read_verified", disabled: false },
    });
  });

  it("revoked grant", async () => {
    const body = await withoutEnvironmentKey(() => effective(fx.revoked));
    expect(body.keys.openai).toMatchObject({ effective: false, origin: null, connection: null });
    expect(body.readiness.openai).toMatchObject({ stored: false, reasons: ["no_key"] });
  });

  it("missing key", async () => {
    const body = await withoutEnvironmentKey(() => effective(fx.missing));
    for (const provider of ["openai", "anthropic"] as const)
      expect(body.readiness[provider]).toMatchObject({ stored: false, verified: false, ready: false });
  });

  it("failed check", async () => {
    const body = await effective(fx.failed);
    expect(body.readiness.openai).toMatchObject({ stored: true, verified: false });
    expect(body.readiness.openai.reasons).toContain("connection_failed");
  });

  it("never returns a key, a profile or another project", async () => {
    const all = Object.values(fx);
    for (const [name, projectId] of Object.entries(fx)) {
      if (name === "foreign") continue;
      const r = await get(projectId, people.owner);
      expect(r.statusCode).toBe(200);
      const text = JSON.stringify(r.json());
      for (const secret of Object.values(SECRETS)) expect(text, name).not.toContain(secret);
      for (const word of ["encrypted", "rateCard", "verifiedModels", "secret", "config", "settings"])
        expect(text, `${name}: ${word}`).not.toContain(word);
      for (const other of all.filter((id) => id !== projectId)) expect(text, name).not.toContain(other);
      expect(text).not.toContain(orgId);
      expect(text).not.toContain(standardOrgId);
    }
  });
});

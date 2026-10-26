import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  anthropicCatalog,
  resolveRoute,
  type TaskClass,
} from "../../../packages/ai/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  openAiConfigurationVersion,
  projectAiConfigurationView,
  runtimeOpenAiConfiguration,
  saveAiProviderConfiguration,
  saveAiRouting,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import { setModelPrice } from "../src/platform/administration/ai-catalog.ts";
import {
  clearAiDefaults,
  saveAiDefaults,
} from "../src/platform/administration/ai-defaults.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The organization routes live with the central connections (ADR 0014).
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
});

/**
 * Organization standard models and project presets (plans/
 * ai-central-management.md, phase B): with ORBIT_AI_DEFAULTS and the catalog
 * on, the organization's provider and level decide the models of projects
 * without own settings and of projects that chose the standard; a project
 * may deviate per task or pick an own preset, and "custom" restores its
 * saved settings unchanged.
 */
describe.skipIf(!enabled)("AI organization defaults", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let fresh: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const KEY = `sk-ant-${randomBytes(16).toString("hex")}`;
  const on = () =>
    Object.assign(process.env, {
      ORBIT_AI_CATALOG: "true",
      ORBIT_AI_DEFAULTS: "true",
    });
  const org = () => ({ scope: "workspace" as const, workspaceId: scope.workspaceId });
  const runtime = (s: Scope) =>
    scoped(s.workspaceId, s.projectId, (tx) => runtimeOpenAiConfiguration(tx, s));
  const model = async (s: Scope, task: TaskClass) =>
    resolveRoute(task, await runtime(s)).model;
  const routing = (raw: unknown) =>
    scoped(scope.workspaceId, scope.projectId, (tx) => saveAiRouting(tx, scope, raw));

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic defaults owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic defaults",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const [claude, unsaved] = await Promise.all(
      ["Claude custom", "Not configured"].map((name) =>
        authDb.project.create({ data: { workspaceId: workspace.id, name } }),
      ),
    );
    scope = {
      workspaceId: workspace.id,
      projectId: claude!.id,
      userId: created.user.id,
      role: "owner",
    };
    fresh = { ...scope, projectId: unsaved!.id };
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: "198.18.7.8" },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    // Custom settings: Claude by its own tiers, one own task route.
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await saveAiProviderConfiguration(tx, scope, {
        anthropicApiKey: KEY,
        applyAnthropicCatalog: true,
        defaultProvider: "anthropic",
        anthropicTierRoutes: { ...anthropicCatalog.tiers },
      });
      const view = await projectAiConfigurationView(tx, scope);
      await saveOpenAiConfiguration(tx, scope, {
        verifiedModels: view.verifiedModels,
        rateCard: view.rateCard,
        modelRoutes: view.modelRoutes,
        taskRoutes: {
          support_triage: { model: "claude-haiku-5-5", maxOutputTokens: 800 },
        },
      });
    });
  });
  afterEach(() => {
    delete process.env.ORBIT_AI_CATALOG;
    delete process.env.ORBIT_AI_DEFAULTS;
  });
  afterAll(async () => {
    await authDb.aiModelPrice.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("refuses standard models that name an inactive or wrong-purpose model", async () => {
    await setModelPrice(scope.userId, org(), "gpt-6-astra", { active: false });
    await expect(
      saveAiDefaults(scope.userId, org(), { provider: "openai", level: "quality" }),
    ).rejects.toMatchObject({ code: "PRESET_MODEL_INACTIVE" });
    await setModelPrice(scope.userId, org(), "gpt-6-astra", { active: true });
    await expect(
      saveAiDefaults(scope.userId, org(), {
        provider: "openai",
        level: "balanced",
        imageModel: "gpt-6-luna",
      }),
    ).rejects.toMatchObject({ code: "IMAGE_MODEL_NOT_VERIFIED" });
    await expect(
      saveAiDefaults(scope.userId, org(), {
        provider: "anthropic",
        level: "balanced",
        taskRoutes: {
          chat_operator: {
            model: "claude-sonnet-5-5",
            reasoningEffort: "none",
            maxOutputTokens: 1000,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "ROUTE_EFFORT_UNSUPPORTED" });
  });

  it("changes nothing while the flag is off", async () => {
    await saveAiDefaults(scope.userId, org(), {
      provider: "openai",
      level: "economy",
      imageModel: "gpt-image-2.5-sunburst",
    });
    process.env.ORBIT_AI_CATALOG = "true";
    expect(await model(scope, "chat_operator")).toBe("claude-sonnet-5-5");
    expect(await model(fresh, "chat_operator")).not.toBe("gpt-6-luna");
    await expect(routing({ source: "organization" })).rejects.toMatchObject({
      code: "AI_DEFAULTS_DISABLED",
    });
  });

  it("gives projects without own settings the organization's standard", async () => {
    on();
    expect(await model(fresh, "chat_operator")).toBe("gpt-6-luna");
    expect(await model(fresh, "draft_blog")).toBe("gpt-6.1-sol");
    // A project with its own settings keeps them.
    expect(await model(scope, "chat_operator")).toBe("claude-sonnet-5-5");
    const before = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      openAiConfigurationVersion(tx, scope),
    );
    await saveAiDefaults(scope.userId, org(), {
      provider: "anthropic",
      level: "economy",
      imageModel: "gpt-image-2.5-sunburst",
    });
    expect(await model(fresh, "chat_operator")).toBe("claude-haiku-5-5");
    expect(await model(fresh, "draft_blog")).toBe("claude-sonnet-5-5");
    // Every change of the standard changes the route version.
    const after = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      openAiConfigurationVersion(tx, scope),
    );
    expect(after).not.toBe(before);
  });

  it("follows the standard with per-task deviations and restores custom settings", async () => {
    on();
    await routing({
      source: "organization",
      overrides: { support_triage: { model: "gpt-6-luna", maxOutputTokens: 800 } },
    });
    expect(await model(scope, "chat_operator")).toBe("claude-haiku-5-5");
    expect(await model(scope, "draft_blog")).toBe("claude-sonnet-5-5");
    expect(await model(scope, "support_triage")).toBe("gpt-6-luna");
    // The standard's task routes apply; the project's deviation wins.
    await saveAiDefaults(scope.userId, org(), {
      provider: "anthropic",
      level: "economy",
      imageModel: "gpt-image-2.5-sunburst",
      taskRoutes: {
        agent_review: { model: "claude-opus-5-5", maxOutputTokens: 1800 },
        support_triage: { model: "claude-sonnet-5-5", maxOutputTokens: 800 },
      },
    });
    expect(await model(scope, "agent_review")).toBe("claude-opus-5-5");
    expect(await model(scope, "support_triage")).toBe("gpt-6-luna");
    const view = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      projectAiConfigurationView(tx, scope),
    );
    expect(view.routing).toMatchObject({ source: "organization" });
    expect(view.defaults?.standard).toMatchObject({
      source: "organization",
      provider: "anthropic",
      level: "economy",
    });
    expect(view.defaultProvider).toBe("anthropic");
    expect(JSON.stringify(view)).not.toContain(KEY);
    // Images keep the project's switch with the standard image model.
    expect((await runtime(scope)).imageGeneration?.model).toBe("gpt-image-2.5-sunburst");
    await routing({ source: "custom" });
    expect(await model(scope, "chat_operator")).toBe("claude-sonnet-5-5");
    expect(await model(scope, "support_triage")).toBe("claude-haiku-5-5");
  });

  it("applies an own preset and checks its deviations", async () => {
    on();
    await routing({ source: "preset", provider: "openai", level: "quality" });
    expect(await model(scope, "chat_operator")).toBe("gpt-6.1-sol");
    expect(await model(scope, "draft_blog")).toBe("gpt-6-astra");
    await expect(
      routing({
        source: "preset",
        provider: "openai",
        level: "economy",
        overrides: { chat_operator: { model: "gpt-unknown", maxOutputTokens: 800 } },
      }),
    ).rejects.toMatchObject({ code: "ROUTED_MODEL_NOT_VERIFIED" });
    await routing({ source: "custom" });
  });

  it("needs a key the project keeps using before a first save", async () => {
    on();
    await expect(
      scoped(fresh.workspaceId, fresh.projectId, (tx) =>
        saveAiRouting(tx, fresh, { source: "organization" }),
      ),
    ).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
  });

  it("lets organization owners set the standard over HTTP, not anonymous callers", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: `/api/organizations/${scope.workspaceId}/ai/defaults`,
      headers: { origin, cookie },
      payload: { provider: "anthropic", level: "balanced" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().defaults).toMatchObject({ provider: "anthropic", level: "balanced" });
    const audit = await authDb.systemAuditEvent.findFirst({
      where: { action: "ai_profile.updated", workspaceId: scope.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/organizations/${scope.workspaceId}/ai/defaults`,
      headers: { origin },
    });
    expect(anonymous.statusCode).toBe(401);
    const cleared = await clearAiDefaults(scope.userId, org());
    expect(cleared.defaults).toBeNull();
  });
});

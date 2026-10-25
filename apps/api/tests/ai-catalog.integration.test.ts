import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { priceCatalog } from "../../../packages/ai/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  projectAiConfigurationView,
  runtimeOpenAiConfiguration,
  saveAiProviderConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import {
  listModelPrices,
  resetModelPrice,
  setModelPrice,
} from "../src/platform/administration/ai-catalog.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The organization routes live with the central connections (ADR 0014).
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
});

/**
 * The central price catalog (plans/ai-central-management.md, phase A): with
 * ORBIT_AI_CATALOG on, every project prices and verifies the active catalog
 * models; the organization's override beats the system's, the project's own
 * rate card beats both, and a switched-off model is no longer verified.
 */
describe.skipIf(!enabled)("AI price catalog", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const KEY = `sk-ant-${randomBytes(16).toString("hex")}`;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const runtime = () => run((tx) => runtimeOpenAiConfiguration(tx, scope));
  const org = () => ({ scope: "workspace" as const, workspaceId: scope.workspaceId });

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic catalog owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic catalog",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Claude only" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: created.user.id,
      role: "owner",
    };
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: "198.18.7.7" },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    // A Claude-only project with its own price for Haiku.
    await run((tx) =>
      saveAiProviderConfiguration(tx, scope, {
        anthropicApiKey: KEY,
        applyAnthropicCatalog: true,
        defaultProvider: "anthropic",
      }),
    );
  });
  afterEach(() => {
    delete process.env.ORBIT_AI_CATALOG;
  });
  afterAll(async () => {
    await authDb.aiModelPrice.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await authDb.aiModelPrice.deleteMany({ where: { scope: "system", updatedBy: { in: users } } });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("changes nothing while the flag is off", async () => {
    const r = await runtime();
    expect(r.verifiedModels).not.toContain("gpt-image-2.5-flare");
    expect(r.rateCard?.["gpt-6-luna"]).toBeUndefined();
    const view = await run((tx) => projectAiConfigurationView(tx, scope));
    expect(view.catalog).toBeNull();
  });

  it("verifies and prices every active catalog model with the flag on", async () => {
    process.env.ORBIT_AI_CATALOG = "true";
    const r = await runtime();
    expect(r.verifiedModels).toEqual(
      expect.arrayContaining(["gpt-image-2.5-flare", "gpt-6-luna", "text-embedding-3-small"]),
    );
    expect(r.rateCard?.["gpt-6-luna"]).toMatchObject({
      inputMicrosPerMillion: priceCatalog["gpt-6-luna"]!.rate!.inputMicrosPerMillion,
      verifiedAt: priceCatalog["gpt-6-luna"]!.verifiedAt,
    });
    const view = await run((tx) => projectAiConfigurationView(tx, scope));
    expect(view.catalog?.find((m) => m.id === "gpt-image-2.5-flare")).toMatchObject({
      purpose: "image",
      perImageMicros: 250_000,
      priceSource: "orbit",
      active: true,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("applies system, then organization overrides, and the project's own price last", async () => {
    process.env.ORBIT_AI_CATALOG = "true";
    await setModelPrice(scope.userId, { scope: "system" }, "gpt-6-luna", {
      inputMicrosPerMillion: 111_000,
    });
    expect((await runtime()).rateCard?.["gpt-6-luna"]?.inputMicrosPerMillion).toBe(111_000);
    await setModelPrice(scope.userId, org(), "gpt-6-luna", { inputMicrosPerMillion: 222_000 });
    expect((await runtime()).rateCard?.["gpt-6-luna"]?.inputMicrosPerMillion).toBe(222_000);
    const listed = await listModelPrices(org());
    expect(listed.models.find((m) => m.id === "gpt-6-luna")).toMatchObject({
      priceSource: "organization",
      overridden: true,
    });
    // The project's own Claude prices (from "Configure Claude") stay its own.
    await setModelPrice(scope.userId, org(), "claude-haiku-5-5", { inputMicrosPerMillion: 1 });
    expect((await runtime()).rateCard?.["claude-haiku-5-5"]?.inputMicrosPerMillion).toBe(
      priceCatalog["claude-haiku-5-5"]!.rate!.inputMicrosPerMillion,
    );
    // Resetting falls back to the next level.
    await resetModelPrice(scope.userId, org(), "gpt-6-luna");
    expect((await runtime()).rateCard?.["gpt-6-luna"]?.inputMicrosPerMillion).toBe(111_000);
    await resetModelPrice(scope.userId, { scope: "system" }, "gpt-6-luna");
  });

  it("stops verifying a model the organization switched off", async () => {
    process.env.ORBIT_AI_CATALOG = "true";
    await setModelPrice(scope.userId, org(), "gpt-6-astra", { active: false });
    expect((await runtime()).verifiedModels).not.toContain("gpt-6-astra");
    await expect(
      setModelPrice(scope.userId, org(), "gpt-unknown", { active: false }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_IN_CATALOG" });
    await expect(
      setModelPrice(scope.userId, org(), "gpt-image-2.5-flare", { inputMicrosPerMillion: 1 }),
    ).rejects.toMatchObject({ code: "MODEL_HAS_NO_TOKEN_PRICE" });
  });

  it("lets organization owners edit their catalog over HTTP, not other members", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/organizations/${scope.workspaceId}/ai/models`,
      headers: { origin, cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().models.length).toBe(Object.keys(priceCatalog).length);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/organizations/${scope.workspaceId}/ai/models/gpt-image-2.5-flare`,
      headers: { origin, cookie },
      payload: { perImageMicros: 120_000 },
    });
    expect(saved.statusCode).toBe(200);
    const audit = await authDb.systemAuditEvent.findFirst({
      where: { action: "ai_model_price.updated", workspaceId: scope.workspaceId },
    });
    expect(audit).not.toBeNull();
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/organizations/${scope.workspaceId}/ai/models`,
      headers: { origin },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

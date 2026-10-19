import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { estimateCost } from "../../../packages/ai/src/index.ts";
import { create, data, DomainError } from "../src/shared.ts";
import {
  publicOpenAiConfiguration,
  runtimeOpenAiConfiguration,
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import { markTransmitted, reserve, settle } from "../src/platform/ai/budget.ts";
import { requireSpendMandate } from "../src/platform/ai/spend-mandate.ts";
import {
  providerBudgetStatus,
  providerPeriodSpend,
} from "../src/platform/ai/provider-budget.ts";
import { planCall } from "../src/platform/ai/call-plan.ts";
import { aiCostSummary } from "../src/platform/ai/ai-usage.ts";
import { projectAttention } from "../src/platform/attention/attention.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const rate = (input: number, output: number) => ({
  inputMicrosPerMillion: input,
  outputMicrosPerMillion: output,
  verifiedAt: new Date().toISOString(),
});
const CLAUDE = "claude-sonnet-5-5";
const GPT = "gpt-5.6-terra";
const KEY = "synthetic-anthropic-" + "k".repeat(24);

describe.skipIf(!enabled)("AI provider configuration and budget", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let editorScope: Scope;
  let ownerCookie: string;
  const origin = process.env.APP_ORIGIN!;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(scope.workspaceId, scope.projectId, work);

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const owner = await auth.api.signUpEmail({
      body: {
        email: randomUUID() + "@example.invalid",
        name: "Synthetic provider owner",
        password,
      },
    });
    const editor = await auth.api.signUpEmail({
      body: {
        email: randomUUID() + "@example.invalid",
        name: "Synthetic provider editor",
        password,
      },
    });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Provider budget",
        members: {
          create: [
            { userId: owner.user.id, role: "owner" },
            { userId: editor.user.id, role: "viewer" },
          ],
        },
      },
    });
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Providers",
        members: { create: { userId: editor.user.id, role: "editor" } },
      },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: owner.user.id,
      role: "owner",
    };
    editorScope = { ...scope, userId: editor.user.id, role: "editor" };
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email: owner.user.email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const cookies = signIn.headers["set-cookie"];
    ownerCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
    const past = new Date(Date.now() - 3600000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    await run(async (tx) => {
      await create(tx, scope, "policies", {
        mode: "observe",
        channels: ["x-test"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: past,
        endAt: future,
        maxPerDay: 0,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 50_000_000,
        monthlyBudgetMicros: 50_000_000,
        perRunBudgetMicros: 5_000_000,
        approvedPaidTests: true,
        active: true,
      });
      await saveOpenAiConfiguration(tx, scope, {
        apiKey: "synthetic-openai-" + "k".repeat(24),
        verifiedModels: [GPT, CLAUDE, "claude-haiku-5-5", "claude-opus-5-5"],
        rateCard: {
          [GPT]: rate(1_000_000, 1_000_000),
          [CLAUDE]: rate(2_000_000, 10_000_000),
          "claude-haiku-5-5": rate(100_000, 500_000),
          "claude-opus-5-5": rate(4_000_000, 20_000_000),
        },
        modelRoutes: { fast: GPT, standard: GPT, quality: GPT, escalation: GPT },
        taskRoutes: {
          chat_operator: { model: CLAUDE, maxOutputTokens: 1000 },
        },
      });
    });
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: scope.workspaceId } });
    await authDb.user.deleteMany({
      where: { id: { in: [scope.userId, editorScope.userId] } },
    });
    await app?.close();
    await closeDatabase();
  });

  const budget = (stopMicros: number) => ({
    monthlyMicros: 100_000_000,
    warnMicros: Math.min(75_000_000, stopMicros),
    warn2Micros: Math.min(90_000_000, stopMicros),
    stopMicros,
    anchorDay: 1,
  });
  const configureProvider = (input: Record<string, unknown>) =>
    run((tx) => saveAiProviderConfiguration(tx, scope, input));

  it("saves the provider fields owner-only, keeps the key secret and bumps the route version", async () => {
    const before = await run((tx) => runtimeOpenAiConfiguration(tx, scope));
    await expect(
      run((tx) =>
        saveAiProviderConfiguration(tx, editorScope, {
          anthropicApiKey: KEY,
        }),
      ),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    const saved = await configureProvider({
      anthropicApiKey: KEY,
      defaultProvider: "anthropic",
      anthropicTierRoutes: {
        fast: "claude-haiku-5-5",
        standard: CLAUDE,
        quality: "claude-opus-5-5",
      },
      models: { [CLAUDE]: { provider: "anthropic", displayName: "Sonnet" } },
      providerBudgets: { anthropic: budget(95_000_000) },
      fallback: { onProviderBudgetStop: "none" },
    });
    expect(saved.providers.anthropic).toEqual({
      keyConfigured: true,
      source: "orbit",
    });
    expect(saved.defaultProvider).toBe("anthropic");
    expect(saved.routeVersion).toBe((before.routeVersion ?? 0) + 1);
    expect(JSON.stringify(saved)).not.toContain(KEY);
    // The OpenAI fields are untouched; the tier fallback now resolves to Claude.
    expect(saved.verifiedModels).toContain(GPT);
    expect(saved.effectiveRoutes.draft_social).toMatchObject({
      model: CLAUDE,
      provider: "anthropic",
      price: "current",
    });
    expect(saved.effectiveRoutes.chat_operator).toMatchObject({
      model: CLAUDE,
      provider: "anthropic",
    });
    const runtime = await run((tx) => runtimeOpenAiConfiguration(tx, scope));
    expect(runtime.anthropicApiKey).toBe(KEY);
    expect(runtime.apiKey).toMatch(/^synthetic-openai-/);
    expect(runtime.providerBudgets?.anthropic?.stopMicros).toBe(95_000_000);
    // The GET route answers the owner, never the key.
    const get = await app.inject({
      url: `/api/projects/${scope.projectId}/openai-configuration`,
      headers: { cookie: ownerCookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().providers.anthropic.keyConfigured).toBe(true);
    expect(get.body).not.toContain(KEY);
  });

  it("refuses an Anthropic tier that is not verified and a Claude route with effort none", async () => {
    await expect(
      configureProvider({
        anthropicTierRoutes: { fast: "claude-unknown", standard: CLAUDE, quality: CLAUDE },
      }),
    ).rejects.toMatchObject({ code: "ROUTED_MODEL_NOT_VERIFIED" });
    await run((tx) =>
      saveOpenAiConfiguration(tx, scope, {
        verifiedModels: [GPT, CLAUDE, "claude-haiku-5-5", "claude-opus-5-5"],
        rateCard: {
          [GPT]: rate(1_000_000, 1_000_000),
          [CLAUDE]: rate(2_000_000, 10_000_000),
          "claude-haiku-5-5": rate(100_000, 500_000),
          "claude-opus-5-5": rate(4_000_000, 20_000_000),
        },
        modelRoutes: { fast: GPT, standard: GPT, quality: GPT, escalation: GPT },
        taskRoutes: {
          chat_operator: { model: CLAUDE, reasoningEffort: "none", maxOutputTokens: 1000 },
        },
      }),
    );
    await expect(configureProvider({})).rejects.toMatchObject({
      code: "ROUTE_EFFORT_UNSUPPORTED",
    });
    // Restore the route used by the following tests.
    await run((tx) =>
      saveOpenAiConfiguration(tx, scope, {
        verifiedModels: [GPT, CLAUDE, "claude-haiku-5-5", "claude-opus-5-5"],
        rateCard: {
          [GPT]: rate(1_000_000, 1_000_000),
          [CLAUDE]: rate(2_000_000, 10_000_000),
          "claude-haiku-5-5": rate(100_000, 500_000),
          "claude-opus-5-5": rate(4_000_000, 20_000_000),
        },
        modelRoutes: { fast: GPT, standard: GPT, quality: GPT, escalation: GPT },
        taskRoutes: { chat_operator: { model: CLAUDE, maxOutputTokens: 1000 } },
      }),
    );
  });

  it("stops Claude reservations at the provider budget, also for parallel calls, and leaves OpenAI alone", async () => {
    // Stop at 3 USD; each Claude reservation below is 1 USD.
    await configureProvider({
      anthropicApiKey: KEY,
      providerBudgets: { anthropic: { ...budget(3_000_000), warnMicros: 1_000_000, warn2Micros: 2_000_000 } },
    });
    const reserveClaude = (key: string, amount = 1_000_000) =>
      run(async (tx) => {
        const mandate = await requireSpendMandate(tx, scope);
        return reserve(tx, scope, key, "chat_text", amount, mandate.limits, new Date(), key, {
          agentRunId: null,
          taskClass: "chat_operator",
          model: CLAUDE,
        });
      });
    // Four parallel reservations of 1 USD: exactly three fit under the 3 USD stop.
    const outcomes = await Promise.allSettled(
      ["p1", "p2", "p3", "p4"].map((key) => reserveClaude(`provider:${key}`)),
    );
    const refused = outcomes.filter(
      (o) =>
        o.status === "rejected" &&
        o.reason instanceof DomainError &&
        o.reason.code === "PROVIDER_BUDGET_STOP",
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(3);
    expect(refused).toHaveLength(1);
    // An OpenAI model is not bound by the Anthropic budget.
    await expect(
      run(async (tx) => {
        const mandate = await requireSpendMandate(tx, scope);
        return reserve(tx, scope, "provider:openai", "chat_text", 1_000_000, mandate.limits, new Date(), "provider:openai", {
          agentRunId: null,
          taskClass: "chat_operator",
          model: GPT,
        });
      }),
    ).resolves.toMatchObject({ state: "reserved" });
    const status = await run((tx) => providerBudgetStatus(tx, scope, "anthropic"));
    expect(status).toMatchObject({
      configured: true,
      level: "stopped",
      spend: expect.objectContaining({ spentMicros: 3_000_000, count: 3 }),
    });
    // Settling at the actual cost lowers the counted spend; unknown keeps the reservation.
    const rows = await run((tx) =>
      tx.budgetReservation.findMany({ where: { projectId: scope.projectId, model: CLAUDE } }),
    );
    await run(async (tx) => {
      await markTransmitted(tx, scope, rows[0]!.id);
      await settle(tx, scope, rows[0]!.id, 400_000);
      await markTransmitted(tx, scope, rows[1]!.id);
      await settle(tx, scope, rows[1]!.id, null);
    });
    const spend = await run((tx) =>
      providerPeriodSpend(tx, scope, "anthropic", { anchorDay: 1 }, undefined),
    );
    expect(spend).toMatchObject({
      spentMicros: 2_400_000,
      settledMicros: 400_000,
      unknownMicros: 1_000_000,
      pendingMicros: 1_000_000,
    });
    // Cost by provider separates the two providers' reservations.
    const byProvider = await aiCostSummary(scope, { groupBy: "provider" });
    expect(byProvider.rows.map((row) => row.key).sort()).toEqual(["anthropic", "openai"]);
    // The budget route and the attention item report the level.
    const budgetRoute = await app.inject({
      url: `/api/projects/${scope.projectId}/ai-budget`,
      headers: { cookie: ownerCookie },
    });
    expect(budgetRoute.statusCode).toBe(200);
    expect(budgetRoute.json().providers.anthropic).toMatchObject({
      configured: true,
      level: "warn2",
      creditSync: "manual",
      spend: expect.objectContaining({ spentMicros: "2400000" }),
    });
    const attention = await projectAttention(scope, new Date());
    expect(attention.items).toContainEqual(
      expect.objectContaining({
        kind: "platform_provider_budget",
        severity: "critical",
        params: expect.objectContaining({ level: "warn2", spentMicros: 2_400_000 }),
      }),
    );
  });

  it("falls back to the OpenAI tier only when the owner allowed it", async () => {
    const runtime = await run((tx) => runtimeOpenAiConfiguration(tx, scope));
    const estimate = (route: { model: string; maxOutputTokens: number }) =>
      estimateCost(route.model, 100_000, route.maxOutputTokens, runtime);
    // 2.4 USD are held; a 1 USD call passes the 3 USD stop, a 1.5 USD one does not.
    const small = await run((tx) =>
      planCall(tx, scope, "chat_operator", runtime, () => 500_000),
    );
    expect(small).toMatchObject({ provider: "anthropic", fallbackFrom: null });
    await expect(
      run(async (tx) => {
        const plan = await planCall(tx, scope, "chat_operator", runtime, () => 1_500_000);
        const mandate = await requireSpendMandate(tx, scope);
        return reserve(tx, scope, "provider:fallback-none", "chat_text", plan.estimateMicros, mandate.limits, new Date(), "provider:fallback-none", {
          agentRunId: null,
          taskClass: "chat_operator",
          model: plan.route.model,
        });
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_STOP" });
    await configureProvider({
      anthropicApiKey: KEY,
      providerBudgets: { anthropic: { ...budget(3_000_000), warnMicros: 1_000_000, warn2Micros: 2_000_000 } },
      fallback: { onProviderBudgetStop: "openai" },
    });
    const allowed = await run((tx) => runtimeOpenAiConfiguration(tx, scope));
    const plan = await run((tx) =>
      planCall(tx, scope, "chat_operator", allowed, () => 1_500_000),
    );
    expect(plan).toMatchObject({
      provider: "openai",
      fallbackFrom: CLAUDE,
      route: { model: GPT, maxOutputTokens: 3000 },
      estimateMicros: 1_500_000,
    });
    expect(estimate(plan.route)).toBeGreaterThan(0);
  });

  it("accepts the provider action over HTTP and forgets the key on request", async () => {
    const url = `/api/projects/${scope.projectId}/actions/ai-provider-configure`;
    const saved = await app.inject({
      method: "POST",
      url,
      headers: { origin, cookie: ownerCookie },
      payload: { clearAnthropicApiKey: true, defaultProvider: "openai" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().providers.anthropic.keyConfigured).toBe(
      Boolean(process.env.ANTHROPIC_API_KEY),
    );
    expect(saved.json().defaultProvider).toBe("openai");
    const conflict = await app.inject({
      method: "POST",
      url,
      headers: { origin, cookie: ownerCookie },
      payload: { anthropicApiKey: KEY, clearAnthropicApiKey: true },
    });
    expect(conflict.statusCode).toBe(400);
    const view = await run(async (tx) =>
      publicOpenAiConfiguration(
        await tx.entity.findFirst({
          where: { projectId: scope.projectId, kind: "openai_configuration" },
        }),
      ),
    );
    expect(data(await run((tx) => tx.entity.findFirstOrThrow({ where: { projectId: scope.projectId, kind: "openai_configuration" } }))).encryptedAnthropicApiKey).toBeUndefined();
    expect(view.fallback.onProviderBudgetStop).toBe("none");
  });
});

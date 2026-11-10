import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { reserve, settle } from "../src/platform/ai/budget.ts";
import { saveAiProviderConfiguration } from "../src/platform/ai/openai-configuration.ts";
import {
  readSpendPolicy,
  saveSpendPolicy,
  spendPolicyFields,
} from "../src/platform/ai/spend-policy.ts";
import { monthOf } from "../src/platform/ai/org-budget.ts";
import { seedOrganizationCounters } from "../src/platform/ai/org-budget-seed.ts";
import { saveOrganizationAiBudget } from "../src/platform/administration/ai-budget.ts";
import { ensurePersonalSpace } from "../src/platform/assistant/personal-space.ts";
import { moduleRegistry } from "../src/modules/registry.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
});
const USD = 1_000_000;

/**
 * The organization AI budget (plans/ai-central-management.md, phase C):
 * derived project limits, organization counters across projects with a
 * monthly budget and provider caps, the seed for reservations made before
 * the switch, the caps proposal and the owner routes.
 */
describe.skipIf(!enabled)("AI organization budget", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let a: Scope;
  let b: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const run = <T>(s: Scope, fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn);
  const ignored = {
    startAt: new Date(0).toISOString(),
    endAt: new Date(0).toISOString(),
    approvedPaidTests: false,
    dailyBudgetMicros: 0,
    monthlyBudgetMicros: 0,
    perRunBudgetMicros: 0,
  };
  const book = (s: Scope, amount: number, model?: string) =>
    run(s, (tx) =>
      reserve(
        tx,
        s,
        `org-test:${randomUUID()}`,
        "test",
        amount,
        ignored,
        new Date(),
        undefined,
        {
          ...(model ? { model } : {}),
        },
      ),
    );
  const counters = () =>
    authDb.organizationSpendCounter.findMany({
      where: { workspaceId: a.workspaceId, periodStart: monthOf(new Date()) },
    });
  const counter = async (key: string) => {
    const row = (await counters()).find((c) => c.scopeKey === key);
    return {
      reserved: Number(row?.reservedMicros ?? 0),
      settled: Number(row?.settledMicros ?? 0),
    };
  };

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic budget owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic budget",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const [one, two] = await Promise.all(
      ["Budget A", "Budget B"].map((name) =>
        authDb.project.create({ data: { workspaceId: workspace.id, name } }),
      ),
    );
    a = {
      workspaceId: workspace.id,
      projectId: one!.id,
      userId: created.user.id,
      role: "owner",
    };
    b = { ...a, projectId: two!.id };
    for (const s of [a, b])
      await run(s, (tx) =>
        saveSpendPolicy(tx, s, {
          profile: "monthly",
          monthlyBudgetMicros: 50 * USD,
        }),
      );
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: "198.18.7.9" },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set])
      .map((v) => v!.split(";")[0])
      .join("; ");
  });
  afterEach(() => {
    delete process.env.ORBIT_AI_ORG_BUDGET;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("derives day and run limits from a monthly amount (D-4)", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(
      spendPolicyFields(
        { profile: "monthly", monthlyBudgetMicros: 10 * USD },
        now,
      ),
    ).toMatchObject({
      profile: "monthly",
      approvedPaidUse: true,
      dailyBudgetMicros: USD,
      perRunBudgetMicros: USD,
      endAt: "2027-10-25T12:00:00.000Z",
    });
    expect(
      spendPolicyFields(
        { profile: "monthly", monthlyBudgetMicros: 50 * USD },
        now,
      ),
    ).toMatchObject({
      dailyBudgetMicros: 5 * USD,
      perRunBudgetMicros: 2 * USD,
    });
    expect(
      spendPolicyFields(
        {
          profile: "monthly",
          monthlyBudgetMicros: 50 * USD,
          perRunBudgetMicros: 3 * USD,
        },
        now,
      ),
    ).toMatchObject({
      dailyBudgetMicros: 5 * USD,
      perRunBudgetMicros: 3 * USD,
    });
    expect(
      spendPolicyFields({ profile: "monthly", monthlyBudgetMicros: 0 }, now),
    ).toMatchObject({
      approvedPaidUse: false,
    });
  });

  it("counts nothing while the switch is off", async () => {
    const row = await book(a, 100_000, "gpt-6-luna");
    expect(row.orgProvider).toBeNull();
    expect(await counters()).toEqual([]);
  });

  it("adds the month's reservations made before the switch once", async () => {
    const dry = await seedOrganizationCounters({ workspaceId: a.workspaceId });
    expect(dry.find((r) => r.projectId === a.projectId)).toMatchObject({
      reservations: 1,
      reservedMicros: 100_000,
    });
    expect(await counters()).toEqual([]);
    await seedOrganizationCounters({ workspaceId: a.workspaceId, apply: true });
    await seedOrganizationCounters({ workspaceId: a.workspaceId, apply: true });
    expect(await counter("total")).toEqual({ reserved: 100_000, settled: 0 });
    expect(await counter("openai")).toEqual({ reserved: 100_000, settled: 0 });
  });

  it("counts every project's calls and settles them on the same counters", async () => {
    process.env.ORBIT_AI_ORG_BUDGET = "true";
    const claude = await book(b, 200_000, "claude-haiku-5-5");
    expect(claude.orgProvider).toBe("anthropic");
    const none = await book(a, 50_000);
    expect(none.orgProvider).toBe("none");
    expect(await counter("total")).toEqual({ reserved: 350_000, settled: 0 });
    await run(b, (tx) => settle(tx, b, claude.id, 150_000));
    expect(await counter("anthropic")).toEqual({
      reserved: 0,
      settled: 150_000,
    });
    expect(await counter("total")).toEqual({
      reserved: 150_000,
      settled: 150_000,
    });
    // An unclear outcome stays reserved.
    await run(a, (tx) => settle(tx, a, none.id, null));
    expect(await counter("total")).toEqual({
      reserved: 150_000,
      settled: 150_000,
    });
  });

  it("stops at the organization's monthly budget and provider caps", async () => {
    process.env.ORBIT_AI_ORG_BUDGET = "true";
    // Spent so far: 300,000 (150,000 reserved, 150,000 settled).
    await saveOrganizationAiBudget(a.userId!, a.workspaceId, {
      monthlyMicros: 1_300_000,
      providerCaps: { anthropic: 400_000 },
    });
    await expect(book(b, 300_000, "claude-sonnet-5-5")).rejects.toMatchObject({
      code: "ORG_PROVIDER_BUDGET_EXCEEDED",
    });
    // A refused reservation adds nothing.
    expect(await counter("anthropic")).toEqual({
      reserved: 0,
      settled: 150_000,
    });
    await book(a, 900_000, "gpt-6-luna");
    await expect(book(b, 200_000, "gpt-6-luna")).rejects.toMatchObject({
      code: "ORG_AI_BUDGET_EXCEEDED",
    });
    const view = await run(a, (tx) => readSpendPolicy(tx, a));
    expect(view.organization).toMatchObject({
      monthlyMicros: 1_300_000,
      spentMicros: 1_200_000,
      level: "warn2",
      providers: {
        anthropic: { capMicros: 400_000, spentMicros: 150_000, level: "ok" },
      },
    });
  });

  it("lets owners read the budget, its caps proposal and the usage over HTTP", async () => {
    await run(b, (tx) =>
      saveAiProviderConfiguration(tx, b, {
        anthropicApiKey: `sk-ant-${randomBytes(16).toString("hex")}`,
        providerBudgets: {
          anthropic: {
            monthlyMicros: 100 * USD,
            warnMicros: 75 * USD,
            warn2Micros: 90 * USD,
            stopMicros: 95 * USD,
            anchorDay: 1,
          },
        },
      }),
    );
    const view = await app.inject({
      method: "GET",
      url: `/api/organizations/${a.workspaceId}/ai/budget`,
      headers: { origin, cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().proposal.providerCaps).toEqual({ anthropic: 95 * USD });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/organizations/${a.workspaceId}/ai/budget`,
      headers: { origin, cookie },
      payload: { monthlyMicros: null, providerCaps: { anthropic: 95 * USD } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().budget).toMatchObject({ monthlyMicros: null });
    expect(
      await authDb.systemAuditEvent.findFirst({
        where: { action: "ai_budget.updated", workspaceId: a.workspaceId },
      }),
    ).not.toBeNull();
    const usage = await app.inject({
      method: "GET",
      url: `/api/organizations/${a.workspaceId}/ai/usage`,
      headers: { origin, cookie },
    });
    expect(usage.statusCode).toBe(200);
    const body = usage.json();
    expect(body.projects).toHaveLength(2);
    expect(body.providers.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(["openai", "anthropic"]),
    );
    expect(
      body.projects.find(
        (p: { projectId: string }) => p.projectId === a.projectId,
      ),
    ).toMatchObject({
      unknownMicros: 50_000,
    });
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/organizations/${a.workspaceId}/ai/usage`,
      headers: { origin },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("shows the organization, assistant and project levels with state and origin (WP2 B)", async () => {
    const get = async () => {
      const r = await app.inject({
        method: "GET",
        url: `/api/organizations/${a.workspaceId}/ai/budget`,
        headers: { origin, cookie },
      });
      expect(r.statusCode).toBe(200);
      return r.json().levels;
    };
    // A personal space counts as one sum, never per user.
    const personal = {
      id: (await ensurePersonalSpace(a.workspaceId, a.userId, moduleRegistry()))
        .projectId,
    };
    await saveOrganizationAiBudget(a.userId, a.workspaceId, {
      monthlyMicros: 200 * USD,
      assistantPerUserMonthlyMicros: null,
      providerCaps: {},
      credits: {},
    });
    let levels = await get();
    // Saved but not applied while ORBIT_AI_ORG_BUDGET is off.
    expect(levels.organization).toMatchObject({
      state: "off",
      monthlyMicros: 200 * USD,
      origin: { by: { id: a.userId, name: "Synthetic budget owner" } },
    });
    expect(levels.assistant).toMatchObject({
      state: "not_set",
      capMicros: null,
      perAnswerMicros: null,
    });
    // One sum over the personal spaces: spend and unclear part, no per-user
    // or call count (the usage page counts calls).
    expect(levels.assistant.usage).toEqual({
      spentMicros: 0,
      unknownMicros: 0,
      spaces: 1,
    });
    expect(
      levels.projects.map((p: { projectId: string }) => p.projectId).sort(),
    ).toEqual([a.projectId, b.projectId].sort());
    expect(
      levels.projects.some(
        (p: { projectId: string }) => p.projectId === personal.id,
      ),
    ).toBe(false);
    expect(
      levels.projects.find(
        (p: { projectId: string }) => p.projectId === a.projectId,
      ),
    ).toMatchObject({
      state: "active",
      source: "platform",
      monthlyBudgetMicros: 50 * USD,
      perRunBudgetMicros: 2 * USD,
      origin: { by: { id: a.userId } },
    });
    // The assistant cap applies regardless of the switch; per answer a
    // tenth, at most USD 2.
    process.env.ORBIT_AI_ORG_BUDGET = "true";
    await saveOrganizationAiBudget(a.userId, a.workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: 5 * USD,
      providerCaps: {},
      credits: {},
    });
    await run(b, (tx) => saveSpendPolicy(tx, b, { profile: "off" }));
    levels = await get();
    expect(levels.organization.state).toBe("not_set");
    expect(levels.assistant).toMatchObject({
      state: "active",
      capMicros: 5 * USD,
      perDayMicros: 500_000,
      perAnswerMicros: 500_000,
    });
    expect(
      levels.projects.find(
        (p: { projectId: string }) => p.projectId === b.projectId,
      ).state,
    ).toBe("off");
    await saveOrganizationAiBudget(a.userId, a.workspaceId, {
      monthlyMicros: 10 * USD,
      assistantPerUserMonthlyMicros: 0,
      providerCaps: {},
      credits: {},
    });
    levels = await get();
    expect(levels.organization.state).toBe("active");
    expect(levels.assistant.state).toBe("off");
    // Reading never creates or changes a budget: no audit event either.
    const audits = await authDb.systemAuditEvent.count({
      where: { action: "ai_budget.updated", workspaceId: a.workspaceId },
    });
    await get();
    expect(
      await authDb.systemAuditEvent.count({
        where: { action: "ai_budget.updated", workspaceId: a.workspaceId },
      }),
    ).toBe(audits);
  });

  it("refuses members, system administrators and a switched-off installation with 404", async () => {
    const password = randomBytes(24).toString("base64url");
    const signedIn = async (name: string) => {
      const email = `${randomUUID()}@example.invalid`;
      const created = await makeAuth().api.signUpEmail({
        body: { email, name, password },
      });
      users.push(created.user.id);
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: `198.18.8.${users.length}` },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers["set-cookie"];
      return {
        id: created.user.id,
        cookie: (Array.isArray(set) ? set : [set])
          .map((v) => v!.split(";")[0])
          .join("; "),
      };
    };
    const member = await signedIn("Synthetic budget member");
    await authDb.workspaceMember.create({
      data: { workspaceId: a.workspaceId, userId: member.id, role: "viewer" },
    });
    const admin = await signedIn("Synthetic budget administrator");
    await authDb.user.update({
      where: { id: admin.id },
      data: { role: "admin" },
    });
    for (const path of ["ai/budget", "ai/usage"])
      for (const who of [member, admin]) {
        const r = await app.inject({
          method: "GET",
          url: `/api/organizations/${a.workspaceId}/${path}`,
          headers: { origin, cookie: who.cookie },
        });
        expect(r.statusCode, `${path}`).toBe(404);
      }
    process.env.ORBIT_CONNECTIONS = "false";
    try {
      const off = await app.inject({
        method: "GET",
        url: `/api/organizations/${a.workspaceId}/ai/budget`,
        headers: { origin, cookie },
      });
      expect(off.statusCode).toBe(404);
    } finally {
      process.env.ORBIT_CONNECTIONS = "true";
    }
  });
});

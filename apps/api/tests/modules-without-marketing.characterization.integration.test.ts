import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  activeSpendMandateRef,
  requireSpendMandate,
} from "../src/platform/ai/spend-mandate.ts";
import {
  actionRequirements,
  createActionRequest,
} from "../src/modules/action-requests.ts";
import {
  registeredActionTypeOwner,
  registeredActionTypes,
  registeredToolOwner,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { enabledModules } from "../src/platform/modules/enforcement.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/**
 * Characterization of a project with Marketing turned off (plan
 * docs/plans/orbit-architecture-cleanup.md, phase 1.10, findings F1, F2 and
 * F7). It pins the behaviour phase 2 changes on purpose, step by step: an
 * owner sets the AI spending authority on the platform (ADR 0015) since
 * 2.3; a Marketing policy saved earlier keeps authorizing paid AI of every
 * module; approval requests outside Marketing need the spend mandate, not
 * the Marketing policy, since 2.5; and without Marketing the dashboard
 * shows the platform's AI readiness since 2.7. Each step flipped its
 * expectation here, deliberately and in the same change.
 */
describe.skipIf(!enabled)("Modules without Marketing (characterization)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${scope.projectId}${url}`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const switchModule = (id: string, on: boolean) =>
    call("PUT", `/modules/${id}`, { enabled: on });
  const policy = () => ({
    mode: "observe",
    channels: [],
    contentTypes: ["social"],
    allowedOrigins: [],
    startAt: new Date(Date.now() - HOUR).toISOString(),
    endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    maxPerDay: 1,
    minIntervalMinutes: 60,
    dailyBudgetMicros: 1_000_000,
    monthlyBudgetMicros: 10_000_000,
    perRunBudgetMicros: 500_000,
    approvedPaidTests: true,
  });

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic owner without marketing", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic modules without marketing",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set])
      .map((v) => v!.split(";")[0])
      .join("; ");
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { name: "Synthetic without marketing", workspaceId: workspace.id },
    });
    expect(project.statusCode).toBe(201);
    scope = {
      workspaceId: workspace.id,
      projectId: project.json().id,
      userId: created.user.id,
      role: "owner",
    };
  });
  afterEach(async () => {
    process.env.ORBIT_SPEND_POLICY_SOURCE = "fallback";
    delete process.env.ORBIT_MARKETING;
    delete process.env.ORBIT_TELEGRAM;
    process.env.ORBIT_MODULES = "true";
    await switchModule("marketing", true);
    delete process.env.ORBIT_MODULES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets an owner set the AI spending authority without Marketing (F1, ADR 0015)", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const saved = await call("POST", "/policies", policy());
    expect(saved.statusCode).toBe(404);
    expect(saved.json().error.code).toBe("MODULE_DISABLED");
    // Without any record every paid AI path stops here.
    await expect(run((tx) => requireSpendMandate(tx, scope))).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
    });
    // The platform's own record works whatever modules are on (phase 2.3).
    const platform = await call("POST", "/actions/ai-spend-policy", { profile: "test" });
    expect(platform.statusCode).toBe(200);
    expect((await run((tx) => requireSpendMandate(tx, scope))).source).toBe("platform");
    // Later tests start without a platform record again.
    await run((tx) =>
      tx.entity.deleteMany({
        where: { projectId: scope.projectId, kind: "ai_spend_policies" },
      }),
    );
  });

  it("no longer authorizes paid AI with a Marketing policy alone (F1, plan 3.8)", async () => {
    process.env.ORBIT_MODULES = "true";
    const saved = await call("POST", "/policies", policy());
    expect(saved.statusCode).toBe(201);
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    // Strict default: the Marketing record authorizes nothing.
    process.env.ORBIT_SPEND_POLICY_SOURCE = "platform";
    await expect(run((tx) => requireSpendMandate(tx, scope))).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
    });
    // The transition mode (first rollback level) still reads it, whatever
    // the module state.
    process.env.ORBIT_SPEND_POLICY_SOURCE = "fallback";
    const mandate = await run((tx) => requireSpendMandate(tx, scope));
    expect(mandate.limits).toMatchObject({
      approvedPaidTests: true,
      dailyBudgetMicros: 1_000_000,
      monthlyBudgetMicros: 10_000_000,
      perRunBudgetMicros: 500_000,
    });
    // ... but nobody can see or change it while Marketing is off.
    expect((await call("GET", "/policies")).statusCode).toBe(404);
  });

  it("reports the platform's AI readiness, not Marketing's, without Marketing (F7, phase 2.7)", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const dashboard = await call("GET", "/dashboard");
    expect(dashboard.statusCode).toBe(200);
    const readiness = dashboard.json().readiness;
    expect(readiness.blockers).not.toContain("PUBLISHER_WRITE_VERIFICATION_REQUIRED");
    expect(readiness.blockers).not.toContain("OWNER_POLICY_REQUIRED");
    expect(readiness.blockers).toContain("VERIFIED_OPENAI_MODELS_REQUIRED");
    // With Marketing on, its go-live readiness is the project's again.
    expect((await switchModule("marketing", true)).statusCode).toBe(200);
    expect((await call("GET", "/dashboard")).json().readiness.blockers).toContain(
      "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
    );
  });

  it("asks other modules' approval requests for the spend mandate, not the Marketing policy (F2, ADR 0015)", () => {
    const needs = new Map<string, Set<string>>();
    for (const [type, definition] of registeredActionTypes()) {
      const owner = registeredActionTypeOwner(type) ?? "unknown";
      for (const need of actionRequirements(type, definition))
        needs.set(owner, new Set([...(needs.get(owner) ?? []), need]));
    }
    // Only Marketing's own types need its publishing policy.
    for (const [owner, set] of needs)
      if (owner !== "marketing")
        expect([...set], owner).not.toContain("publishing_policy");
    for (const owner of ["platform", "support", "finance", "knowledge"])
      expect([...(needs.get(owner) ?? [])], owner).toContain("spend_mandate");
    // Reviewed types that spend nothing need neither (E-5).
    for (const type of [
      "support.mcp.support_update_ticket",
      "knowledge.mcp.knowledge_propose_fact",
      "knowledge.mcp.knowledge_withdraw_fact",
    ])
      expect(actionRequirements(type, registeredActionTypes().get(type)!), type).toEqual([]);
  });

  it("creates a Finance request without Marketing on the platform spending authority (F2)", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const propose = () =>
      run((tx) =>
        createActionRequest(tx, scope, {
          actionType: "finance.mcp.finance_retry_extraction",
          payload: {
            actorId: scope.userId,
            args: {},
            idempotencyKey: randomUUID(),
            ceilingMicros: 0,
          },
          requestedBy: { kind: "user", userId: scope.userId },
        }),
      );
    // An earlier test left a Marketing policy; start without any mandate.
    await run((tx) =>
      tx.entity.deleteMany({ where: { projectId: scope.projectId, kind: "policies" } }),
    );
    await expect(propose()).rejects.toMatchObject({ code: "ACTIVE_POLICY_REQUIRED" });
    expect((await call("POST", "/actions/ai-spend-policy", { profile: "test" })).statusCode).toBe(200);
    const ref = await run((tx) => activeSpendMandateRef(tx, scope));
    const row = await propose();
    expect(row.data).toMatchObject({
      policy: null,
      spendPolicy: { id: ref!.id, version: ref!.version },
    });
    await run((tx) =>
      tx.entity.deleteMany({
        where: {
          projectId: scope.projectId,
          kind: { in: ["ai_spend_policies", "action_requests"] },
        },
      }),
    );
  });
  it("switches Marketing off for the installation with ORBIT_MARKETING=false (E-7)", async () => {
    process.env.ORBIT_MARKETING = "false";
    // Even without per-project enforcement, its routes and collections are gone.
    delete process.env.ORBIT_MODULES;
    for (const url of ["/missions", "/marketing-profile"]) {
      const response = await call("GET", url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.code, url).toBe("MODULE_DISABLED");
    }
    const on = await run((tx) => enabledModules(tx, scope));
    expect(
      registeredTools(on).filter((t) => registeredToolOwner(t.name) === "marketing"),
    ).toEqual([]);
    // The platform's search and the AI spending authority stay.
    expect(registeredTools(on).map((t) => t.name)).toContain("knowledge_search");
    expect((await call("GET", "/ai-spend-policy")).statusCode).toBe(200);
    delete process.env.ORBIT_MARKETING;
    expect((await call("GET", "/missions")).statusCode).toBe(200);
  });

  it("gives the Telegram bot its own switch, independent of Orbit Agents (2.8)", async () => {
    const agents = process.env.ORBIT_AGENTS;
    process.env.ORBIT_AGENTS = "false";
    try {
      expect((await call("GET", "/telegram")).statusCode).toBe(404);
      process.env.ORBIT_TELEGRAM = "true";
      expect((await call("GET", "/telegram")).statusCode).toBe(200);
      process.env.ORBIT_AGENTS = "true";
      process.env.ORBIT_TELEGRAM = "false";
      expect((await call("GET", "/telegram")).statusCode).toBe(404);
    } finally {
      if (agents === undefined) delete process.env.ORBIT_AGENTS;
      else process.env.ORBIT_AGENTS = agents;
    }
  });
});

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
import { reserve } from "../src/platform/ai/budget.ts";
import {
  activeSpendMandateRef,
  requireSpendMandate,
} from "../src/platform/ai/spend-mandate.ts";
import { saveSpendPolicy } from "../src/platform/ai/spend-policy.ts";
import { backfillSpendPolicies } from "../src/platform/ai/spend-policy-backfill.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/**
 * The AI spending authority as a platform record (ADR 0015): it is the
 * mandate when present, the Marketing policy's budget fields apply without
 * it, `reserve` enforces it over the limits a caller passes, only owners
 * write it, it works with Marketing off, and it never touches the Marketing
 * policy.
 */
describe.skipIf(!enabled)("AI spending authority (ADR 0015)", () => {
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
  const marketingPolicy = (overrides: Record<string, unknown> = {}) => ({
    mode: "observe",
    channels: [],
    contentTypes: ["social"],
    allowedOrigins: [],
    startAt: new Date(Date.now() - HOUR).toISOString(),
    endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    maxPerDay: 1,
    minIntervalMinutes: 60,
    dailyBudgetMicros: 3_000_000,
    monthlyBudgetMicros: 30_000_000,
    perRunBudgetMicros: 3_000_000,
    approvedPaidTests: true,
    ...overrides,
  });

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic spend policy owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic spend policy",
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
      payload: { name: "Synthetic spend policy", workspaceId: workspace.id },
    });
    expect(project.statusCode).toBe(201);
    scope = {
      workspaceId: workspace.id,
      projectId: project.json().id,
      userId: created.user.id,
      role: "owner",
    };
  });
  afterEach(() => {
    // The test default (tests/setup.ts); strict tests set "platform".
    process.env.ORBIT_SPEND_POLICY_SOURCE = "fallback";
    delete process.env.ORBIT_MODULES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("backfills the Marketing policy budget once, as a dry run first, without changing the policy", async () => {
    // A second project of the same workspace with only a Marketing policy.
    const other = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { name: "Synthetic backfill", workspaceId: scope.workspaceId },
    });
    expect(other.statusCode).toBe(201);
    const otherScope = { ...scope, projectId: other.json().id as string };
    const posted = await app.inject({
      method: "POST",
      url: `/api/projects/${otherScope.projectId}/policies`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: marketingPolicy({ perRunBudgetMicros: 250_000 }),
    });
    expect(posted.statusCode).toBe(201);
    const policies = () =>
      scoped(otherScope.workspaceId, otherScope.projectId, (tx) =>
        tx.entity.findMany({
          where: { projectId: otherScope.projectId, kind: "policies" },
          select: { id: true, version: true, data: true },
        }),
      );
    const before = await policies();
    const row = (rows: Awaited<ReturnType<typeof backfillSpendPolicies>>) =>
      rows.find((r) => r.projectId === otherScope.projectId);
    const dry = await backfillSpendPolicies({ workspaceId: scope.workspaceId });
    expect(row(dry)).toMatchObject({
      action: "create",
      sourcePolicyId: before[0]!.id,
      limits: { perRunBudgetMicros: 250_000, approvedPaidUse: true },
    });
    expect(
      (await scoped(otherScope.workspaceId, otherScope.projectId, (tx) =>
        requireSpendMandate(tx, otherScope),
      )).source,
    ).toBe("marketing_policy");
    await backfillSpendPolicies({ workspaceId: scope.workspaceId, apply: true });
    const mandate = await scoped(otherScope.workspaceId, otherScope.projectId, (tx) =>
      requireSpendMandate(tx, otherScope),
    );
    expect(mandate).toMatchObject({
      source: "platform",
      limits: { perRunBudgetMicros: 250_000, dailyBudgetMicros: 3_000_000 },
    });
    // Idempotent, and the Marketing policy is untouched.
    expect(row(await backfillSpendPolicies({ workspaceId: scope.workspaceId, apply: true }))?.action).toBe(
      "skip_platform_exists",
    );
    expect(await policies()).toEqual(before);
  });

  it("reads the Marketing policy's budget without a platform record, ignoring its publishing fields", async () => {
    expect((await call("GET", "/ai-spend-policy")).json()).toMatchObject({
      record: null,
      source: "none",
      effective: null,
      active: false,
    });
    expect((await call("POST", "/policies", marketingPolicy())).statusCode).toBe(201);
    // A publishing field that no longer validates does not stop paid AI.
    await run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({
        where: { projectId: scope.projectId, kind: "policies" },
      });
      await tx.entity.update({
        where: { id: row.id },
        data: { data: { ...(row.data as object), channels: "not-a-list" } },
      });
    });
    const mandate = await run((tx) => requireSpendMandate(tx, scope));
    expect(mandate.source).toBe("marketing_policy");
    expect(mandate.limits).toMatchObject({
      approvedPaidTests: true,
      dailyBudgetMicros: 3_000_000,
      perRunBudgetMicros: 3_000_000,
    });
  });

  it("makes the owner's platform record the mandate and leaves the Marketing policy untouched", async () => {
    const before = await run((tx) =>
      tx.entity.findMany({
        where: { projectId: scope.projectId, kind: "policies" },
        select: { id: true, version: true, data: true },
      }),
    );
    const saved = await call("POST", "/actions/ai-spend-policy", { profile: "test" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      profile: "test",
      approvedPaidUse: true,
      dailyBudgetMicros: 1_000_000,
      monthlyBudgetMicros: 10_000_000,
      perRunBudgetMicros: 500_000,
      active: true,
    });
    const view = (await call("GET", "/ai-spend-policy")).json();
    expect(view).toMatchObject({ source: "platform", active: true });
    expect(view.effective.perRunBudgetMicros).toBe(500_000);
    const mandate = await run((tx) => requireSpendMandate(tx, scope));
    expect(mandate).toMatchObject({ source: "platform", id: saved.json().id });
    expect((await run((tx) => activeSpendMandateRef(tx, scope)))?.id).toBe(saved.json().id);
    // No Marketing policy row changed (versions and package hashes stay).
    expect(
      await run((tx) =>
        tx.entity.findMany({
          where: { projectId: scope.projectId, kind: "policies" },
          select: { id: true, version: true, data: true },
        }),
      ),
    ).toEqual(before);
    const auditEvent = await run((tx) =>
      tx.auditEvent.findFirst({
        where: { projectId: scope.projectId, action: "ai_spend_policy.activated" },
      }),
    );
    expect(auditEvent?.resourceId).toBe(saved.json().id);
  });

  it("enforces the platform record in reserve over the limits a caller passes", async () => {
    // The Marketing policy allows 3 USD per run; the platform record 0.50 USD.
    const legacy = marketingPolicy();
    await expect(
      run((tx) => reserve(tx, scope, `spend-test:${randomUUID()}`, "test", 1_000_000, legacy)),
    ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
    const ok = await run((tx) =>
      reserve(tx, scope, `spend-test:${randomUUID()}`, "test", 400_000, legacy),
    );
    expect(ok.id).toBeTruthy();
  });

  it("stops paid AI with the off profile and ignores the platform record on rollback", async () => {
    expect((await call("POST", "/actions/ai-spend-policy", { profile: "off" })).statusCode).toBe(200);
    await expect(
      run((tx) => reserve(tx, scope, `spend-test:${randomUUID()}`, "test", 1, marketingPolicy())),
    ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
    process.env.ORBIT_SPEND_POLICY_SOURCE = "marketing";
    expect((await run((tx) => requireSpendMandate(tx, scope))).source).toBe("marketing_policy");
    const legacy = await run((tx) =>
      reserve(tx, scope, `spend-test:${randomUUID()}`, "test", 1_000_000, marketingPolicy()),
    );
    expect(legacy.id).toBeTruthy();
  });

  it("is written by owners only and works with Marketing turned off", async () => {
    await expect(
      run((tx) => saveSpendPolicy(tx, { ...scope, role: "editor" }, { profile: "normal" })),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    const invalid = await call("POST", "/actions/ai-spend-policy", {
      profile: "custom",
      startAt: new Date(Date.now() + HOUR).toISOString(),
      endAt: new Date().toISOString(),
      approvedPaidUse: true,
      dailyBudgetMicros: 1,
      monthlyBudgetMicros: 1,
      perRunBudgetMicros: 1,
    });
    expect(invalid.statusCode).toBe(400);
    process.env.ORBIT_MODULES = "true";
    expect((await call("PUT", "/modules/marketing", { enabled: false })).statusCode).toBe(200);
    expect((await call("POST", "/policies", marketingPolicy())).statusCode).toBe(404);
    const saved = await call("POST", "/actions/ai-spend-policy", { profile: "normal" });
    expect(saved.statusCode).toBe(200);
    expect((await run((tx) => requireSpendMandate(tx, scope))).limits).toMatchObject({
      dailyBudgetMicros: 5_000_000,
      monthlyBudgetMicros: 50_000_000,
    });
    expect((await call("PUT", "/modules/marketing", { enabled: true })).statusCode).toBe(200);
  });

  it("authorizes paid AI only with the platform record in the strict default (plan 3.8)", async () => {
    // A project with only a Marketing policy: nothing is authorized.
    const other = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { name: "Synthetic strict", workspaceId: scope.workspaceId },
    });
    expect(other.statusCode).toBe(201);
    const strict = { ...scope, projectId: other.json().id as string };
    const inStrict = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
      scoped(strict.workspaceId, strict.projectId, fn);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${strict.projectId}/policies`,
          headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
          payload: marketingPolicy(),
        })
      ).statusCode,
    ).toBe(201);
    process.env.ORBIT_SPEND_POLICY_SOURCE = "platform";
    await expect(inStrict((tx) => requireSpendMandate(tx, strict))).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
    });
    expect(await inStrict((tx) => activeSpendMandateRef(tx, strict))).toBeNull();
    // A Marketing caller passing its own policy budget is refused as well.
    await expect(
      inStrict((tx) =>
        reserve(tx, strict, `spend-test:${randomUUID()}`, "test", 1, marketingPolicy()),
      ),
    ).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    // With the platform record everything runs on it.
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/${strict.projectId}/actions/ai-spend-policy`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { profile: "test" },
    });
    expect(saved.statusCode).toBe(200);
    expect((await inStrict((tx) => requireSpendMandate(tx, strict))).source).toBe("platform");
    const reservation = await inStrict((tx) =>
      reserve(tx, strict, `spend-test:${randomUUID()}`, "test", 100_000, marketingPolicy()),
    );
    expect(reservation.id).toBeTruthy();
  });
});

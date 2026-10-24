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
import { requireSpendMandate } from "../src/platform/ai/spend-mandate.ts";
import {
  registeredActionTypeOwner,
  registeredActionTypes,
} from "../src/platform/modules/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/**
 * Characterization of a project with Marketing turned off (plan
 * docs/plans/orbit-architecture-cleanup.md, phase 1.10, findings F1, F2 and
 * F7). It pins today's behaviour, which phase 2 changes on purpose: the AI
 * spending mandate is the Marketing policy, so without Marketing an owner
 * cannot create one, while an existing one keeps authorizing paid AI of
 * every module; approval requests outside Marketing need it too; and the
 * dashboard readiness stays Marketing's. When phase 2 lands, these
 * expectations flip with it, deliberately and in the same change.
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

  it("gives an owner no way to create the AI spending mandate without Marketing (F1)", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const saved = await call("POST", "/policies", policy());
    expect(saved.statusCode).toBe(404);
    expect(saved.json().error.code).toBe("MODULE_DISABLED");
    // Every paid AI path of the platform and the other modules stops here.
    await expect(run((tx) => requireSpendMandate(tx, scope))).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
    });
  });

  it("keeps authorizing paid AI with a policy saved before Marketing was turned off (F1)", async () => {
    process.env.ORBIT_MODULES = "true";
    const saved = await call("POST", "/policies", policy());
    expect(saved.statusCode).toBe(201);
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    // The platform reads the Marketing record directly, whatever the module state.
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

  it("reports Marketing's readiness on the dashboard of a project without Marketing (F7)", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const dashboard = await call("GET", "/dashboard");
    expect(dashboard.statusCode).toBe(200);
    const readiness = dashboard.json().readiness;
    expect(readiness.blockers).toContain("PUBLISHER_WRITE_VERIFICATION_REQUIRED");
  });

  it("requires the Marketing policy for approval requests of other modules (F2)", () => {
    // Types that need an active policy to be proposed, by owner. Only four
    // types opt out today (configuration, AI models, integrations, policy).
    const needsPolicy = new Set<string>();
    for (const [type, definition] of registeredActionTypes())
      if (definition.policyRequired !== false)
        needsPolicy.add(registeredActionTypeOwner(type) ?? "unknown");
    for (const owner of ["platform", "support", "finance", "knowledge"])
      expect(needsPolicy, owner).toContain(owner);
  });
});

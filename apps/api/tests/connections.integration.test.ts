import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import {
  authDb,
  closeDatabase,
  db,
  scoped,
} from "../../../packages/db/src/index.ts";
import {
  connectionSecret,
  resolveConnection,
} from "../src/platform/connections/central.ts";
import {
  openAiConfigurationVersion,
  runtimeOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import { reserve, settle } from "../src/platform/ai/budget.ts";
import { setAiCheckFetchForTests } from "../src/platform/ai/connection-providers.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

// Central connections, grants, AI profiles and grant budgets (ADR 0013).

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const SECRET = `sk-test-${randomBytes(16).toString("hex")}`;
const policy = {
  startAt: new Date(Date.now() - 3600_000).toISOString(),
  endAt: new Date(Date.now() + 3600_000).toISOString(),
  approvedPaidTests: true,
  dailyBudgetMicros: 1_000_000,
  monthlyBudgetMicros: 1_000_000,
  perRunBudgetMicros: 1_000_000,
};

describe.skipIf(!enabled)("Central connections (ADR 0013)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  const people = {} as Record<"admin" | "ownerA" | "ownerB", { id: string; email: string; cookie: string }>;
  let wsA: string, wsB: string, a1: string, a2: string, b1: string;
  let connectionId: string, orgGrantId: string, projectGrantId: string;
  const scope = (workspaceId: string, projectId: string): Scope => ({
    workspaceId,
    projectId,
    userId: people.ownerA.id,
    role: "owner",
  });
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    who: { cookie: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: who.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    for (const key of ["admin", "ownerA", "ownerB"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const r = await auth.api.signUpEmail({ body: { email, name: `Synthetic ${key}`, password } });
      users.push(r.user.id);
      people[key] = { id: r.user.id, email, cookie: "" };
    }
    await authDb.user.update({ where: { id: people.admin.id }, data: { role: "admin" } });
    const a = await authDb.workspace.create({
      data: {
        name: "Synthetic connections A",
        members: { create: { userId: people.ownerA.id, role: "owner" } },
        projects: { create: [{ name: "A1" }, { name: "A2" }] },
      },
      include: { projects: true },
    });
    const b = await authDb.workspace.create({
      data: {
        name: "Synthetic connections B",
        members: { create: { userId: people.ownerB.id, role: "owner" } },
        projects: { create: [{ name: "B1" }] },
      },
      include: { projects: true },
    });
    workspaces.push(a.id, b.id);
    wsA = a.id;
    wsB = b.id;
    a1 = a.projects.find((p) => p.name === "A1")!.id;
    a2 = a.projects.find((p) => p.name === "A2")!.id;
    b1 = b.projects[0]!.id;
    for (const key of ["admin", "ownerA", "ownerB"] as const) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email: people[key].email, password },
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers["set-cookie"];
      people[key].cookie = (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ");
    }
  });
  afterAll(async () => {
    setAiCheckFetchForTests(null);
    await authDb.connection.deleteMany({ where: { OR: [{ createdBy: { in: users } }] } });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("hides every connection route while the flag is off", async () => {
    process.env.ORBIT_CONNECTIONS = "false";
    try {
      expect((await call("GET", "/api/admin/connections", people.admin)).statusCode).toBe(404);
    } finally {
      process.env.ORBIT_CONNECTIONS = "true";
    }
  });

  it("creates a system connection without ever returning its secret", async () => {
    const r = await call("POST", "/api/admin/connections", people.admin, {
      provider: "openai",
      label: "Central OpenAI",
      secret: SECRET,
    });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain(SECRET);
    connectionId = r.json().id;
    const stored = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId } });
    expect(stored.ciphertext).not.toContain(SECRET);
    expect(r.json()).toMatchObject({ scope: "system", secretVersion: 1, activeGrants: 0 });
    // Owners create organization connections only, never system ones, and
    // project-only providers are refused centrally.
    const own = await call("POST", `/api/organizations/${wsA}/connections`, people.ownerA, {
      provider: "postiz",
      label: "x",
      secret: "secret-value",
    });
    expect(own.json().error.code).toBe("PROVIDER_SCOPE_NOT_ALLOWED");
    expect((await call("GET", "/api/admin/connections", people.ownerA)).statusCode).toBe(404);
  });

  it("grants a system key to an organization only with a budget, then to its projects", async () => {
    const noBudget = await call("POST", `/api/admin/connections/${connectionId}/grants`, people.admin, {
      workspaceId: wsA,
      purposes: ["text"],
    });
    expect(noBudget.json().error.code).toBe("ORGANIZATION_BUDGET_REQUIRED");
    const org = await call("POST", `/api/admin/connections/${connectionId}/grants`, people.admin, {
      workspaceId: wsA,
      purposes: ["text"],
      monthlyBudgetMicros: 1000,
    });
    expect(org.statusCode).toBe(201);
    orgGrantId = org.json().id;
    // Organization B holds no grant: it cannot see or pass it on.
    expect((await call("GET", `/api/organizations/${wsB}/connections`, people.ownerB)).json().items).toEqual([]);
    const foreign = await call("POST", `/api/organizations/${wsB}/connections/${connectionId}/grants`, people.ownerB, {
      projectId: b1,
      purposes: ["text"],
    });
    expect(foreign.json().error.code).toBe("ORGANIZATION_GRANT_REQUIRED");
    const wider = await call("POST", `/api/organizations/${wsA}/connections/${connectionId}/grants`, people.ownerA, {
      projectId: a1,
      purposes: ["image"],
    });
    expect(wider.json().error.code).toBe("PURPOSE_NOT_GRANTED");
    const project = await call("POST", `/api/organizations/${wsA}/connections/${connectionId}/grants`, people.ownerA, {
      projectId: a1,
      purposes: ["text"],
    });
    expect(project.statusCode).toBe(201);
    projectGrantId = project.json().id;
    expect(project.json().parentGrantId).toBe(orgGrantId);
    const listed = (await call("GET", `/api/organizations/${wsA}/connections`, people.ownerA)).json();
    expect(listed.items).toMatchObject([{ id: connectionId, monthlyBudgetMicros: null }]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("lets only the granted project read the connection, enforced by row-level security", async () => {
    const found = await scoped(wsA, a1, (tx) => resolveConnection(tx, { workspaceId: wsA, projectId: a1 }, { provider: "openai", purpose: "text" }));
    expect(found?.grant.id).toBe(projectGrantId);
    expect(await scoped(wsA, a1, (tx) => connectionSecret(tx, connectionId))).toBe(SECRET);
    for (const [ws, project] of [[wsA, a2], [wsB, b1]] as const) {
      expect(await scoped(ws, project, (tx) => resolveConnection(tx, { workspaceId: ws, projectId: project }, { provider: "openai" }))).toBeNull();
      const rows = await scoped(ws, project, (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT (SELECT count(*) FROM "Connection") + (SELECT count(*) FROM "ConnectionSecret") AS n`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
    // Without a project scope the business role sees nothing at all.
    const bare = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Connection"`;
    expect(Number(bare[0]!.n)).toBe(0);
  });

  it("uses the granted key in the project's AI runtime and versions the route with it", async () => {
    const runtime = await scoped(wsA, a1, (tx) => runtimeOpenAiConfiguration(tx, scope(wsA, a1)));
    expect(runtime.apiKey).toBe(SECRET);
    expect(runtime.keySources?.openai).toEqual({ connectionId, grantId: projectGrantId });
    const other = await scoped(wsA, a2, (tx) => runtimeOpenAiConfiguration(tx, scope(wsA, a2)));
    expect(other.apiKey).not.toBe(SECRET);
    const before = await scoped(wsA, a1, (tx) => openAiConfigurationVersion(tx, scope(wsA, a1)));
    const saved = await call("PUT", "/api/admin/ai/profile", people.admin, {
      verifiedModels: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
      modelRoutes: { fast: "gpt-5.6-luna", standard: "gpt-5.6-terra", quality: "gpt-5.6-sol", escalation: "gpt-6-astra" },
    });
    expect(saved.statusCode).toBe(200);
    const after = await scoped(wsA, a1, (tx) => openAiConfigurationVersion(tx, scope(wsA, a1)));
    expect(after).not.toBe(before);
    const merged = await scoped(wsA, a1, (tx) => runtimeOpenAiConfiguration(tx, scope(wsA, a1)));
    expect(merged.verifiedModels).toContain("gpt-5.6-terra");
    expect(merged.routeVersion).toBe(after);
  });

  it("holds the organization budget across projects, also under concurrency", async () => {
    await call("POST", `/api/organizations/${wsA}/connections/${connectionId}/grants`, people.ownerA, {
      projectId: a2,
      purposes: ["text"],
    });
    const attempt = (project: string) =>
      scoped(wsA, project, (tx) =>
        reserve(tx, scope(wsA, project), `grant-test:${randomUUID()}`, "test", 600, policy, new Date(), undefined, { model: "gpt-5.6-terra" }),
      ).then(
        (r) => ({ ok: true as const, id: r.id, project }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
    const results = await Promise.all([attempt(a1), attempt(a2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "ORGANIZATION_BUDGET_EXCEEDED" });
    const won = results.find((r) => r.ok)!;
    const row = await scoped(wsA, won.project!, (tx) => tx.budgetReservation.findFirstOrThrow({ where: { id: won.id } }));
    expect(row).toMatchObject({ connectionId, parentGrantId: orgGrantId });
    await scoped(wsA, won.project!, (tx) => settle(tx, scope(wsA, won.project!), won.id!, 500));
    const counter = await authDb.spendCounter.findFirstOrThrow({ where: { scopeKey: `grant:${orgGrantId}` } });
    expect([counter.reservedMicros, counter.settledMicros]).toEqual([0n, 500n]);
    const usage = await call("GET", `/api/organizations/${wsA}/connections/${connectionId}/usage`, people.ownerA);
    expect(usage.json().grants.some((g: { settledMicros: number }) => g.settledMicros === 500)).toBe(true);
    expect((await call("GET", `/api/organizations/${wsB}/connections/${connectionId}/usage`, people.ownerB)).statusCode).toBe(404);
  });

  it("rotates the secret only after the provider accepts it", async () => {
    setAiCheckFetchForTests(async () => new Response("{}", { status: 401 }));
    const NEXT = `sk-test-${randomBytes(16).toString("hex")}`;
    const refused = await call("POST", `/api/admin/connections/${connectionId}/secret`, people.admin, { secret: NEXT });
    expect(refused.json().error.code).toBe("PROVIDER_KEY_REJECTED");
    setAiCheckFetchForTests(async () => new Response(JSON.stringify({ data: [{}, {}] }), { status: 200 }));
    const rotated = await call("POST", `/api/admin/connections/${connectionId}/secret`, people.admin, { secret: NEXT });
    expect(rotated.json()).toMatchObject({ secretVersion: 2, status: "read_verified" });
    expect(await scoped(wsA, a1, (tx) => connectionSecret(tx, connectionId))).toBe(NEXT);
  });

  it("stops use at once when a connection is disabled or its organization grant revoked", async () => {
    await call("POST", `/api/admin/connections/${connectionId}/disable`, people.admin);
    expect(await scoped(wsA, a1, (tx) => resolveConnection(tx, { workspaceId: wsA, projectId: a1 }, { provider: "openai" }))).toBeNull();
    await call("POST", `/api/admin/connections/${connectionId}/enable`, people.admin);
    expect(await scoped(wsA, a1, (tx) => resolveConnection(tx, { workspaceId: wsA, projectId: a1 }, { provider: "openai" }))).not.toBeNull();
    expect((await call("DELETE", `/api/admin/connections/${connectionId}`, people.admin)).json().error.code).toBe("CONNECTION_IN_USE");
    expect((await call("DELETE", `/api/admin/connection-grants/${orgGrantId}`, people.admin)).statusCode).toBe(204);
    expect(await scoped(wsA, a1, (tx) => resolveConnection(tx, { workspaceId: wsA, projectId: a1 }, { provider: "openai" }))).toBeNull();
    const children = await authDb.connectionGrant.findMany({ where: { parentGrantId: orgGrantId } });
    expect(children.every((g) => g.revokedAt)).toBe(true);
    const audit = await authDb.systemAuditEvent.findMany({ where: { OR: [{ targetId: connectionId }, { metadata: { path: ["connectionId"], equals: connectionId } }] } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["connection.created", "connection.granted", "connection.secret_rotated", "connection.disabled", "connection.grant_revoked"]));
    expect(JSON.stringify(audit)).not.toContain("sk-test-");
  });

  it("keeps an organization's own connection out of the administrators' hands", async () => {
    const own = await call("POST", `/api/organizations/${wsB}/connections`, people.ownerB, {
      provider: "anthropic",
      label: "B's Claude",
      secret: `sk-ant-${randomBytes(12).toString("hex")}`,
    });
    expect(own.statusCode).toBe(201);
    const id = own.json().id;
    // Administrators see it, but cannot rotate it or hand it to anyone.
    expect((await call("GET", "/api/admin/connections?scope=workspace", people.admin)).json().items.some((c: { id: string }) => c.id === id)).toBe(true);
    expect((await call("POST", `/api/admin/connections/${id}/secret`, people.admin, { secret: "new-secret-value" })).statusCode).toBe(404);
    expect((await call("POST", `/api/admin/connections/${id}/grants`, people.admin, { workspaceId: wsA, projectId: a1 })).statusCode).toBe(404);
    // The owner grants it to their own project only.
    expect((await call("POST", `/api/organizations/${wsB}/connections/${id}/grants`, people.ownerB, { projectId: a1 })).statusCode).toBe(404);
    expect((await call("POST", `/api/organizations/${wsB}/connections/${id}/grants`, people.ownerB, { projectId: b1, purposes: ["text"] })).statusCode).toBe(201);
    const runtime = await scoped(wsB, b1, (tx) => runtimeOpenAiConfiguration(tx, { ...scope(wsB, b1), userId: people.ownerB.id }));
    expect(runtime.keySources?.anthropic?.connectionId).toBe(id);
  });
});

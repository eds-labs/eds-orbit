import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ServerModule } from "../../../packages/module-contracts/src/index.ts";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { audit } from "../src/shared.ts";
import { registerModules, registerTestModules } from "../src/modules/registry.ts";
import type { ModuleContributions } from "../src/platform/modules/contributions.ts";
import { createApiKey } from "../src/platform/api-keys/keys.ts";
import { idempotencyCleanup, idempotent, inV1, page, pageParams, sendCached, V1_LIMITS, v1RateLimit } from "../src/platform/http/v1.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// A test-only module with two key scopes and three v1 routes: a cacheable
// list, an idempotent write (one audit row per real write) and a
// management route with the low per-key limit.
const probeModule: ServerModule = {
  id: "probe",
  version: "0.1.0",
  displayName: { en: "Probe", de: "Probe" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [],
  tables: [],
  permissions: [],
};
const ITEMS = Array.from({ length: 5 }, (_, index) => ({ n: index + 1 }));
const probeContributions: ModuleContributions = {
  apiScopes: [
    { key: "probe:read", access: "read", description: { en: "Read", de: "Lesen" } },
    { key: "probe:write", access: "write", description: { en: "Write", de: "Schreiben" } },
  ],
  routes: ({ app }) => {
    app.get("/api/v1/probe/items", { config: v1RateLimit("delivery") }, async (req, reply) => {
      const result = await inV1(req, "probe:read", async () => {
        const { limit, after } = pageParams(req.query, 2);
        const start = typeof after?.n === "number" ? after.n : 0;
        const rows = ITEMS.filter((item) => item.n > start).slice(0, limit + 1);
        return page(rows, limit, (row) => row, (row) => ({ n: row.n }));
      });
      return sendCached(req, reply, result);
    });
    app.post("/api/v1/probe/notes", { config: v1RateLimit("management") }, async (req, reply) =>
      inV1(req, "probe:write", (tx, principal) =>
        idempotent(tx, principal, req, reply, async () => {
          const row = await audit(tx, principal.scope, "probe.note", randomUUID(), {});
          return { status: 201, body: { id: row.resourceId } };
        }),
      ),
    );
  },
};
registerTestModules([{ module: probeModule, contributions: probeContributions }]);
registerModules();

describe.skipIf(!enabled)("/api/v1 frame (CH1.2)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let ownerId = "";
  let readToken = "";
  let writeToken = "";
  const ip = () => `198.19.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (method: "GET" | "POST", url: string, token: string, headers: Record<string, string> = {}, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: ip(), ...headers },
      ...(payload ? { payload } : {}),
    });
  const notes = () =>
    scoped(workspaceId, projectId, (tx) => tx.auditEvent.count({ where: { projectId, action: "probe.note" } }));

  beforeAll(async () => {
    process.env.ORBIT_API_V1 = "true";
    app = await buildServer();
    const created = await makeAuth().api.signUpEmail({
      body: { email: `${randomUUID()}@example.invalid`, name: "Synthetic v1 owner", password: randomBytes(24).toString("base64url") },
    });
    ownerId = created.user.id;
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic v1", members: { create: [{ userId: ownerId, role: "owner" }] } },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic v1" } })).id;
    const scope = { workspaceId, projectId, userId: ownerId, role: "owner" as const };
    readToken = (await createApiKey(scope, { name: "read", scopes: ["probe:read"] })).token;
    writeToken = (await createApiKey(scope, { name: "write", scopes: ["probe:write"], confirmWrite: true })).token;
  });
  beforeEach(() => {
    process.env.ORBIT_API_V1 = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_API_V1;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: ownerId } });
    await app?.close();
    await closeDatabase();
  });

  it("pages with opaque cursors, caches with ETag and answers 304", async () => {
    const first = await call("GET", "/api/v1/probe/items", readToken);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ items: [{ n: 1 }, { n: 2 }] });
    expect(first.headers["cache-control"]).toContain("max-age=60");
    expect(first.headers["cache-control"]).toContain("stale-if-error");
    expect(first.headers["x-request-id"]).toBeTruthy();
    const etag = String(first.headers.etag);
    const again = await call("GET", "/api/v1/probe/items", readToken, { "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const next = await call("GET", `/api/v1/probe/items?cursor=${first.json().nextCursor}`, readToken);
    expect(next.json().items).toEqual([{ n: 3 }, { n: 4 }]);
    const last = await call("GET", `/api/v1/probe/items?cursor=${next.json().nextCursor}`, readToken);
    expect(last.json()).toEqual({ items: [{ n: 5 }], nextCursor: null });
    const bad = await call("GET", "/api/v1/probe/items?cursor=%%%", readToken);
    expect(bad.json().error.code).toBe("CURSOR_INVALID");
    expect((await call("GET", "/api/v1/probe/items?limit=3", readToken)).statusCode).toBe(400);
  });

  it("checks the scope of the key", async () => {
    const response = await call("GET", "/api/v1/probe/items", writeToken);
    expect([response.statusCode, response.json().error.code]).toEqual([403, "API_KEY_SCOPE_MISSING"]);
    const write = await call("POST", "/api/v1/probe/notes", readToken, {}, {});
    expect(write.statusCode).toBe(403);
  });

  it("writes once per Idempotency-Key and refuses a reused key for another request", async () => {
    const before = await notes();
    const key = `idem-${randomUUID()}`;
    const first = await call("POST", "/api/v1/probe/notes", writeToken, { "idempotency-key": key }, { text: "a" });
    expect(first.statusCode).toBe(201);
    const replay = await call("POST", "/api/v1/probe/notes", writeToken, { "idempotency-key": key }, { text: "a" });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
    expect(await notes()).toBe(before + 1);
    const reused = await call("POST", "/api/v1/probe/notes", writeToken, { "idempotency-key": key }, { text: "b" });
    expect([reused.statusCode, reused.json().error.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    const invalid = await call("POST", "/api/v1/probe/notes", writeToken, { "idempotency-key": "x" }, {});
    expect(invalid.json().error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    // Without the header every request writes.
    await call("POST", "/api/v1/probe/notes", writeToken, {}, {});
    await call("POST", "/api/v1/probe/notes", writeToken, {}, {});
    expect(await notes()).toBe(before + 3);
  });

  it("removes expired stored answers in the hourly cleanup", async () => {
    const remaining = () => scoped(workspaceId, projectId, (tx) => tx.apiIdempotencyKey.count({ where: { projectId } }));
    const key = await authDb.apiKey.findFirstOrThrow({ where: { projectId, name: "write" } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.apiIdempotencyKey.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId,
          apiKeyId: key.id,
          key: `old-${randomUUID()}`,
          requestHash: "e".repeat(64),
          responseStatus: 201,
          responseBody: {},
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          expiresAt: new Date(Date.now() - 2 * 86_400_000),
        },
      }),
    );
    const total = await remaining();
    await idempotencyCleanup.run({ workspaceId, projectId, userId: "system", role: "owner" });
    expect(await remaining()).toBe(total - 1);
  });

  it("limits requests per address before and per key after authentication", async () => {
    expect(V1_LIMITS.management).toBe(120);
    const limited = v1RateLimit("management").rateLimit;
    const keyed = (authorization?: string) =>
      limited.keyGenerator({ headers: authorization ? { authorization } : {}, ip: "203.0.113.1", socket: {} } as never);
    // The route bucket never follows a (possibly forged) key prefix.
    expect(keyed(`Bearer ${writeToken}`)).toMatch(/^v1:management:ip:/);
    expect(keyed(`Bearer ${writeToken}`)).toBe(keyed());
    // A forged key with the real key's prefix fails without spending the key's quota.
    const forged = `${writeToken.slice(0, 16)}${"A".repeat(writeToken.length - 16)}`;
    for (let i = 0; i < 3; i++) {
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/probe/notes",
        headers: { authorization: `Bearer ${forged}` },
        payload: {},
      });
      expect(refused.statusCode).toBe(401);
    }
    const real = await app.inject({
      method: "POST",
      url: "/api/v1/probe/notes",
      headers: { authorization: `Bearer ${writeToken}` },
      payload: {},
    });
    expect(real.statusCode).toBe(201);
  });
});

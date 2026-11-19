import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { API_TOKEN, newToken } from "../src/platform/api-keys/keys.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Project API keys (ADR 0029, CH1.1): owners create, list and revoke keys
 * while ORBIT_API_V1 is on; a key is shown once, stored as a hash, carries
 * only scopes of available modules and authenticates /api/v1 alone (no
 * session cookie, no origin). Every failure is the same 401.
 */
describe.skipIf(!enabled)("project API keys", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "" };
  const cookies = { owner: "", editor: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const manage = (who: keyof typeof ids, method: "GET" | "POST", path = "", payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/api-keys${path}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const v1 = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/v1/key", headers: { [CLIENT_IP_HEADER]: ip(), ...headers } });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const create = (payload: object) => manage("owner", "POST", "", payload);

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic keys ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic keys",
        members: { create: [{ userId: ids.owner, role: "owner" }, { userId: ids.editor, role: "viewer" }] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic keys" } })).id;
    await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids.editor, role: "editor" } });
    for (const who of ["owner", "editor"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_API_V1 = "true";
    process.env.ORBIT_CMS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_API_V1;
    delete process.env.ORBIT_CMS;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("does not exist while ORBIT_API_V1 is off", async () => {
    delete process.env.ORBIT_API_V1;
    expect((await manage("owner", "GET")).statusCode).toBe(404);
    expect((await create({ name: "x", scopes: ["cms:delivery.read"] })).statusCode).toBe(404);
    expect((await v1({ authorization: `Bearer ${newToken().token}` })).statusCode).toBe(404);
  });

  it("lets only the owner manage keys and lists the grantable scopes", async () => {
    const editor = await manage("editor", "GET");
    expect(editor.statusCode).toBe(403);
    const list = await manage("owner", "GET");
    expect(list.statusCode).toBe(200);
    expect(list.json().scopes.map((s: { key: string }) => s.key)).toEqual(
      expect.arrayContaining(["cms:delivery.read", "cms:manage.write"]),
    );
    const refused = await manage("editor", "POST", "", { name: "x", scopes: ["cms:delivery.read"] });
    expect(refused.statusCode).toBe(403);
  });

  it("creates a key shown once, stores only its hash and authenticates /api/v1 without a session", async () => {
    const response = await create({ name: "FamilyPlan website", scopes: ["cms:delivery.read"], expiresInDays: 30 });
    expect(response.statusCode).toBe(201);
    const key = response.json();
    expect(key.token).toMatch(API_TOKEN);
    expect(key).toMatchObject({ name: "FamilyPlan website", scopes: ["cms:delivery.read"], status: "active" });
    const row = await authDb.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.secretHash).toBe(createHash("sha256").update(key.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(key.token.slice(16));
    const listed = (await manage("owner", "GET")).json().items.find((item: { id: string }) => item.id === key.id);
    expect(listed.token).toBeUndefined();
    expect(listed.secretHash).toBeUndefined();

    // No Origin header, no cookie: the key alone authenticates.
    const me = await v1({ authorization: `Bearer ${key.token}` });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ prefix: key.prefix, projectId, scopes: ["cms:delivery.read"], resourceFilter: {} });
    expect((await authDb.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt).not.toBeNull();
    const audits = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({ where: { resourceId: key.id, action: "api_key.created" } }),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(key.token.slice(16));
  });

  it("refuses a key whose stored filter this version cannot read, instead of widening it", async () => {
    // Keys are immutable after creation; a row as a newer version might have written it.
    const { prefix, token, secretHash } = newToken();
    await authDb.apiKey.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        name: "odd filter",
        prefix,
        secretHash,
        scopes: ["cms:delivery.read"],
        resourceFilter: { siteIds: "not-a-list", future: true },
        createdBy: ids.owner,
      },
    });
    const refused = await v1({ authorization: `Bearer ${token}` });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe("API_KEY_INVALID");
  });

  it("answers the same 401 for every bad credential, and ignores session cookies", async () => {
    const key = (await create({ name: "probe", scopes: ["cms:delivery.read"] })).json();
    const wrongSecret = `${key.prefix}_${randomBytes(32).toString("base64url")}`;
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer nonsense" },
      { authorization: `Bearer ${newToken().token}` },
      { authorization: `Bearer ${wrongSecret}` },
      { authorization: `Basic ${key.token}` },
      { cookie: cookies.owner, origin },
    ];
    for (const headers of attempts) {
      const response = await v1(headers);
      expect([response.statusCode, code(response)], JSON.stringify(Object.keys(headers))).toEqual([401, "API_KEY_INVALID"]);
    }
  });

  it("refuses unknown scopes, scopes of unavailable modules and unconfirmed write scopes", async () => {
    const unknown = await create({ name: "x", scopes: ["cms:everything"] });
    expect([unknown.statusCode, code(unknown)]).toEqual([400, "API_KEY_SCOPE_UNKNOWN"]);
    const write = await create({ name: "x", scopes: ["cms:manage.write"] });
    expect([write.statusCode, code(write)]).toEqual([409, "API_KEY_WRITE_CONFIRMATION_REQUIRED"]);
    const confirmed = await create({ name: "x", scopes: ["cms:manage.write"], confirmWrite: true });
    expect(confirmed.statusCode).toBe(201);
    delete process.env.ORBIT_CMS;
    const off = await create({ name: "x", scopes: ["cms:delivery.read"] });
    expect([off.statusCode, code(off)]).toEqual([400, "API_KEY_SCOPE_UNKNOWN"]);
  });

  it("revokes at once and keeps a revoked or expired key out", async () => {
    const key = (await create({ name: "to revoke", scopes: ["cms:delivery.read"] })).json();
    expect((await v1({ authorization: `Bearer ${key.token}` })).statusCode).toBe(200);
    const editor = await manage("editor", "POST", `/${key.id}/revoke`);
    expect(editor.statusCode).toBe(403);
    const revoked = await manage("owner", "POST", `/${key.id}/revoke`);
    expect(revoked.json().status).toBe("revoked");
    expect((await v1({ authorization: `Bearer ${key.token}` })).statusCode).toBe(401);
    const again = await manage("owner", "POST", `/${key.id}/revoke`);
    expect(again.json().revokedAt).toBe(revoked.json().revokedAt);

    const expired = newToken();
    await authDb.apiKey.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        name: "expired",
        prefix: expired.prefix,
        secretHash: expired.secretHash,
        scopes: ["cms:delivery.read"],
        createdBy: ids.owner,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    expect((await v1({ authorization: `Bearer ${expired.token}` })).statusCode).toBe(401);
  });

  it("never lets a stored key change its scopes, filter, expiry or secret", async () => {
    const key = (await create({ name: "fixed", scopes: ["cms:delivery.read"] })).json();
    for (const data of [
      { scopes: ["cms:manage.write"] },
      { resourceFilter: { siteIds: [randomUUID()] } },
      { expiresAt: null },
      { secretHash: "0".repeat(64) },
    ]) {
      await expect(authDb.apiKey.update({ where: { id: key.id }, data }), JSON.stringify(data)).rejects.toThrow(
        /API_KEY_IMMUTABLE/,
      );
    }
    await manage("owner", "POST", `/${key.id}/revoke`);
    await expect(authDb.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })).rejects.toThrow(
      /API_KEY_IMMUTABLE/,
    );
  });
});

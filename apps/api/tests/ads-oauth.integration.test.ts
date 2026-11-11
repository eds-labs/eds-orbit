import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { unlinkAdAccount } from "../src/modules/ads/accounts/accounts.ts";
import { beginAdsOAuthState, consumeAdsOAuthState, projectOfAdsState } from "../src/modules/ads/accounts/oauth-state.ts";
import { claimExclusiveConfigValue } from "../src/platform/connections/project-secrets.ts";
import { openSecret } from "../src/platform/connections/secrets.ts";
import { ADS_META_APP, createAdsProject, expectNoSecret, fakeToken, grantAdsMetaApp, type AdsProject } from "./support/ads-fixtures.ts";
import { setMetaAdsFetchForTests } from "../src/modules/ads/providers/meta/transport.ts";
import { createFakeMetaGraph, graphError } from "./support/fake-meta-graph.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
// One fake Graph for the whole file (the state of the flow spans tests); misses are asserted at the end.
const fake = createFakeMetaGraph();
const CODE = "authorization-code-ads-0001";

/**
 * Connecting Meta (ADR 0025, A3 Task 4): only the owner starts a flow, the
 * callback needs the same signed-in owner, the state is used once before any
 * exchange, and no token, code or app secret leaves the sealed secret.
 */
describe.skipIf(!enabled)("ads OAuth connect and callback", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: AdsProject;
  const cleanups: Array<() => Promise<unknown>> = [];
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const outputs: unknown[] = [];
  const tokens: string[] = [];
  const projects: AdsProject[] = [];
  /** Every project the file creates is scanned for leaks at the end. */
  const track = async (options: Parameters<typeof createAdsProject>[0]) => {
    const project = await createAdsProject(options);
    projects.push(project);
    return project;
  };
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");

  const callback = async (cookie: string | null, query: string) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/ads/oauth/callback/meta?${query}`,
      headers: { origin, ...(cookie ? { cookie } : {}), [CLIENT_IP_HEADER]: ip() },
    });
    outputs.push(response.body, response.headers.location);
    return response;
  };
  const start = async (project: AdsProject = p, who: "owner" | "editor" | "viewer" = "owner") => {
    const response = await project.call(who, "POST", "/ads/connections/meta/connect");
    outputs.push(response.body);
    return {
      response,
      state: response.statusCode === 200 ? new URL(response.json().authorizeUrl).searchParams.get("state")! : "",
    };
  };
  const finish = async (cookie: string, state: string, extra = "") => {
    const response = await callback(cookie, `code=${CODE}&state=${encodeURIComponent(state)}${extra}`);
    outputs.push(response.body, response.headers.location);
    return response;
  };
  /** Routes the code exchange and the identity reads for one Meta user and token. */
  const routeMeta = (token: string, metaUser = "u-1", scopes = ["ads_read", "ads_management"]) => {
    tokens.push(token);
    fake.on("POST", "/oauth/access_token", { json: { access_token: token, token_type: "bearer", expires_in: 5183944 } });
    fake.on("GET", "/me", { json: { id: metaUser, name: "Synthetic Meta User" } });
    fake.on("GET", "/me/permissions", { json: { data: scopes.map((permission) => ({ permission, status: "granted" })) } });
  };
  const connections = (project: AdsProject = p) =>
    authDb.connection.findMany({ where: { projectId: project.projectId, provider: "ads.account.meta", revokedAt: null } });
  const secretOf = async (connectionId: string) => {
    const row = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId, state: "active" } });
    return { version: row.version, value: JSON.parse(openSecret(row)) as Record<string, unknown> };
  };
  const adAccount = (project: AdsProject, connectionId: string, n: number) =>
    project.run(async (tx) => {
      const account = await tx.adAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          provider: "meta",
          externalId: `act_${n}`,
          name: `Account ${n}`,
          currency: "EUR",
          timezone: "Europe/Berlin",
          connectionId,
          status: "reconnect_required",
          createdBy: project.ids.owner,
        },
      });
      await tx.adSyncState.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          accountId: account.id,
          stream: "health",
          nextRunAt: new Date(Date.now() + 86_400_000),
        },
      });
      return account;
    });

  beforeAll(async () => {
    setMetaAdsFetchForTests(fake.fetch);
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_ADS = "true";
    app = await buildServer();
    p = await track({ app });
    const granted = await grantAdsMetaApp(p);
    cleanups.push(granted.cleanup, () => p.cleanup());
  });
  afterEach(() => {
    process.env.ORBIT_ADS = "true";
  });
  afterAll(async () => {
    setMetaAdsFetchForTests(null);
    expect(fake.misses).toEqual([]);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    for (const cleanup of cleanups.reverse()) await cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("refuses to begin without the app grant (409)", async () => {
    const bare = await track({ app });
    cleanups.push(() => bare.cleanup());
    const { response } = await start(bare);
    expect([response.statusCode, response.json().error?.code]).toEqual([409, "ADS_META_APP_NOT_GRANTED"]);
  });

  it("lets only the owner begin; editors and viewers get 403, a disabled module 404", async () => {
    expect((await start(p, "editor")).response.statusCode).toBe(403);
    expect((await start(p, "viewer")).response.statusCode).toBe(403);
    const off = await track({ app, enabled: false });
    cleanups.push(() => off.cleanup());
    const response = await off.call("owner", "POST", "/ads/connections/meta/connect");
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "ADS_DISABLED"]);
  });

  it("stores one hashed state for the owner and puts no secret into the authorize URL", async () => {
    const before = await p.run((tx) => tx.adOAuthState.count());
    const { response, state } = await start();
    expect(response.statusCode).toBe(200);
    const url = new URL(response.json().authorizeUrl);
    expect(url.searchParams.get("config_id")).toBe(ADS_META_APP.configId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${new URL(origin).origin}/api/ads/oauth/callback/meta`);
    expectNoSecret(response.body, [ADS_META_APP.appSecret]);
    expect(state.startsWith(`${p.projectId}.`)).toBe(true);
    expect(await p.run((tx) => tx.adOAuthState.count())).toBe(before + 1);
    const row = await p.run((tx) => tx.adOAuthState.findUniqueOrThrow({ where: { stateHash: sha(state) } }));
    expect(row).toMatchObject({ userId: p.ids.owner, provider: "meta", verifierCiphertext: null, redirectAfter: `/p/${p.projectId}/ads/accounts` });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * 60_000);
  });

  it("refuses redirect targets outside the project's ads accounts", async () => {
    const attempt = (redirectAfter: string) =>
      p.run((tx) => beginAdsOAuthState(tx, p.owner, { provider: "meta", appConnectionId: randomUUID(), redirectAfter }));
    for (const bad of [`/p/${randomUUID()}/ads/accounts`, `/p/${p.projectId}/social`, "https://evil.example/", `/p/${p.projectId}/ads/accountsx`])
      await expect(attempt(bad)).rejects.toMatchObject({ code: "ADS_REDIRECT_INVALID", status: 400 });
    await expect(attempt(`/p/${p.projectId}/ads/accounts?x=1`)).resolves.toBeDefined();
    await expect(attempt(`/p/${p.projectId}/ads/accounts/new`)).resolves.toBeDefined();
  });

  it("reads the project from the state and refuses malformed states", () => {
    expect(projectOfAdsState(`${p.projectId}.abc`)).toBe(p.projectId);
    expect(() => projectOfAdsState("nope.abc")).toThrow(expect.objectContaining({ code: "ADS_OAUTH_STATE_INVALID", status: 400 }));
    expect(() => projectOfAdsState(`${p.projectId}.${"a".repeat(200)}`)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("consumes a state once, and not after ten minutes or for another member or provider", async () => {
    const now = new Date();
    const fresh = () => p.run((tx) => beginAdsOAuthState(tx, p.owner, { provider: "meta", appConnectionId: randomUUID(), redirectAfter: `/p/${p.projectId}/ads/accounts` }, now));
    const use = (state: string, scope = p.owner, at = now) =>
      p.run((tx) => consumeAdsOAuthState(tx, scope, { state, provider: "meta" }, at));
    const a = await fresh();
    await expect(use(a.state)).resolves.toMatchObject({ redirectAfter: `/p/${p.projectId}/ads/accounts` });
    await expect(use(a.state)).rejects.toMatchObject({ code: "ADS_OAUTH_STATE_INVALID", status: 403 });
    const b = await fresh();
    await expect(use(b.state, p.owner, new Date(now.getTime() + 11 * 60_000))).rejects.toMatchObject({ code: "ADS_OAUTH_STATE_INVALID" });
    await expect(use(b.state, { ...p.owner, userId: p.ids.editor })).rejects.toMatchObject({ code: "ADS_OAUTH_STATE_INVALID" });
    const c = await fresh();
    await expect(p.run((tx) => consumeAdsOAuthState(tx, p.owner, { state: c.state, provider: "google" as "meta" }, now))).rejects.toMatchObject({ code: "ADS_OAUTH_STATE_INVALID" });
  });

  it("answers the callback without a state with 400 for everybody", async () => {
    expect((await callback(null, `code=${CODE}`)).statusCode).toBe(400);
    expect((await callback(p.cookies.owner, `code=${CODE}`)).statusCode).toBe(400);
    expect((await callback(p.cookies.owner, "state=not-a-state-but-long-enough-to-pass-length-0001")).statusCode).toBe(400);
  });

  it("needs the signed-in owner who started the flow, and makes no provider call otherwise", async () => {
    routeMeta(fakeToken("neg"));
    const requestsBefore = fake.requests.length;
    const { state } = await start();
    const q = `code=${CODE}&state=${encodeURIComponent(state)}`;
    expect((await callback(null, q)).statusCode).toBe(401);
    expect((await callback(p.cookies.editor, q)).statusCode).toBe(403);
    const other = await track({ app });
    cleanups.push(() => other.cleanup());
    expect([403, 404]).toContain((await callback(other.cookies.owner, q)).statusCode);
    // A second owner of the same project did not start the flow.
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({ body: { email, name: "Synthetic second owner", password } });
    users.push(created.user.id);
    await authDb.workspaceMember.create({ data: { workspaceId: p.workspaceId, userId: created.user.id, role: "owner" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: { email, password } });
    const set = login.headers["set-cookie"];
    const cookie = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    const second = await callback(cookie, q);
    expect([second.statusCode, second.headers.location]).toEqual([302, `/p/${p.projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`]);
    expect(fake.requests).toHaveLength(requestsBefore);
    // The failed attempts did not use the state: the real owner still can.
    const done = await finish(p.cookies.owner, state);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toMatch(/\?connection=/);
  });

  it("refuses a reused state and an expired one without a provider call", async () => {
    const { state } = await start();
    await p.run((tx) => tx.adOAuthState.update({ where: { stateHash: sha(state) }, data: { usedAt: new Date() } }));
    const before = fake.requests.length;
    const reused = await finish(p.cookies.owner, state);
    expect(reused.headers.location).toBe(`/p/${p.projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`);
    const expired = await start();
    await p.run((tx) => tx.adOAuthState.update({ where: { stateHash: sha(expired.state) }, data: { createdAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 1000) } }));
    const late = await finish(p.cookies.owner, expired.state);
    expect(late.headers.location).toBe(`/p/${p.projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`);
    expect(fake.requests.length).toBe(before);
  });

  it("treats a cancelled login as cancelled, uses the state and makes no exchange", async () => {
    const { state } = await start();
    const before = fake.requests.length;
    const cancelled = await callback(p.cookies.owner, `error=access_denied&state=${encodeURIComponent(state)}`);
    expect([cancelled.statusCode, cancelled.headers.location]).toEqual([302, `/p/${p.projectId}/ads/accounts?error=ADS_OAUTH_CANCELLED`]);
    expect(fake.requests.length).toBe(before);
    const again = await finish(p.cookies.owner, state);
    expect(again.headers.location).toBe(`/p/${p.projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`);
  });

  it("answers 404 ADS_DISABLED while ORBIT_ADS is off and leaves the state alone", async () => {
    const { state } = await start();
    delete process.env.ORBIT_ADS;
    const response = await callback(p.cookies.owner, `code=${CODE}&state=${encodeURIComponent(state)}`);
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "ADS_DISABLED"]);
    process.env.ORBIT_ADS = "true";
    expect(await p.run((tx) => tx.adOAuthState.findUniqueOrThrow({ where: { stateHash: sha(state) } }))).toMatchObject({ usedAt: null });
  });

  it("redirects a failed exchange with its code only and does not leave the state usable", async () => {
    const q = await track({ app });
    cleanups.push(() => q.cleanup());
    cleanups.push((await grantAdsMetaApp(q)).cleanup);
    fake.on("POST", "/oauth/access_token", graphError(400, 100));
    const { state } = await start(q);
    const failed = await finish(q.cookies.owner, state);
    expect(failed.statusCode).toBe(302);
    expect(failed.headers.location).toMatch(new RegExp(`^/p/${q.projectId}/ads/accounts\\?error=ADS_[A-Z0-9_]+$`));
    expect(await connections(q)).toHaveLength(0);
    const retry = await finish(q.cookies.owner, state);
    expect(retry.headers.location).toBe(`/p/${q.projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`);
  });

  it("connects: one sealed connection with the token and non-secret facts", async () => {
    const q = await track({ app });
    cleanups.push(() => q.cleanup());
    cleanups.push((await grantAdsMetaApp(q)).cleanup);
    const token = fakeToken("first");
    routeMeta(token);
    const { state } = await start(q);
    const done = await finish(q.cookies.owner, state);
    const [connection] = await connections(q);
    expect(await connections(q)).toHaveLength(1);
    expect(done.headers.location).toBe(`/p/${q.projectId}/ads/accounts?connection=${connection!.id}`);
    const secret = await secretOf(connection!.id);
    expect(secret.value).toMatchObject({ accessToken: token, tokenType: "user" });
    expect(connection!.config).toMatchObject({
      metaUserId: "u-1",
      tokenType: "user",
      assignedAdAccounts: [],
      grantedScopes: ["ads_management", "ads_read"],
    });
    expect(typeof (connection!.config as { tokenExpiresAt: unknown }).tokenExpiresAt).toBe("string");
    expect(connection!.label).toBe("Meta: Synthetic Meta User");
    const audit = await q.run((tx) => tx.auditEvent.findMany({ where: { action: "ads.account.connected" } }));
    expect(audit.map((a) => a.metadata)).toEqual([{ connectionId: connection!.id, reconnect: false, tokenType: "user" }]);
  });

  it("reconnects: rotates the secret, restores readable accounts, keeps refused ones waiting", async () => {
    const q = await track({ app });
    cleanups.push(() => q.cleanup());
    cleanups.push((await grantAdsMetaApp(q)).cleanup);
    const first = fakeToken("one");
    routeMeta(first);
    const done1 = await finish(q.cookies.owner, (await start(q)).state);
    const connectionId = new URL(done1.headers.location as string, origin).searchParams.get("connection")!;
    const acts = [await adAccount(q, connectionId, 1), await adAccount(q, connectionId, 2), await adAccount(q, connectionId, 3)];
    for (const n of [1, 2, 3]) await claimExclusiveConfigValue(q.owner, { moduleId: "ads", connectionId, key: "assignedAdAccounts", value: `act_${n}` });
    // Verified writing survives a reconnect that can still write.
    await q.run((tx) => tx.adAccount.update({ where: { id: acts[0]!.id }, data: { capability: "write_verified", writesEnabled: true } }));
    const second = fakeToken("two");
    routeMeta(second);
    const account = (n: number) => ({ id: `act_${n}`, account_id: String(n), name: `Account ${n}`, currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1 });
    fake.on("GET", "/act_1", { json: account(1) });
    fake.on("GET", "/act_2", graphError(403, 200));
    fake.on("GET", "/act_3", { status: 500, json: {} });
    const done2 = await finish(q.cookies.owner, (await start(q)).state);
    expect(done2.headers.location).toBe(`/p/${q.projectId}/ads/accounts?connection=${connectionId}`);
    expect(await connections(q)).toHaveLength(1);
    const secret = await secretOf(connectionId);
    expect([secret.version, secret.value.accessToken]).toEqual([2, second]);
    const [connection] = await connections(q);
    expect((connection!.config as { assignedAdAccounts: string[] }).assignedAdAccounts).toEqual(["act_1", "act_2", "act_3"]);
    const rows = await q.run(async (tx) => ({
      accounts: await tx.adAccount.findMany({ orderBy: { externalId: "asc" } }),
      health: await tx.adSyncState.findMany({ where: { stream: "health" } }),
      audit: await tx.auditEvent.findMany({ where: { action: "ads.account.restored" } }),
    }));
    expect(rows.accounts.map((a) => [a.externalId, a.status])).toEqual([["act_1", "active"], ["act_2", "reconnect_required"], ["act_3", "reconnect_required"]]);
    expect(rows.accounts[0]).toMatchObject({ capability: "write_verified", writesEnabled: true, providerStatus: "ACTIVE" });
    const health = (id: string) => rows.health.find((h) => h.accountId === id)!;
    expect(health(acts[1]!.id).lastErrorCode).toBe("ADS_META_ACCOUNT_NOT_GRANTED");
    expect(health(acts[1]!.id).nextRunAt.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
    expect(health(acts[2]!.id).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(health(acts[0]!.id).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows.audit.map((a) => a.resourceId)).toEqual([acts[0]!.id]);
    const connected = await q.run((tx) => tx.auditEvent.findMany({ where: { action: "ads.account.connected" }, orderBy: { createdAt: "asc" } }));
    expect(connected.map((a) => (a.metadata as { reconnect: boolean }).reconnect)).toEqual([false, true]);
    outputs.push(rows.accounts, rows.health);
  });

  it("restores only rows still waiting: an unlink during the re-read wins, status and capability follow the read", async () => {
    const q = await track({ app });
    cleanups.push(() => q.cleanup());
    cleanups.push((await grantAdsMetaApp(q)).cleanup);
    routeMeta(fakeToken("race-one"));
    const done1 = await finish(q.cookies.owner, (await start(q)).state);
    const connectionId = new URL(done1.headers.location as string, origin).searchParams.get("connection")!;
    const [gone, off, kept] = [await adAccount(q, connectionId, 11), await adAccount(q, connectionId, 12), await adAccount(q, connectionId, 13)];
    for (const n of [11, 12, 13]) await claimExclusiveConfigValue(q.owner, { moduleId: "ads", connectionId, key: "assignedAdAccounts", value: `act_${n}` });
    await q.run((tx) => tx.adAccount.updateMany({ data: { capability: "write_verified", writesEnabled: true } }));
    // The new grant lacks ads_management: nothing can be written any more.
    routeMeta(fakeToken("race-two"), "u-1", ["ads_read"]);
    const account = (n: number, over: object = {}) => ({ id: `act_${n}`, account_id: String(n), name: `Account ${n}`, currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1, ...over });
    fake.on("GET", "/act_11", async () => {
      // The owner unlinks this account after the reconnect listed it and before the restore.
      const row = await q.run((tx) => tx.adAccount.findUniqueOrThrow({ where: { id: gone.id } }));
      await unlinkAdAccount(q.owner, gone.id, { version: row.version });
      return { json: account(11) };
    });
    fake.on("GET", "/act_12", { json: account(12, { account_status: 2 }) });
    fake.on("GET", "/act_13", { json: account(13) });
    const done2 = await finish(q.cookies.owner, (await start(q)).state);
    expect(done2.headers.location).toBe(`/p/${q.projectId}/ads/accounts?connection=${connectionId}`);
    const rows = await q.run(async (tx) => ({
      accounts: await tx.adAccount.findMany({ orderBy: { externalId: "asc" } }),
      health: await tx.adSyncState.findMany({ where: { stream: "health" } }),
      restored: await tx.auditEvent.findMany({ where: { action: "ads.account.restored" } }),
    }));
    expect(rows.accounts.map((a) => [a.externalId, a.status, a.capability, a.writesEnabled])).toEqual([
      ["act_11", "unlinked", "write_verified", false],
      ["act_12", "disabled", "read_verified", false],
      ["act_13", "active", "read_verified", false],
    ]);
    expect(rows.accounts[1]!.providerStatus).toMatch(/^DISABLED/);
    expect(rows.health.map((h) => h.accountId).sort()).toEqual([off.id, kept.id].sort());
    expect(rows.restored.map((a) => a.resourceId).sort()).toEqual([off.id, kept.id].sort());
    expect((await connections(q)).map((c) => (c.config as { assignedAdAccounts: string[] }).assignedAdAccounts)).toEqual([["act_12", "act_13"]]);
    outputs.push(rows.accounts, rows.health);
  });

  it("leaks no token, code or app secret into any output Orbit wrote, in any project", async () => {
    const secrets = [...tokens, CODE, ADS_META_APP.appSecret];
    expect(outputs.length).toBeGreaterThan(20);
    expect(tokens.length).toBeGreaterThan(3);
    expect(projects.length).toBeGreaterThan(4);
    expectNoSecret(outputs, secrets);
    let audits = 0;
    for (const project of projects) {
      const rows = await project.run(async (tx) => ({
        audit: await tx.auditEvent.findMany({ select: { metadata: true, action: true, resourceId: true } }),
        events: await tx.domainEvent.findMany({ select: { data: true } }),
        notifications: await tx.notification.findMany({ select: { title: true, body: true, link: true } }),
        accounts: await tx.adAccount.findMany(),
        states: await tx.adOAuthState.findMany({ select: { stateHash: true, redirectAfter: true } }),
      }));
      audits += rows.audit.filter((a) => a.action === "ads.account.connected").length;
      expectNoSecret(rows, secrets);
    }
    expect(audits).toBeGreaterThanOrEqual(3);
  });
});

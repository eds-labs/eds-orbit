import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, jsonSafe, scoped } from "../../../packages/db/src/index.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { grantConnection } from "../src/platform/administration/connections.ts";
import { adAccountSettingsSchema } from "../src/modules/ads/accounts/account-settings.ts";
import { setMetaAdsFetchForTests } from "../src/modules/ads/providers/meta/transport.ts";
import { ADS_META_APP, createAdsProject, expectNoSecret, fakeToken, grantAdsMetaApp, type AdsProject } from "./support/ads-fixtures.ts";
import { createFakeMetaGraph, graphError } from "./support/fake-meta-graph.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const fake = createFakeMetaGraph();
const CODE = "authorization-code-ads-0002";

type World = { accounts: Record<string, unknown>[] };
type Who = "owner" | "editor" | "viewer";
type Method = "GET" | "POST" | "PATCH";
type P = Pick<AdsProject, "workspaceId" | "projectId" | "owner" | "cookies" | "ids" | "run" | "call">;

const meta = (n: number, over: Record<string, unknown> = {}) => ({
  id: `act_${n}`, account_id: String(n), name: `Account ${n}`, currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1,
  business: { id: "b1", name: "Biz" }, amount_spent: "1234", spend_cap: "50000", user_tasks: ["MANAGE"], ...over,
});
const defaultAccounts = () => [
  meta(1), meta(2, { currency: "JPY", spend_cap: "1500", amount_spent: "0" }), meta(3),
  meta(4, { currency: "XYZ" }), meta(5, { user_tasks: ["ANALYZE"] }), meta(9),
];

/**
 * Ad accounts (ADR 0025, A3 Task 5): discover, assign, edit, unlink. An
 * account belongs to one project per organization; another organization is
 * unaffected. Tokens never leave the sealed secret.
 */
describe.skipIf(!enabled)("ads accounts: discover, assign, edit, unlink", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const cleanups: Array<() => Promise<unknown>> = [];
  const origin = process.env.APP_ORIGIN!;
  const outputs: unknown[] = [];
  const tokens: string[] = [];
  const projects: P[] = [];
  const worlds = new Map<string, World>();
  /** The Meta app connection granted to each tracked project's organization. */
  const appOf = new Map<string, string>();
  let p: AdsProject;

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const track = async () => {
    const project = await createAdsProject({ app });
    projects.push(project);
    cleanups.push(() => project.cleanup());
    const granted = await grantAdsMetaApp(project);
    appOf.set(project.workspaceId, granted.connectionId);
    cleanups.push(granted.cleanup);
    return project;
  };
  /** A second project in the same organization, with the same members. */
  const sibling = async (base: AdsProject): Promise<P> => {
    const project = await authDb.project.create({ data: { workspaceId: base.workspaceId, name: "Sibling ads" } });
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId: base.workspaceId, projectId: project.id, userId: base.ids[who], role } });
    const run: P["run"] = (fn) => scoped(base.workspaceId, project.id, fn);
    await run((tx) =>
      tx.projectModule.create({ data: { workspaceId: base.workspaceId, projectId: project.id, moduleId: "ads", enabled: true, moduleVersion: "0.1.0", changedBy: base.ids.owner } }),
    );
    // The organization's app, granted to this project as well.
    await grantConnection({ userId: "admin-sibling", role: "admin" }, appOf.get(base.workspaceId)!, {
      workspaceId: base.workspaceId,
      projectId: project.id,
      purposes: ["ads_oauth"],
      modules: ["ads"],
    });
    const out: P = {
      workspaceId: base.workspaceId,
      projectId: project.id,
      owner: { ...base.owner, projectId: project.id },
      cookies: base.cookies,
      ids: base.ids,
      run,
      call: (who, method, url, payload) =>
        app.inject({
          method,
          url: `/api/projects/${project.id}${url}`,
          headers: { origin, cookie: base.cookies[who], [CLIENT_IP_HEADER]: ip() },
          ...(payload ? { payload } : {}),
        }),
    };
    projects.push(out);
    return out;
  };
  const api = async (project: P, who: Who, method: Method, url: string, payload?: object) => {
    const response = await project.call(who, method, url, payload);
    outputs.push(response.body);
    return response;
  };
  const code = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;

  /** Connects the project's owner to a fake Meta user whose token sees `accounts`; returns the connection id. */
  const connectMeta = async (project: P, options: { metaUser?: string; scopes?: string[]; accounts?: Record<string, unknown>[] } = {}) => {
    const token = fakeToken("acc");
    const scopes = options.scopes ?? ["ads_read", "ads_management"];
    tokens.push(token);
    worlds.set(token, { accounts: options.accounts ?? defaultAccounts() });
    fake.on("POST", "/oauth/access_token", { json: { access_token: token, token_type: "bearer", expires_in: 5183944 } });
    fake.on("GET", "/me", { json: { id: options.metaUser ?? "u-1", name: "Synthetic Meta User" } });
    fake.on("GET", "/me/permissions", { json: { data: scopes.map((permission) => ({ permission, status: "granted" })) } });
    const begin = await api(project, "owner", "POST", "/ads/connections/meta/connect");
    expect(begin.statusCode).toBe(200);
    const state = new URL(begin.json().authorizeUrl).searchParams.get("state")!;
    const done = await app.inject({
      method: "GET",
      url: `/api/ads/oauth/callback/meta?code=${CODE}&state=${encodeURIComponent(state)}`,
      headers: { origin, cookie: project.cookies.owner, [CLIENT_IP_HEADER]: ip() },
    });
    outputs.push(done.body, done.headers.location);
    const connection = new URL(done.headers.location as string, origin).searchParams.get("connection");
    expect(connection, String(done.headers.location)).toBeTruthy();
    return connection!;
  };
  const assign = (project: P, connectionId: string, externalId: string, who: Who = "owner") =>
    api(project, who, "POST", "/ads/accounts", { connectionId, externalId });
  const configOf = async (connectionId: string) =>
    (await authDb.connection.findUniqueOrThrow({ where: { id: connectionId } })).config as { assignedAdAccounts: string[] };
  const rows = (project: P) =>
    project.run(async (tx) => ({
      accounts: await tx.adAccount.findMany({ orderBy: { externalId: "asc" } }),
      health: await tx.adSyncState.findMany(),
      audit: await tx.auditEvent.findMany({ where: { action: { startsWith: "ads.account." } }, orderBy: { createdAt: "asc" } }),
    }));

  beforeAll(async () => {
    setMetaAdsFetchForTests(fake.fetch);
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_ADS = "true";
    app = await buildServer();
    const world = (request: { authorization: string | null }) => worlds.get((request.authorization ?? "").replace("Bearer ", ""));
    fake.on("GET", "/me/adaccounts", (request) => ({ json: { data: world(request)?.accounts ?? [] } }));
    for (let n = 1; n <= 99; n++)
      fake.on("GET", `/act_${n}`, (request) => {
        const found = world(request)?.accounts.find((a) => a.id === `act_${n}`);
        return found ? { json: found } : graphError(403, 200);
      });
    p = await track();
  });
  afterAll(async () => {
    setMetaAdsFetchForTests(null);
    expect(fake.misses).toEqual([]);
    for (const cleanup of cleanups.reverse()) await cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("validates the settings shape: strict, both fields default to null", () => {
    expect(adAccountSettingsSchema.parse({})).toEqual({ dsaBeneficiary: null, dsaPayor: null });
    expect(adAccountSettingsSchema.safeParse({ dsaPayor: "" }).success).toBe(false);
    expect(adAccountSettingsSchema.safeParse({ dsaPayor: "x".repeat(201) }).success).toBe(false);
    expect(adAccountSettingsSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it("lists the connection's accounts and marks them here, elsewhere or free", async () => {
    const q = await track();
    const b = await sibling(q);
    const connection = await connectMeta(q, { accounts: [meta(1), meta(2, { currency: "JPY", spend_cap: "1500", amount_spent: "0" }), meta(3)] });
    const connectionB = await connectMeta(b);
    type Listed = { accounts: Array<{ externalId: string; assigned: string | null; spendCapMicros: string | null; amountSpentMicros: string | null }>; truncated: boolean };
    const first = await api(q, "owner", "GET", `/ads/connections/${connection}/available-accounts`);
    expect(first.statusCode).toBe(200);
    let result: Listed = first.json();
    expect(result.truncated).toBe(false);
    expect(result.accounts.map((a) => [a.externalId, a.assigned])).toEqual([["act_1", null], ["act_2", null], ["act_3", null]]);
    expect(result.accounts[0]).toMatchObject({ spendCapMicros: "500000000", amountSpentMicros: "12340000", currency: "EUR", canWrite: true });
    expect(result.accounts[1]).toMatchObject({ spendCapMicros: "1500000000", amountSpentMicros: "0" });
    expect((await assign(q, connection, "act_1")).statusCode).toBe(200);
    expect((await assign(b, connectionB, "act_2")).statusCode).toBe(200);
    const response = await api(q, "owner", "GET", `/ads/connections/${connection}/available-accounts`);
    result = response.json();
    expect(result.accounts.map((a) => [a.externalId, a.assigned])).toEqual([["act_1", "here"], ["act_2", "elsewhere"], ["act_3", null]]);
    // The other project is reported as a boolean only.
    expect(response.body).not.toContain(b.projectId);
    expect(response.body).not.toContain(connectionB);
    expect(response.body).not.toContain("Sibling");
  });

  it("assigns: row from the live read, one health stream, micros for a JPY account", async () => {
    const q = await track();
    const writer = await connectMeta(q);
    const reader = await connectMeta(q, { metaUser: "u-2", scopes: ["ads_read"] });
    const eur = await assign(q, writer, "act_1");
    expect(eur.statusCode).toBe(200);
    expect(eur.json()).toMatchObject({
      externalId: "act_1", provider: "meta", name: "Account 1", currency: "EUR", timezone: "Europe/Berlin", status: "active",
      capability: "write_ready", writesEnabled: false, providerStatus: "ACTIVE", businessId: "b1", version: 1,
      spendCapMicros: "500000000", amountSpentMicros: "12340000", settings: { dsaBeneficiary: null, dsaPayor: null },
      connection: { id: writer, tokenType: "user" },
    });
    expect(eur.json().health.nextCheckAt).toBeTruthy();
    const jpy = await assign(q, writer, "act_2");
    expect(jpy.json()).toMatchObject({ currency: "JPY", spendCapMicros: "1500000000", amountSpentMicros: "0" });
    const readOnly = await assign(q, reader, "act_3");
    expect(readOnly.json()).toMatchObject({ capability: "read_verified", writesEnabled: false });
    const noTasks = await assign(q, writer, "act_5");
    expect(noTasks.json().capability).toBe("read_verified");
    const state = await rows(q);
    expect(state.accounts).toHaveLength(4);
    expect(state.health.filter((h) => h.stream === "health")).toHaveLength(4);
    for (const h of state.health) {
      expect(h.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 5.9 * 3_600_000);
      expect(h.nextRunAt.getTime()).toBeLessThan(Date.now() + 6.1 * 3_600_000);
    }
    const assigned = state.audit.filter((a) => a.action === "ads.account.assigned");
    expect(assigned).toHaveLength(4);
    expect(assigned[0]!.metadata).toEqual({ provider: "meta", connectionId: writer });
    expect((await configOf(writer)).assignedAdAccounts).toEqual(["act_1", "act_2", "act_5"]);
  });

  it("refuses an unsupported currency, a refused account and an invalid body, leaving no row and no claim", async () => {
    const q = await track();
    const connection = await connectMeta(q);
    const xyz = await assign(q, connection, "act_4");
    expect([xyz.statusCode, code(xyz)]).toEqual([409, "ADS_CURRENCY_UNSUPPORTED"]);
    const refused = await assign(q, connection, "act_77");
    expect([refused.statusCode, code(refused)]).toEqual([409, "ADS_ACCOUNT_NOT_GRANTED"]);
    expect((await api(q, "owner", "POST", "/ads/accounts", { connectionId: connection, externalId: "act_1x" })).statusCode).toBe(400);
    expect((await api(q, "owner", "POST", "/ads/accounts", { connectionId: connection, externalId: "act_1", extra: true })).statusCode).toBe(400);
    expect((await rows(q)).accounts).toHaveLength(0);
    expect((await configOf(connection)).assignedAdAccounts).toEqual([]);
  });

  it("keeps an account to one project per organization; another organization is unaffected", async () => {
    const a = await track();
    const b = await sibling(a);
    const c = await track();
    const [ca, cb, cc] = [await connectMeta(a), await connectMeta(b), await connectMeta(c)];
    expect((await assign(a, ca, "act_1")).statusCode).toBe(200);
    const clash = await assign(b, cb, "act_1");
    expect([clash.statusCode, code(clash)]).toEqual([409, "ADS_ACCOUNT_ASSIGNED_ELSEWHERE"]);
    expect(clash.body).not.toContain(a.projectId);
    expect((await rows(b)).accounts).toHaveLength(0);
    expect((await configOf(cb)).assignedAdAccounts).toEqual([]);
    expect((await assign(c, cc, "act_1")).statusCode).toBe(200);
    // Another organization's project can neither see nor use a's connection.
    expect((await assign(c, ca, "act_3")).statusCode).toBe(404);
    expect((await api(c, "owner", "GET", `/ads/connections/${ca}/available-accounts`)).statusCode).toBe(404);
  });

  it("lets exactly one of two parallel assignments of a fresh account win", async () => {
    const a = await track();
    const b = await sibling(a);
    const [ca, cb] = [await connectMeta(a), await connectMeta(b)];
    const [ra, rb] = await Promise.all([assign(a, ca, "act_9"), assign(b, cb, "act_9")]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(code(loser)).toBe("ADS_ACCOUNT_ASSIGNED_ELSEWHERE");
    expect((await rows(a)).accounts.length + (await rows(b)).accounts.length).toBe(1);
    const claims = [...(await configOf(ca)).assignedAdAccounts, ...(await configOf(cb)).assignedAdAccounts];
    expect(claims).toEqual(["act_9"]);
  });

  it("moves an account between two connections of the same project and releases the old claim", async () => {
    const q = await track();
    const one = await connectMeta(q, { metaUser: "u-1" });
    const two = await connectMeta(q, { metaUser: "u-2" });
    const first = await assign(q, one, "act_3");
    const moved = await assign(q, two, "act_3");
    expect(moved.statusCode).toBe(200);
    expect(moved.json().id).toBe(first.json().id);
    expect(moved.json().connection.id).toBe(two);
    expect((await configOf(one)).assignedAdAccounts).toEqual([]);
    expect((await configOf(two)).assignedAdAccounts).toEqual(["act_3"]);
    expect((await rows(q)).accounts).toHaveLength(1);
  });

  it("restricts routes by role and module state; another project's connection is 404", async () => {
    const q = await track();
    const connection = await connectMeta(q);
    const account = (await assign(q, connection, "act_1")).json();
    expect((await api(q, "editor", "GET", "/ads/accounts")).statusCode).toBe(200);
    expect((await api(q, "viewer", "GET", "/ads/accounts")).statusCode).toBe(403);
    const manage: Array<[Method, string, object?]> = [
      ["GET", "/ads/connections"],
      ["GET", `/ads/connections/${connection}/available-accounts`],
      ["POST", `/ads/connections/${connection}/revoke`],
      ["POST", "/ads/accounts", { connectionId: connection, externalId: "act_3" }],
      ["PATCH", `/ads/accounts/${account.id}`, { writesEnabled: true, version: 1 }],
      ["POST", `/ads/accounts/${account.id}/unlink`, { version: 1 }],
    ];
    for (const [method, url, payload] of manage)
      for (const who of ["editor", "viewer"] as const)
        expect((await api(q, who, method, url, payload)).statusCode, `${who} ${method} ${url}`).toBe(403);
    expect(await authDb.connection.count({ where: { id: connection, revokedAt: null } })).toBe(1);
    const other = await track();
    const otherConnection = await connectMeta(other);
    const otherAccount = (await assign(other, otherConnection, "act_1")).json();
    expect((await api(q, "owner", "GET", `/ads/connections/${otherConnection}/available-accounts`)).statusCode).toBe(404);
    expect((await api(q, "owner", "POST", `/ads/connections/${otherConnection}/revoke`)).statusCode).toBe(404);
    expect((await assign(q, otherConnection, "act_3")).statusCode).toBe(404);
    expect((await api(q, "owner", "PATCH", `/ads/accounts/${otherAccount.id}`, { writesEnabled: false, version: 1 })).statusCode).toBe(404);
    expect((await api(q, "owner", "POST", `/ads/accounts/${otherAccount.id}/unlink`, { version: 1 })).statusCode).toBe(404);
    expect(await authDb.connection.count({ where: { id: otherConnection, revokedAt: null } })).toBe(1);
    expect((await rows(other)).accounts[0]).toMatchObject({ status: "active" });
    const off = await createAdsProject({ app, enabled: false });
    cleanups.push(() => off.cleanup());
    const response = await off.call("owner", "GET", "/ads/accounts");
    expect([response.statusCode, code(response)]).toEqual([404, "ADS_DISABLED"]);
  });

  it("edits: stale version, write readiness and DSA settings", async () => {
    const q = await track();
    const writer = await connectMeta(q);
    const reader = await connectMeta(q, { metaUser: "u-2", scopes: ["ads_read"] });
    const ready = (await assign(q, writer, "act_1")).json();
    const readOnly = (await assign(q, reader, "act_3")).json();
    const stale = await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, { settings: { dsaPayor: "Payor" }, version: 99 });
    expect([stale.statusCode, code(stale)]).toEqual([409, "ADS_VERSION_CONFLICT"]);
    const blocked = await api(q, "owner", "PATCH", `/ads/accounts/${readOnly.id}`, { writesEnabled: true, version: readOnly.version });
    expect([blocked.statusCode, code(blocked)]).toEqual([409, "ADS_ACCOUNT_NOT_WRITE_READY"]);
    const saved = await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, { settings: { dsaBeneficiary: "Beneficiary GmbH" }, version: ready.version });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: ready.version + 1, settings: { dsaBeneficiary: "Beneficiary GmbH", dsaPayor: null } });
    const both = await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, { settings: { dsaPayor: "Payor AG" }, writesEnabled: true, version: saved.json().version });
    expect(both.json()).toMatchObject({ writesEnabled: true, settings: { dsaBeneficiary: "Beneficiary GmbH", dsaPayor: "Payor AG" } });
    const off = await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, { writesEnabled: false, version: both.json().version });
    expect(off.json().writesEnabled).toBe(false);
    for (const body of [{ version: 1, unknown: true }, { settings: { nope: 1 }, version: 1 }, { settings: { dsaPayor: "" }, version: 1 }, { version: 1 }, { writesEnabled: true }])
      expect((await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, body)).statusCode, JSON.stringify(body)).toBe(400);
    const audits = (await rows(q)).audit.filter((a) => a.action === "ads.account.writes_enabled").map((a) => a.metadata);
    expect(audits).toEqual([{ enabled: true }, { enabled: false }]);
    // A reconnect-required account cannot write either.
    await q.run((tx) => tx.adAccount.updateMany({ where: { id: ready.id }, data: { status: "reconnect_required" } }));
    const current = (await rows(q)).accounts.find((a) => a.id === ready.id)!;
    const notActive = await api(q, "owner", "PATCH", `/ads/accounts/${ready.id}`, { writesEnabled: true, version: current.version });
    expect(code(notActive)).toBe("ADS_ACCOUNT_NOT_WRITE_READY");
  });

  it("unlinks: frees the account, drops health rows, revokes an unused connection, reactivates the same row", async () => {
    const q = await track();
    const b = await sibling(q);
    const cb = await connectMeta(b);
    let connection = await connectMeta(q);
    const one = (await assign(q, connection, "act_1")).json();
    const two = (await assign(q, connection, "act_2")).json();
    await api(q, "owner", "PATCH", `/ads/accounts/${one.id}`, { writesEnabled: true, version: one.version });
    const stale = await api(q, "owner", "POST", `/ads/accounts/${one.id}/unlink`, { version: 1 });
    expect([stale.statusCode, code(stale)]).toEqual([409, "ADS_VERSION_CONFLICT"]);
    const current = (await rows(q)).accounts.find((a) => a.id === one.id)!;
    const done = await api(q, "owner", "POST", `/ads/accounts/${one.id}/unlink`, { version: current.version });
    expect(done.json()).toEqual({ id: one.id, status: "unlinked", connectionRevoked: false });
    let state = await rows(q);
    expect(state.accounts.find((a) => a.id === one.id)).toMatchObject({ status: "unlinked", writesEnabled: false });
    expect(state.health.map((h) => h.accountId)).toEqual([two.id]);
    expect((await api(q, "owner", "GET", "/ads/accounts")).json().accounts.map((a: { id: string }) => a.id)).toEqual([two.id]);
    expect((await configOf(connection)).assignedAdAccounts).toEqual(["act_2"]);
    expect((await api(q, "owner", "POST", `/ads/accounts/${one.id}/unlink`, { version: current.version + 1 })).statusCode).toBe(404);
    // Project B can use it now, and gives it back.
    expect((await assign(b, cb, "act_1")).statusCode).toBe(200);
    const clash = await assign(q, connection, "act_1");
    expect([clash.statusCode, code(clash)]).toEqual([409, "ADS_ACCOUNT_ASSIGNED_ELSEWHERE"]);
    const bRow = (await rows(b)).accounts[0]!;
    expect((await api(b, "owner", "POST", `/ads/accounts/${bRow.id}/unlink`, { version: bRow.version })).statusCode).toBe(200);
    // The same project reactivates the same row, writes off.
    const back = await assign(q, connection, "act_1");
    expect(back.json()).toMatchObject({ id: one.id, status: "active", writesEnabled: false });
    expect(back.json().version).toBeGreaterThan(current.version + 1);
    state = await rows(q);
    expect(state.health.filter((h) => h.accountId === one.id)).toHaveLength(1);
    // Unlinking the last accounts revokes the connection and wipes its secret.
    const versionOf = async (id: string) => (await rows(q)).accounts.find((a) => a.id === id)!.version;
    expect((await api(q, "owner", "POST", `/ads/accounts/${one.id}/unlink`, { version: await versionOf(one.id) })).json().connectionRevoked).toBe(false);
    const last = await api(q, "owner", "POST", `/ads/accounts/${two.id}/unlink`, { version: await versionOf(two.id) });
    expect(last.json().connectionRevoked).toBe(true);
    const connectionRow = await authDb.connection.findUniqueOrThrow({ where: { id: connection } });
    expect(connectionRow.revokedAt).not.toBeNull();
    // The revoked row forgets the person.
    expect(connectionRow.label).toBe("Meta (deleted)");
    expect((connectionRow.config as Record<string, unknown>).metaUserId).toBeNull();
    const secrets = await authDb.connectionSecret.findMany({ where: { connectionId: connection } });
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.every((s) => s.ciphertext === "" && s.state === "retired")).toBe(true);
    expect(((await api(q, "owner", "GET", "/ads/connections")).json() as { connections: unknown[] }).connections).toEqual([]);
    expect((await api(q, "owner", "GET", `/ads/connections/${connection}/available-accounts`)).statusCode).toBe(404);
    // A new connection brings the row back under the same id.
    connection = await connectMeta(q);
    expect((await assign(q, connection, "act_2")).json()).toMatchObject({ id: two.id, status: "active" });
  });

  it("revokes a connection with its accounts and frees their claims", async () => {
    const q = await track();
    const b = await sibling(q);
    const cb = await connectMeta(b);
    const connection = await connectMeta(q);
    await assign(q, connection, "act_1");
    await assign(q, connection, "act_3");
    expect((await authDb.connection.findUniqueOrThrow({ where: { id: connection } })).label).toBe("Meta: Synthetic Meta User");
    const done = await api(q, "owner", "POST", `/ads/connections/${connection}/revoke`);
    expect(done.json()).toEqual({ id: connection, accountsUnlinked: 2 });
    const revoked = await authDb.connection.findUniqueOrThrow({ where: { id: connection } });
    expect([revoked.label, (revoked.config as Record<string, unknown>).metaUserId]).toEqual(["Meta (deleted)", null]);
    expect(revoked.revokedAt).not.toBeNull();
    const state = await rows(q);
    expect(state.accounts.every((a) => a.status === "unlinked")).toBe(true);
    expect(state.health).toHaveLength(0);
    expect(state.audit.filter((a) => a.action === "ads.account.unlinked")).toHaveLength(2);
    expect((await authDb.connectionSecret.findMany({ where: { connectionId: connection } })).every((s) => s.ciphertext === "")).toBe(true);
    expect((await assign(b, cb, "act_1")).statusCode).toBe(200);
    expect((await api(q, "owner", "POST", `/ads/connections/${connection}/revoke`)).statusCode).toBe(404);
  });

  it("goes end to end over HTTP: connect, list connections and accounts, assign, read as editor", async () => {
    const q = await track();
    const connection = await connectMeta(q, { accounts: [meta(1), meta(3)] });
    const listed = await api(q, "owner", "GET", "/ads/connections");
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      app: "ready",
      connections: [{ id: connection, label: "Meta: Synthetic Meta User", tokenType: "user", grantedScopes: ["ads_management", "ads_read"], accountCount: 0 }],
    });
    const available = await api(q, "owner", "GET", `/ads/connections/${connection}/available-accounts`);
    expect(available.json().accounts.map((a: { externalId: string }) => a.externalId)).toEqual(["act_1", "act_3"]);
    const assigned = await assign(q, connection, "act_3");
    expect(assigned.statusCode).toBe(200);
    expect((await api(q, "owner", "GET", "/ads/connections")).json().connections[0].accountCount).toBe(1);
    for (const who of ["owner", "editor"] as const) {
      const list = await api(q, who, "GET", "/ads/accounts");
      expect(list.statusCode).toBe(200);
      expect(list.json().accounts).toHaveLength(1);
      expect(list.json().accounts[0]).toMatchObject({ id: assigned.json().id, externalId: "act_3", capability: "write_ready", connection: { id: connection } });
    }
  });

  it("leaks no token, code or app secret into any output, in any project", async () => {
    const secrets = [...tokens, CODE, ADS_META_APP.appSecret];
    expect(outputs.length).toBeGreaterThan(60);
    expect(tokens.length).toBeGreaterThan(15);
    expectNoSecret(outputs, secrets);
    let audits = 0;
    for (const project of projects) {
      const state = await project.run(async (tx) => ({
        audit: await tx.auditEvent.findMany({ select: { metadata: true, action: true, resourceId: true } }),
        events: await tx.domainEvent.findMany({ select: { data: true } }),
        notifications: await tx.notification.findMany({ select: { title: true, body: true, link: true } }),
        accounts: await tx.adAccount.findMany(),
        sync: await tx.adSyncState.findMany(),
      }));
      audits += state.audit.filter((a) => a.action === "ads.account.assigned").length;
      expectNoSecret(jsonSafe(state), secrets);
    }
    expect(audits).toBeGreaterThan(10);
  });
});

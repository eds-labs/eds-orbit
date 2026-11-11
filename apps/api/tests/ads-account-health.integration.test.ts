import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";
import { buildServer } from "../src/server.ts";
import { adsOAuthStateCleanup } from "../src/modules/ads/accounts/cleanup.ts";
import { adsAccountHealth, checkAdAccount } from "../src/modules/ads/accounts/health.ts";
import { setMetaAdsFetchForTests } from "../src/modules/ads/providers/meta/transport.ts";
import { createAdsProject, expectNoSecret, fakeToken, grantAdsMetaApp, type AdsProject } from "./support/ads-fixtures.ts";
import { createFakeMetaGraph, graphError, type FakeReply } from "./support/fake-meta-graph.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const fake = createFakeMetaGraph();
const CODE = "authorization-code-ads-0006";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const meta = (n: number, over: Record<string, unknown> = {}) => ({
  id: `act_${n}`, account_id: String(n), name: `Account ${n}`, currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1,
  business: { id: "b1", name: "Biz" }, amount_spent: "1234", spend_cap: "50000", user_tasks: ["MANAGE"], ...over,
});
const BOTH = { json: { data: ["ads_read", "ads_management"].map((permission) => ({ permission, status: "granted" })) } };

/**
 * Ad account health, expiry warning, notifications and clean-up (ADR 0025,
 * A3 Task 6). Outages never flip an account and never notify; a refusal
 * flips once and notifies the owners once.
 */
describe.skipIf(!enabled)("ads account health and clean-up", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const cleanups: Array<() => Promise<unknown>> = [];
  const origin = process.env.APP_ORIGIN!;
  const outputs: unknown[] = [];
  const tokens: string[] = [];
  const projects: AdsProject[] = [];
  const appOf = new Map<string, string>();
  let permissions: FakeReply = BOTH;
  const reads = new Map<string, FakeReply>();

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const track = async (enabledModule = true) => {
    const project = await createAdsProject({ app, enabled: enabledModule });
    projects.push(project);
    cleanups.push(() => project.cleanup());
    const granted = await grantAdsMetaApp(project);
    appOf.set(project.workspaceId, granted.connectionId);
    cleanups.push(granted.cleanup);
    return project;
  };
  const connectMeta = async (project: AdsProject, metaUser = "u-1") => {
    const token = fakeToken("hlt");
    tokens.push(token);
    fake.on("POST", "/oauth/access_token", { json: { access_token: token, token_type: "bearer", expires_in: 5183944 } });
    fake.on("GET", "/me", { json: { id: metaUser, name: "Synthetic Meta User" } });
    const begin = await project.call("owner", "POST", "/ads/connections/meta/connect");
    const state = new URL(begin.json().authorizeUrl).searchParams.get("state")!;
    const done = await app.inject({
      method: "GET",
      url: `/api/ads/oauth/callback/meta?code=${CODE}&state=${encodeURIComponent(state)}`,
      headers: { origin, cookie: project.cookies.owner, [CLIENT_IP_HEADER]: ip() },
    });
    const connection = new URL(done.headers.location as string, origin).searchParams.get("connection");
    expect(connection, String(done.headers.location)).toBeTruthy();
    return connection!;
  };
  const assign = async (project: AdsProject, connectionId: string, externalId: string) => {
    const response = await project.call("owner", "POST", "/ads/accounts", { connectionId, externalId });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  };
  /** A project with a connection and the given accounts, all assigned. */
  const setup = async (accounts = [1, 2]) => {
    const project = await track();
    const connection = await connectMeta(project);
    const ids: string[] = [];
    for (const n of accounts) ids.push(await assign(project, connection, `act_${n}`));
    fake.requests.length = 0;
    return { project, connection, ids };
  };
  const makeDue = (project: AdsProject) =>
    project.run((tx) => tx.adSyncState.updateMany({ where: { stream: "health" }, data: { nextRunAt: new Date(Date.now() - 1000) } }));
  const runHealth = async (project: AdsProject) => {
    await makeDue(project);
    return adsAccountHealth.run(project.owner);
  };
  const state = (project: AdsProject) =>
    project.run(async (tx) => ({
      accounts: await tx.adAccount.findMany({ orderBy: { externalId: "asc" } }),
      streams: await tx.adSyncState.findMany({ orderBy: { accountId: "asc" } }),
      audit: await tx.auditEvent.findMany({ where: { action: { startsWith: "ads.account." } }, orderBy: { createdAt: "asc" } }),
      events: await tx.domainEvent.findMany({ where: { type: "ads.account.reconnect_required" } }),
    }));
  const notices = async (project: AdsProject, kind: string) => {
    const rows = await userScoped(project.owner, (tx) => tx.notification.findMany({ where: { kind } }));
    outputs.push(rows);
    return rows;
  };
  const patchConfig = async (connectionId: string, patch: Record<string, string | string[] | null>) => {
    const row = await authDb.connection.findUniqueOrThrow({ where: { id: connectionId } });
    await authDb.connection.update({ where: { id: connectionId }, data: { config: { ...(row.config as object), ...patch } } });
  };
  const age = (connectionId: string, field: "createdAt" | "updatedAt", ms: number) =>
    authDb.$executeRawUnsafe(`UPDATE "Connection" SET "${field}" = now() - ($1 || ' milliseconds')::interval WHERE id = $2::uuid`, String(ms), connectionId);
  const statuses = async (project: AdsProject) => (await state(project)).accounts.map((a) => [a.externalId, a.status]);

  beforeAll(async () => {
    setMetaAdsFetchForTests(fake.fetch);
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_ADS = "true";
    process.env.ORBIT_NOTIFICATIONS = "true";
    app = await buildServer();
    fake.on("GET", "/me/permissions", () => permissions);
    fake.on("GET", "/me/adaccounts", { json: { data: [] } });
    for (let n = 1; n <= 12; n++) fake.on("GET", `/act_${n}`, () => reads.get(`act_${n}`) ?? { json: meta(n) });
  });
  beforeEach(() => {
    permissions = BOTH;
    reads.clear();
    fake.requests.length = 0;
  });
  afterAll(async () => {
    setMetaAdsFetchForTests(null);
    expect(fake.misses).toEqual([]);
    expectNoSecret(outputs, tokens);
    for (const cleanup of cleanups.reverse()) await cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("flips every account of a connection on a refused token, notifies the owners once, and stays quiet on a repeat", async () => {
    const { project, connection } = await setup();
    permissions = graphError(400, 190);
    await runHealth(project);
    let s = await state(project);
    expect(await statuses(project)).toEqual([["act_1", "reconnect_required"], ["act_2", "reconnect_required"]]);
    expect(s.audit.filter((a) => a.action === "ads.account.reconnect_required").map((a) => a.metadata)).toEqual([
      { code: "ADS_META_TOKEN_INVALID" },
      { code: "ADS_META_TOKEN_INVALID" },
    ]);
    expect(s.events).toHaveLength(2);
    expect(s.events.map((e) => e.data)).toEqual(expect.arrayContaining([{ accountId: s.accounts[0]!.id, code: "ADS_META_TOKEN_INVALID" }]));
    expect(s.streams.every((x) => x.lastErrorCode === "ADS_META_TOKEN_INVALID")).toBe(true);
    const sent = await notices(project, "ads_account_reconnect");
    expect(sent.map((n) => n.userId)).toEqual([project.ids.owner]);
    expect(sent[0]!.link).toBe(`/p/${project.projectId}/ads/accounts`);
    expect(sent[0]!.body).not.toMatch(/act_|Account \d/);
    // A second run still reads the refused accounts but changes and tells nothing.
    await runHealth(project);
    s = await state(project);
    expect(s.audit.filter((a) => a.action === "ads.account.reconnect_required")).toHaveLength(2);
    expect(s.events).toHaveLength(2);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
    expect(connection).toBeTruthy();
  });

  it("flips all accounts of a refused connection once, also those not due, and tells the owners once", async () => {
    const { project } = await setup();
    const [first] = (await state(project)).accounts;
    // Only act_1 is due; act_2's stream is six hours away.
    await project.run((tx) => tx.adSyncState.updateMany({ where: { accountId: first!.id }, data: { nextRunAt: new Date(Date.now() - 1000) } }));
    permissions = graphError(400, 190);
    await adsAccountHealth.run(project.owner);
    expect(await statuses(project)).toEqual([["act_1", "reconnect_required"], ["act_2", "reconnect_required"]]);
    expect((await state(project)).streams.every((x) => x.lastErrorCode === "ADS_META_TOKEN_INVALID" && x.nextRunAt.getTime() > Date.now() + 5.9 * HOUR)).toBe(true);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
    // Now act_2 is due: nothing flips, nobody is told again.
    await runHealth(project);
    expect((await state(project)).audit.filter((a) => a.action === "ads.account.reconnect_required")).toHaveLength(2);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
  });

  it("an outage changes no status, notifies nobody, records the code and counts failures", async () => {
    const { project, ids } = await setup([1]);
    reads.set("act_1", graphError(500, 2, { transient: true }));
    await runHealth(project);
    let s = await state(project);
    expect(s.accounts[0]!.status).toBe("active");
    expect(s.streams[0]).toMatchObject({ consecutiveFailures: 1 });
    expect(s.streams[0]!.lastErrorCode).toBeTruthy();
    expect(s.streams[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 5.9 * HOUR);
    expect(s.streams[0]!.nextRunAt.getTime()).toBeLessThan(Date.now() + 6.1 * HOUR);
    reads.set("act_1", { throw: new ConnectorError("TIMEOUT", "unknown", true) });
    await runHealth(project);
    s = await state(project);
    expect(s.accounts[0]!.status).toBe("active");
    expect(s.streams[0]).toMatchObject({ consecutiveFailures: 2 });
    expect(s.audit.filter((a) => a.action === "ads.account.reconnect_required")).toHaveLength(0);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(0);
    // The scope check is an outage too (still no flip).
    permissions = graphError(500, 2, { transient: true });
    await runHealth(project);
    expect((await state(project)).accounts[0]!.status).toBe("active");
    expect(ids).toHaveLength(1);
  });

  it("flips only the account Meta refuses", async () => {
    const { project } = await setup();
    reads.set("act_2", graphError(403, 200));
    await runHealth(project);
    expect(await statuses(project)).toEqual([["act_1", "active"], ["act_2", "reconnect_required"]]);
    const s = await state(project);
    expect(s.audit.filter((a) => a.action === "ads.account.reconnect_required").map((a) => a.metadata)).toEqual([{ code: "ADS_META_ACCOUNT_NOT_GRANTED" }]);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
  });

  it("flips on a token without any ads permission left", async () => {
    const { project } = await setup([1]);
    permissions = { json: { data: [{ permission: "public_profile", status: "granted" }] } };
    await runHealth(project);
    const s = await state(project);
    expect(s.accounts[0]!.status).toBe("reconnect_required");
    expect(s.streams[0]!.lastErrorCode).toBe("ADS_META_PERMISSION_MISSING");
  });

  it("warns once per expiry date; an expired token flips without a provider call", async () => {
    const { project, connection } = await setup();
    const soon = new Date(Date.now() + 10 * DAY).toISOString();
    await patchConfig(connection, { tokenExpiresAt: soon });
    await runHealth(project);
    expect(await statuses(project)).toEqual([["act_1", "active"], ["act_2", "active"]]);
    const first = await notices(project, "ads_token_expiring");
    expect(first.map((n) => n.userId)).toEqual([project.ids.owner]);
    expect(((await authDb.connection.findUniqueOrThrow({ where: { id: connection } })).config as { expiryWarnedFor: string }).expiryWarnedFor).toBe(soon);
    await runHealth(project);
    expect(await notices(project, "ads_token_expiring")).toHaveLength(1);
    // A later expiry date warns again.
    await patchConfig(connection, { tokenExpiresAt: new Date(Date.now() + 5 * DAY).toISOString() });
    await runHealth(project);
    expect(await notices(project, "ads_token_expiring")).toHaveLength(2);
    // Expired: both flip, no Graph request.
    await patchConfig(connection, { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    fake.requests.length = 0;
    await runHealth(project);
    expect(fake.requests).toEqual([]);
    const s = await state(project);
    expect(s.accounts.map((a) => a.status)).toEqual(["reconnect_required", "reconnect_required"]);
    expect(s.streams.every((x) => x.lastErrorCode === "ADS_META_TOKEN_EXPIRED")).toBe(true);
  });

  it("follows the provider status and never downgrades write_verified", async () => {
    const { project } = await setup([1]);
    await project.run((tx) => tx.adAccount.updateMany({ data: { capability: "write_verified" } }));
    reads.set("act_1", { json: meta(1, { account_status: 2, name: "Renamed" }) });
    await runHealth(project);
    let a = (await state(project)).accounts[0]!;
    expect(a).toMatchObject({ status: "disabled", name: "Renamed", capability: "write_verified" });
    expect(a.providerStatus).toMatch(/^DISABLED/);
    reads.delete("act_1");
    await runHealth(project);
    a = (await state(project)).accounts[0]!;
    expect(a).toMatchObject({ status: "active", providerStatus: "ACTIVE", capability: "write_verified" });
    const s = await state(project);
    expect(s.streams[0]).toMatchObject({ consecutiveFailures: 0, lastErrorCode: null });
    expect(s.streams[0]!.lastSuccessAt).toBeTruthy();
  });

  it("turns writing off once health finds it impossible: disabled at Meta, permission gone, token refused", async () => {
    const { project } = await setup([1, 2]);
    await project.run((tx) => tx.adAccount.updateMany({ data: { writesEnabled: true } }));
    const writes = async () => (await state(project)).accounts.map((a) => [a.externalId, a.status, a.capability, a.writesEnabled]);
    reads.set("act_2", { json: meta(2, { account_status: 2 }) });
    await runHealth(project);
    expect(await writes()).toEqual([["act_1", "active", "write_ready", true], ["act_2", "disabled", "write_ready", false]]);
    reads.delete("act_2");
    permissions = { json: { data: [{ permission: "ads_read", status: "granted" }] } };
    await runHealth(project);
    expect(await writes()).toEqual([["act_1", "active", "read_verified", false], ["act_2", "active", "read_verified", false]]);
    const refused = await setup([3]);
    await refused.project.run((tx) => tx.adAccount.updateMany({ data: { writesEnabled: true } }));
    permissions = graphError(400, 190);
    await runHealth(refused.project);
    expect((await state(refused.project)).accounts.map((a) => [a.status, a.writesEnabled])).toEqual([["reconnect_required", false]]);
  });

  it("throws Orbit's own failure after a successful read instead of recording an outage", async () => {
    const { project } = await setup([1]);
    // A name PostgreSQL cannot store: the read works, Orbit's write fails.
    reads.set("act_1", { json: meta(1, { name: "Broken\u0000Name" }) });
    await expect(runHealth(project)).rejects.toThrow();
    const s = await state(project);
    expect(s.streams[0]).toMatchObject({ consecutiveFailures: 0, lastErrorCode: null });
    expect(s.accounts[0]).toMatchObject({ status: "active", name: "Account 1" });
  });

  it("restores a reconnect_required account whose read works: on the periodic run and on a manual check", async () => {
    const { project, ids } = await setup();
    await project.run((tx) => tx.adAccount.updateMany({ data: { status: "reconnect_required" } }));
    await runHealth(project);
    expect(await statuses(project)).toEqual([["act_1", "active"], ["act_2", "active"]]);
    expect((await state(project)).audit.filter((a) => a.action === "ads.account.restored")).toHaveLength(2);
    // Manual check through the route; the owner only.
    await project.run((tx) => tx.adAccount.updateMany({ where: { id: ids[0] }, data: { status: "reconnect_required" } }));
    expect((await project.call("editor", "POST", `/ads/accounts/${ids[0]}/check`)).statusCode).toBe(403);
    expect((await state(project)).accounts[0]!.status).toBe("reconnect_required");
    const response = await project.call("owner", "POST", `/ads/accounts/${ids[0]}/check`);
    expect([response.statusCode, response.json()]).toEqual([200, { ok: true }]);
    expect((await state(project)).accounts[0]!.status).toBe("active");
    // A check that is not manual leaves a waiting account alone.
    await project.run((tx) => tx.adAccount.updateMany({ where: { id: ids[0] }, data: { status: "reconnect_required" } }));
    fake.requests.length = 0;
    expect(await checkAdAccount(project.owner, ids[0]!)).toEqual({ ok: false, code: "ADS_ACCOUNT_RECONNECT_REQUIRED" });
    expect(fake.requests).toEqual([]);
    expect((await project.call("owner", "POST", `/ads/accounts/${randomUUID()}/check`)).statusCode).toBe(404);
  });

  it("keeps a reconnect_required account that is still refused, without a new flip or notice", async () => {
    const { project } = await setup([1]);
    permissions = graphError(400, 190);
    await runHealth(project);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
    const before = await state(project);
    await runHealth(project);
    const after = await state(project);
    expect(after.accounts[0]).toMatchObject({ status: "reconnect_required", version: before.accounts[0]!.version });
    expect(after.audit).toHaveLength(before.audit.length);
    expect(after.streams[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 5.9 * HOUR);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
    const manual = await checkAdAccount(project.owner, before.accounts[0]!.id, { manual: true });
    expect(manual).toEqual({ ok: false, code: "ADS_META_TOKEN_INVALID" });
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(1);
  });

  it("notes an admin-disabled connection on the streams without a token call, a flip or a notice", async () => {
    const { project, connection, ids } = await setup();
    await authDb.connection.update({ where: { id: connection }, data: { disabledAt: new Date() } });
    await runHealth(project);
    expect(fake.requests).toEqual([]);
    const s = await state(project);
    expect(s.accounts.map((a) => [a.externalId, a.status])).toEqual([["act_1", "active"], ["act_2", "active"]]);
    expect(s.streams.map((x) => [x.lastErrorCode, x.consecutiveFailures])).toEqual([["ADS_CONNECTION_DISABLED", 0], ["ADS_CONNECTION_DISABLED", 0]]);
    expect(s.streams.every((x) => x.nextRunAt.getTime() > Date.now() + 5.9 * HOUR)).toBe(true);
    expect(s.audit.filter((a) => a.action === "ads.account.reconnect_required")).toHaveLength(0);
    expect(s.events).toHaveLength(0);
    expect(await notices(project, "ads_account_reconnect")).toHaveLength(0);
    expect(await checkAdAccount(project.owner, ids[0]!, { manual: true })).toEqual({ ok: false, code: "ADS_CONNECTION_DISABLED" });
    expect(fake.requests).toEqual([]);
    // Enabled again: the next run reads the accounts as before.
    await authDb.connection.update({ where: { id: connection }, data: { disabledAt: null } });
    await runHealth(project);
    expect((await state(project)).streams.every((x) => x.lastErrorCode === null)).toBe(true);
  });

  it("probes at most 10 accounts per run and one scope call per connection", async () => {
    const project = await track();
    const connection = await connectMeta(project);
    for (let n = 1; n <= 11; n++) await assign(project, connection, `act_${n}`);
    fake.requests.length = 0;
    await runHealth(project);
    expect(fake.requests.filter((r) => r.path === "/me/permissions")).toHaveLength(1);
    expect(fake.requests.filter((r) => /^\/act_\d+$/.test(r.path))).toHaveLength(10);
    const streams = await project.run((tx) => tx.adSyncState.findMany());
    // The 11th keeps its due time and is read by the next run.
    expect(streams.filter((x) => x.nextRunAt.getTime() <= Date.now())).toHaveLength(1);
  });

  it("is due when a health stream is; the module off means never", async () => {
    const { project } = await setup([1]);
    const due = await project.run((tx) => adsAccountHealth.nextDueAt!(tx, project.owner));
    expect(due!.getTime()).toBeGreaterThan(Date.now() + 5.9 * HOUR);
    const off = await track(false);
    expect(await off.run((tx) => adsAccountHealth.nextDueAt!(tx, off.owner))).toBeNull();
    expect(await adsAccountHealth.run(off.owner)).toBeUndefined();
    const bare = await track();
    expect(await bare.run((tx) => adsAccountHealth.nextDueAt!(tx, bare.owner))).toBeNull();
  });

  describe("clean-up", () => {
    const stateRow = (project: AdsProject, age: number) =>
      project.run((tx) =>
        tx.adOAuthState.create({
          data: {
            id: randomUUID(), workspaceId: project.workspaceId, projectId: project.projectId,
            stateHash: randomBytes(32).toString("hex"), provider: "meta", appConnectionId: appOf.get(project.workspaceId)!,
            userId: project.ids.owner, createdAt: new Date(Date.now() - age - DAY), expiresAt: new Date(Date.now() - age),
          },
        }),
      );

    it("removes states that expired more than a day ago and keeps newer ones", async () => {
      const project = await track();
      await stateRow(project, 2 * DAY);
      const keep = await stateRow(project, 2 * HOUR);
      const due = await project.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, project.owner));
      expect(due!.getTime()).toBeLessThan(Date.now());
      await adsOAuthStateCleanup.run(project.owner);
      const left = await project.run((tx) => tx.adOAuthState.findMany());
      expect(left.map((r) => r.id)).toEqual([keep.id]);
      const next = await project.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, project.owner));
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    });

    it("revokes an unused connection after 24 hours and keeps a younger one or one with an account", async () => {
      const project = await track();
      const old = await connectMeta(project, "u-old");
      const young = await connectMeta(project, "u-young");
      const used = await connectMeta(project, "u-used");
      await assign(project, used, "act_1");
      await age(old, "createdAt", 25 * HOUR);
      await age(used, "createdAt", 30 * HOUR);
      const revoked = async (id: string) => (await authDb.connection.findUniqueOrThrow({ where: { id } })).revokedAt !== null;
      // Changed less than ten minutes ago (a claim in flight, say): not yet.
      let due = await project.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, project.owner));
      expect(due!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
      await adsOAuthStateCleanup.run(project.owner);
      expect(await revoked(old)).toBe(false);
      for (const id of [old, young, used]) await age(id, "updatedAt", HOUR);
      due = await project.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, project.owner));
      expect(due!.getTime()).toBeLessThanOrEqual(Date.now());
      await adsOAuthStateCleanup.run(project.owner);
      expect([await revoked(old), await revoked(young), await revoked(used)]).toEqual([true, false, false]);
      const forgotten = await authDb.connection.findUniqueOrThrow({ where: { id: old } });
      expect([forgotten.label, (forgotten.config as Record<string, unknown>).metaUserId]).toEqual(["Meta (deleted)", null]);
      const next = await project.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, project.owner));
      expect(next!.getTime()).toBeGreaterThan(Date.now() + 22 * HOUR);
    });

    it("does not revoke an unused connection that holds a claim", async () => {
      const project = await track();
      const connection = await connectMeta(project, "u-claim");
      // An assignment in flight: claimed, no row yet.
      await patchConfig(connection, { assignedAdAccounts: ["act_7"] });
      await age(connection, "createdAt", 25 * HOUR);
      await age(connection, "updatedAt", HOUR);
      const result = await adsOAuthStateCleanup.run(project.owner);
      expect(result?.status).toBe("removed 0 states, revoked 0, released 1");
      expect((await authDb.connection.findUniqueOrThrow({ where: { id: connection } })).revokedAt).toBeNull();
    });

    it("releases a claim that no account row backs, and keeps one that does", async () => {
      const project = await track();
      const connection = await connectMeta(project);
      await assign(project, connection, "act_1");
      await patchConfig(connection, { assignedAdAccounts: ["act_1", "act_3"] });
      // A claim younger than ten minutes may belong to an assignment in flight.
      await adsOAuthStateCleanup.run(project.owner);
      expect(((await authDb.connection.findUniqueOrThrow({ where: { id: connection } })).config as { assignedAdAccounts: string[] }).assignedAdAccounts).toEqual(["act_1", "act_3"]);
      await age(connection, "updatedAt", HOUR);
      await adsOAuthStateCleanup.run(project.owner);
      expect(((await authDb.connection.findUniqueOrThrow({ where: { id: connection } })).config as { assignedAdAccounts: string[] }).assignedAdAccounts).toEqual(["act_1"]);
    });

    it("does nothing while the module is off", async () => {
      const off = await track(false);
      expect(await off.run((tx) => adsOAuthStateCleanup.nextDueAt!(tx, off.owner))).toBeNull();
      expect(await adsOAuthStateCleanup.run(off.owner)).toBeUndefined();
    });
  });
});

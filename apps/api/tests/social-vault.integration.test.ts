import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { openSecret } from "../src/platform/connections/secrets.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { accountCredentials } from "../src/modules/social/accounts/vault.ts";
import { socialAttention } from "../src/modules/social/attention.ts";
import { grantSocialApp, removeProjectConnections, X_APP_SECRET } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const MINUTE = 60_000;

/**
 * Token access (ADR 0020, S2 Task 7): an X token close to expiry is
 * refreshed once under the connection's lock; a refused refresh marks the
 * account for a reconnect and tells the owners; an outage changes nothing.
 */
describe.skipIf(!enabled)("social account tokens", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let cleanupApp: () => Promise<unknown>;
  let tokenCalls = 0;
  let reply: () => Response;

  const x = async (externalId: string, secret: Record<string, unknown>) => {
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "x",
      externalId,
      handle: `@user${externalId}`,
      displayName: "Synthetic",
      secret: JSON.stringify(secret),
      config: { userId: externalId },
      settings: { refreshable: secret.refreshToken !== null },
    });
    return accountId;
  };
  const tokens = (expiresInMs: number, refreshToken: string | null = "refresh-1") => ({
    accessToken: "access-1",
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    scopes: ["tweet.write"],
  });
  const account = (id: string) => p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id } }));
  const secret = async (accountId: string) => {
    const { connectionId } = await account(accountId);
    const active = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId, state: "active" } });
    return { version: active.version, value: JSON.parse(openSecret(active)) };
  };

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    process.env.ORBIT_NOTIFICATIONS = "true";
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
    cleanupApp = (await grantSocialApp(p, "social.app.x", X_APP_SECRET)).cleanup;
  });
  beforeEach(() => {
    tokenCalls = 0;
    setSocialFetchForTests(async (url) => {
      if (String(url) !== "https://api.x.com/2/oauth2/token") return new Response("{}", { status: 404 });
      tokenCalls++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return reply();
    });
  });
  afterEach(() => setSocialFetchForTests(null));
  afterAll(async () => {
    delete process.env.ORBIT_NOTIFICATIONS;
    await removeProjectConnections(p);
    await cleanupApp?.();
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  const fresh = () =>
    new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("returns a valid token without a refresh", async () => {
    const id = await x("1", tokens(60 * MINUTE));
    expect(await accountCredentials(p.owner, id)).toMatchObject({ platform: "x", accessToken: "access-1", externalId: "1" });
    expect(tokenCalls).toBe(0);
  });

  it("refreshes a token close to expiry once and stores the next version", async () => {
    reply = fresh;
    const id = await x("2", tokens(2 * MINUTE));
    expect((await accountCredentials(p.owner, id)).accessToken).toBe("access-2");
    expect(tokenCalls).toBe(1);
    expect(await secret(id)).toMatchObject({ version: 2, value: { accessToken: "access-2", refreshToken: "refresh-2" } });
  });

  it("refreshes only once for two callers at the same time", async () => {
    reply = fresh;
    const id = await x("3", tokens(MINUTE));
    const [a, b] = await Promise.all([accountCredentials(p.owner, id), accountCredentials(p.owner, id)]);
    expect([a.accessToken, b.accessToken]).toEqual(["access-2", "access-2"]);
    expect(tokenCalls).toBe(1);
  });

  it("marks the account for a reconnect when X refuses the refresh, and tells the owner once", async () => {
    reply = () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
    const id = await x("4", tokens(MINUTE));
    const before = await secret(id);
    await expect(accountCredentials(p.owner, id)).rejects.toMatchObject({ code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED", status: 409 });
    expect(await account(id)).toMatchObject({ status: "reconnect_required" });
    expect(await secret(id)).toEqual(before);
    await expect(accountCredentials(p.owner, id)).rejects.toMatchObject({ code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED" });
    expect(tokenCalls).toBe(1);
    const notices = await userScoped(p.owner, (tx) =>
      tx.notification.findMany({ where: { kind: "social_account_reconnect", projectId: p.owner.projectId } }),
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toMatch(/access-1|refresh-1/);
  });

  it("keeps the account active when X refuses the developer app (401)", async () => {
    reply = () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    const id = await x("4b", tokens(MINUTE));
    await expect(accountCredentials(p.owner, id)).rejects.toMatchObject({ code: "SOCIAL_APP_INVALID" });
    expect(await account(id)).toMatchObject({ status: "active" });
    expect((await secret(id)).version).toBe(1);
  });

  it("needs a reconnect for an expiring token without a refresh token", async () => {
    const id = await x("5", tokens(MINUTE, null));
    await expect(accountCredentials(p.owner, id)).rejects.toMatchObject({ code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED" });
    expect(tokenCalls).toBe(0);
    expect(await account(id)).toMatchObject({ status: "reconnect_required" });
  });

  it("changes nothing when X is unavailable", async () => {
    reply = () => new Response("{}", { status: 503 });
    const id = await x("6", tokens(MINUTE));
    await expect(accountCredentials(p.owner, id)).rejects.toMatchObject({ code: "SOCIAL_PROVIDER_UNAVAILABLE", status: 503 });
    expect(await account(id)).toMatchObject({ status: "active" });
    expect((await secret(id)).version).toBe(1);
  });

  it("refuses another project's account", async () => {
    const id = await x("7", tokens(60 * MINUTE));
    await expect(accountCredentials(other.owner, id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("shows accounts that need a reconnect as attention, to readers of this project only", async () => {
    const viewerItems = await p.run((tx) => socialAttention(tx, p.viewer, new Date()));
    expect(viewerItems).toEqual([
      expect.objectContaining({
        id: "social:reconnect",
        moduleId: "social",
        kind: "social_account_reconnect",
        severity: "warning",
        count: 2,
        navKey: "social.accounts",
        link: "/social/accounts",
      }),
    ]);
    expect(await other.run((tx) => socialAttention(tx, other.viewer, new Date()))).toEqual([]);
  });
});

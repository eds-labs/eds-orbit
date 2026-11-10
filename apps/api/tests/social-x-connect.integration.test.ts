import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { openSecret } from "../src/platform/connections/secrets.ts";
import { redirectUri } from "../src/modules/social/accounts/apps.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { consumeOAuthState } from "../src/modules/social/accounts/oauth-state.ts";
import { xConnect } from "../src/modules/social/accounts/x.ts";
import { grantSocialApp, removeProjectConnections, X_APP_SECRET } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

type Seen = { url: string; method: string; headers: Headers; body: string };

/**
 * X accounts (ADR 0020, S2 Task 6): the SDK's OAuth provider exchanges the
 * code with PKCE and Basic auth; Orbit stores the tokens only as a sealed
 * secret of the account's project connection. No test reaches X.
 */
describe.skipIf(!enabled)("connecting X accounts", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let cleanupApp: () => Promise<unknown>;
  const seen: Seen[] = [];
  let token: Record<string, unknown> = {};
  let me: Response | (() => Response);

  const fakeX = () =>
    setSocialFetchForTests(async (url, init = {}) => {
      const request = new Request(String(url), init);
      seen.push({ url: String(url), method: request.method, headers: request.headers, body: await request.text() });
      if (String(url) === "https://api.x.com/2/oauth2/token")
        return new Response(JSON.stringify(token), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).startsWith("https://api.x.com/2/users/me"))
        return typeof me === "function" ? me() : me.clone();
      return new Response("{}", { status: 404 });
    });
  const connect = async () => {
    const begun = await p.run((tx) => xConnect.begin(tx, p.owner));
    const state = new URL(begun.authorizeUrl).searchParams.get("state")!;
    const attempt = await p.run((tx) => consumeOAuthState(tx, p.owner, { state, platform: "x" }));
    const callbackUrl = `${redirectUri(loadConfig(), "x")}?code=code-1&state=${encodeURIComponent(state)}`;
    return { begun, result: await xConnect.finish(p.owner, { callbackUrl, state, attempt }) };
  };
  const accounts = () => p.run((tx) => tx.socialAccount.findMany({ where: { projectId: p.owner.projectId, platform: "x" } }));
  const secretOf = async (connectionId: string) => {
    const active = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId, state: "active" } });
    return { version: active.version, value: JSON.parse(openSecret(active)) };
  };

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    cleanupApp = (await grantSocialApp(p, "social.app.x", X_APP_SECRET)).cleanup;
  });
  afterEach(async () => {
    setSocialFetchForTests(null);
    seen.length = 0;
  });
  afterAll(async () => {
    await removeProjectConnections(p);
    await cleanupApp?.();
    await p?.cleanup();
    await closeDatabase();
  });

  const user = (id = "777") =>
    new Response(JSON.stringify({ data: { id, name: "Orbit HQ", username: "orbit_hq" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("starts the authorization at x.com with PKCE and the module's callback", async () => {
    fakeX();
    const begun = await p.run((tx) => xConnect.begin(tx, p.owner));
    const url = new URL(begun.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(X_APP_SECRET.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri(loadConfig(), "x"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read offline.access media.write");
  });

  it("connects an account and keeps its tokens only in a sealed secret", async () => {
    token = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 7200, scope: "tweet.read tweet.write", token_type: "bearer" };
    me = user();
    fakeX();
    const { result } = await connect();
    expect(result).toEqual({ accounts: 1 });
    expect(JSON.stringify(result)).not.toContain("access-1");
    const [account] = await accounts();
    expect(account).toMatchObject({
      platform: "x",
      externalId: "777",
      handle: "@orbit_hq",
      displayName: "Orbit HQ",
      status: "active",
      capability: "read_verified",
    });
    const secret = await secretOf(account!.connectionId);
    expect(secret.version).toBe(1);
    expect(secret.value).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", scopes: ["tweet.read", "tweet.write"] });
    expect(Date.parse(secret.value.expiresAt)).toBeGreaterThan(Date.now());
    const tokenCall = seen.find((s) => s.url === "https://api.x.com/2/oauth2/token")!;
    expect(tokenCall.headers.get("authorization")).toBe(
      `Basic ${btoa(`${X_APP_SECRET.clientId}:${X_APP_SECRET.clientSecret}`)}`,
    );
    expect(new URLSearchParams(tokenCall.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await p.run((tx) => tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "social.account.connected" } }));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/access-1|refresh-1/);
  });

  it("rotates the secret when the same X user connects again", async () => {
    token = { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 };
    me = user();
    fakeX();
    await connect();
    const list = await accounts();
    expect(list).toHaveLength(1);
    const secret = await secretOf(list[0]!.connectionId);
    expect(secret).toMatchObject({ version: 2, value: { accessToken: "access-2", refreshToken: "refresh-2" } });
  });

  it("marks an account without a refresh token as not refreshable", async () => {
    token = { access_token: "access-3", expires_in: 7200 };
    me = user("888");
    fakeX();
    await connect();
    const account = (await accounts()).find((a) => a.externalId === "888")!;
    expect((account.settings as { refreshable?: boolean }).refreshable).toBe(false);
    expect((await secretOf(account.connectionId)).value.refreshToken).toBeNull();
  });

  it("leaves nothing behind when X does not return the user", async () => {
    token = { access_token: "access-4", refresh_token: "refresh-4", expires_in: 7200 };
    let calls = 0;
    // The SDK's discovery succeeds; Orbit's profile read fails.
    me = () => (++calls === 1 ? user("999") : new Response("{}", { status: 503 }));
    fakeX();
    const before = await authDb.connection.count({ where: { projectId: p.owner.projectId } });
    await expect(connect()).rejects.toMatchObject({ code: "SOCIAL_PROVIDER_UNAVAILABLE" });
    expect((await accounts()).some((a) => a.externalId === "999")).toBe(false);
    expect(await authDb.connection.count({ where: { projectId: p.owner.projectId } })).toBe(before);
  });

  it("maps a refused code exchange to a social error without its detail", async () => {
    setSocialFetchForTests(async () =>
      new Response(JSON.stringify({ error: "invalid_request", error_description: "secret-detail" }), { status: 400 }),
    );
    const error = await connect().then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error?.code).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(error?.message).not.toContain("secret-detail");
  });
});

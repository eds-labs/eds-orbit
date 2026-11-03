import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { openSecret } from "../src/platform/connections/secrets.ts";
import { redirectUri } from "../src/modules/social/accounts/apps.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { metaConnect, metaHealth } from "../src/modules/social/accounts/meta.ts";
import { consumeOAuthState } from "../src/modules/social/accounts/oauth-state.ts";
import { grantSocialApp, META_APP_SECRET, removeProjectConnections } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const GRAPH = "https://graph.facebook.com/v26.0";

type Page = { id: string; name: string; access_token: string; tasks: string[]; instagram_business_account?: object };

/**
 * Meta (ADR 0020, S-D4, S2 Task 8): Facebook Login for Business; every Page
 * the user granted in Meta's dialog becomes an account, and so does the
 * Instagram professional account linked to it. No test reaches Meta.
 */
describe.skipIf(!enabled)("connecting Facebook Pages and Instagram accounts", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let cleanupApp: () => Promise<unknown>;
  const urls: string[] = [];
  let pages: Page[][] = [];
  let exchange: () => Response;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeGraph = () =>
    setSocialFetchForTests(async (url) => {
      const u = new URL(String(url));
      urls.push(String(url));
      if (u.pathname === "/v26.0/oauth/access_token")
        return u.searchParams.get("grant_type") === "fb_exchange_token"
          ? json({ access_token: "long-user-token", token_type: "bearer", expires_in: 5183944 })
          : exchange();
      if (u.pathname === "/v26.0/me") return json({ id: "meta-user-1", name: "Mario" });
      if (u.pathname === "/v26.0/me/accounts") {
        const index = Number(u.searchParams.get("page") ?? "0");
        const next = index + 1 < pages.length ? `${GRAPH}/me/accounts?page=${index + 1}` : undefined;
        return json({ data: pages[index] ?? [], paging: next ? { next } : {} });
      }
      return json({}, 404);
    });
  const connect = async () => {
    const begun = await p.run((tx) => metaConnect.begin(tx, p.owner));
    const state = new URL(begun.authorizeUrl).searchParams.get("state")!;
    const attempt = await p.run((tx) => consumeOAuthState(tx, p.owner, { state, platform: "facebook" }));
    return metaConnect.finish(p.owner, {
      callbackUrl: `${redirectUri(loadConfig(), "meta")}?code=meta-code&state=${encodeURIComponent(state)}`,
      state,
      attempt,
    });
  };
  const accounts = () =>
    p.run((tx) =>
      tx.socialAccount.findMany({
        where: { projectId: p.owner.projectId, platform: { in: ["facebook", "instagram"] } },
        orderBy: { externalId: "asc" },
      }),
    );
  const secretOf = async (connectionId: string) => {
    const active = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId, state: "active" } });
    return { version: active.version, value: JSON.parse(openSecret(active)) };
  };
  const page = (id: string, extra: Partial<Page> = {}): Page => ({
    id,
    name: `Page ${id}`,
    access_token: `page-token-${id}`,
    tasks: ["CREATE_CONTENT", "MODERATE"],
    ...extra,
  });

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    cleanupApp = (await grantSocialApp(p, "social.app.meta", META_APP_SECRET)).cleanup;
  });
  afterEach(() => {
    setSocialFetchForTests(null);
    urls.length = 0;
  });
  afterAll(async () => {
    await removeProjectConnections(p);
    await cleanupApp?.();
    await p?.cleanup();
    await closeDatabase();
  });

  it("starts Facebook Login for Business with the configuration, not with scopes", async () => {
    fakeGraph();
    const begun = await p.run((tx) => metaConnect.begin(tx, p.owner));
    const url = new URL(begun.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: META_APP_SECRET.appId,
      config_id: META_APP_SECRET.configId,
      response_type: "code",
      redirect_uri: redirectUri(loadConfig(), "meta"),
    });
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("connects every granted Page with posting rights and its linked Instagram account", async () => {
    exchange = () => json({ access_token: "short-user-token", token_type: "bearer", expires_in: 3600 });
    pages = [
      [
        page("101", { instagram_business_account: { id: "ig-501", username: "orbit_ig", name: "Orbit IG" } }),
        page("102", { tasks: ["ANALYZE"] }),
      ],
      [page("103")],
    ];
    fakeGraph();
    expect(await connect()).toEqual({ accounts: 3 });
    const list = await accounts();
    expect(list.map((a) => [a.platform, a.externalId, a.handle])).toEqual([
      ["facebook", "101", "Page 101"],
      ["facebook", "103", "Page 103"],
      ["instagram", "ig-501", "@orbit_ig"],
    ]);
    const ig = list.find((a) => a.platform === "instagram")!;
    expect((await secretOf(ig.connectionId)).value).toEqual({ pageToken: "page-token-101" });
    const igConnection = await authDb.connection.findUniqueOrThrow({ where: { id: ig.connectionId } });
    expect(igConnection.config).toMatchObject({ metaUserId: "meta-user-1", pageId: "101", igUserId: "ig-501" });
    // The code exchange carries the app secret; the user and Page reads carry only the user token.
    const exchanges = urls.filter((u) => u.includes("/oauth/access_token"));
    expect(exchanges).toHaveLength(2);
    for (const u of urls.filter((u) => !u.includes("/oauth/access_token")))
      expect(u).not.toContain(META_APP_SECRET.appSecret);
    expect(urls.some((u) => u.includes("short-user-token") && !u.includes("fb_exchange_token"))).toBe(false);
  });

  it("follows at most five result pages and only on graph.facebook.com", async () => {
    exchange = () => json({ access_token: "short-user-token" });
    pages = Array.from({ length: 8 }, (_, i) => [page(`2${i}`)]);
    fakeGraph();
    expect(await connect()).toEqual({ accounts: 5 });
    expect(urls.filter((u) => u.includes("/me/accounts"))).toHaveLength(5);
  });

  it("rotates the secrets of known Pages and flags Pages no longer granted", async () => {
    exchange = () => json({ access_token: "short-user-token" });
    pages = [[page("101", { access_token: "page-token-101-new", instagram_business_account: { id: "ig-501", username: "orbit_ig" } })]];
    fakeGraph();
    await connect();
    const list = await accounts();
    const fb101 = list.find((a) => a.externalId === "101")!;
    expect(await secretOf(fb101.connectionId)).toMatchObject({ version: 2, value: { pageToken: "page-token-101-new" } });
    expect(list.find((a) => a.externalId === "103")).toMatchObject({ status: "reconnect_required" });
    expect(list.find((a) => a.externalId === "101")).toMatchObject({ status: "active" });
  });

  it("leaves nothing behind when the code exchange fails", async () => {
    exchange = () => json({ error: { code: 100, message: "secret-detail" } }, 400);
    pages = [[page("901")]];
    fakeGraph();
    const before = await authDb.connection.count({ where: { projectId: p.owner.projectId } });
    const error = await connect().then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error?.code).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(error?.message).not.toContain("secret-detail");
    expect(await authDb.connection.count({ where: { projectId: p.owner.projectId } })).toBe(before);
    expect((await accounts()).some((a) => a.externalId === "901")).toBe(false);
  });

  it("refuses a login that granted no Page", async () => {
    exchange = () => json({ access_token: "short-user-token" });
    pages = [[]];
    fakeGraph();
    await expect(connect()).rejects.toMatchObject({ code: "SOCIAL_META_NO_PAGES" });
  });

  it("checks a Page token with the app token and maps invalid tokens and missing permissions", async () => {
    let debug: unknown = {};
    let status = 200;
    const seen: Array<{ url: string; auth: string | null }> = [];
    setSocialFetchForTests(async (url, init = {}) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return json(debug, status);
    });
    debug = { data: { is_valid: true, expires_at: 0, data_access_expires_at: 1900000000, granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["101"] }] } };
    expect(await metaHealth(META_APP_SECRET, "page-token-101", "facebook", "101")).toMatchObject({ ok: true });
    expect(new URL(seen[0]!.url).pathname).toBe("/v26.0/debug_token");
    expect(seen[0]!.auth).toBe(`Bearer ${META_APP_SECRET.appId}|${META_APP_SECRET.appSecret}`);
    expect(await metaHealth(META_APP_SECRET, "page-token-101", "facebook", "999")).toEqual({ ok: false, code: "SOCIAL_META_PERMISSION_MISSING" });
    expect(await metaHealth(META_APP_SECRET, "page-token-101", "instagram", "ig-501")).toEqual({ ok: false, code: "SOCIAL_META_PERMISSION_MISSING" });
    debug = { data: { is_valid: false, error: { code: 190, subcode: 463 } } };
    expect(await metaHealth(META_APP_SECRET, "page-token-101", "facebook", "101")).toEqual({ ok: false, code: "SOCIAL_META_TOKEN_INVALID" });
    // An HTTP-level 190 concerns the token of the call itself: the app token.
    debug = { error: { code: 190, error_subcode: 460 } };
    status = 400;
    await expect(metaHealth(META_APP_SECRET, "page-token-101", "facebook", "101")).rejects.toMatchObject({
      code: "SOCIAL_APP_INVALID",
    });
    debug = { error: { code: 4 } };
    status = 400;
    await expect(metaHealth(META_APP_SECRET, "page-token-101", "facebook", "101")).rejects.toMatchObject({ code: "SOCIAL_RATE_LIMITED" });
  });
});

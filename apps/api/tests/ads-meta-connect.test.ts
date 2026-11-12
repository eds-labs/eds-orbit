import { describe, expect, it } from "vitest";
import { metaAdsProvider } from "../src/modules/ads/providers/meta/provider.ts";
import { AdsProviderError, type ProviderApp } from "../src/modules/ads/providers/types.ts";
import { graphError, installFakeMetaGraph } from "./support/fake-meta-graph.ts";

const app: ProviderApp = { clientId: "123456789", clientSecret: "test-app-secret-0123456789", configId: "8876543210" };
const REDIRECT = "https://orbit.example.test/api/ads/meta/callback";
const CODE = "test-auth-code-abcdef";
const SHORT = "short-lived-token-0001";
const LONG = "long-lived-token-0002";
const connect = metaAdsProvider.connect!;

async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(AdsProviderError); return error as AdsProviderError; }
  throw new Error("expected failure");
}

function routeLogin(fake: ReturnType<typeof installFakeMetaGraph>, permissions: string[] = ["ads_read", "ads_management"]) {
  fake.on("GET", "/me", { json: { id: "u1", name: "Mario" } });
  fake.on("GET", "/me/permissions", { json: { data: permissions.map(permission => ({ permission, status: "granted" })).concat([{ permission: "email", status: "declined" }]) } });
}

describe("meta connect: authorize url", () => {
  it("uses the config id, state and redirect on the pinned version, without scope or secret", () => {
    const url = new URL(connect.authorizeUrl({ app, redirectUri: REDIRECT, state: "state-xyz" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(url.searchParams.get("config_id")).toBe("8876543210");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("client_id")).toBe(app.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.toString()).not.toContain(app.clientSecret);
  });
});

describe("meta connect: finish", () => {
  it("exchanges a short-lived token for a long-lived user token", async () => {
    const fake = installFakeMetaGraph();
    fake.on("POST", "/oauth/access_token", request =>
      request.form?.get("grant_type") === "fb_exchange_token"
        ? { json: { access_token: LONG, token_type: "bearer", expires_in: 5183944 } }
        : { json: { access_token: SHORT, token_type: "bearer", expires_in: 3600 } });
    routeLogin(fake);
    const before = Date.now();
    const grant = await connect.finish({ app, redirectUri: REDIRECT, code: CODE });
    expect(fake.requests.filter(r => r.method === "POST")).toHaveLength(2);
    expect(grant.tokenType).toBe("user");
    expect(grant.accessToken).toBe(LONG);
    expect(grant.userId).toBe("u1");
    expect(grant.userName).toBe("Mario");
    expect(grant.grantedScopes).toEqual(["ads_management", "ads_read"]);
    const seconds = (grant.expiresAt!.getTime() - before) / 1000;
    expect(seconds).toBeGreaterThan(5183944 - 5);
    expect(seconds).toBeLessThan(5183944 + 60);
    expect(fake.requests.filter(r => r.method === "GET").every(r => r.authorization === `Bearer ${LONG}`)).toBe(true);
  });

  it("keeps a token without expiry as a system user token with one POST", async () => {
    const fake = installFakeMetaGraph();
    fake.on("POST", "/oauth/access_token", { json: { access_token: LONG, token_type: "bearer" } });
    routeLogin(fake);
    const grant = await connect.finish({ app, redirectUri: REDIRECT, code: CODE });
    expect(fake.requests.filter(r => r.method === "POST")).toHaveLength(1);
    expect(grant.tokenType).toBe("system_user");
    expect(grant.expiresAt).toBeNull();
  });

  it("for every request: no access token, code or client secret in the URL query", async () => {
    const fake = installFakeMetaGraph();
    fake.on("POST", "/oauth/access_token", request =>
      request.form?.get("grant_type") === "fb_exchange_token"
        ? { json: { access_token: LONG, expires_in: 5183944 } }
        : { json: { access_token: SHORT, expires_in: 3600 } });
    routeLogin(fake);
    await connect.finish({ app, redirectUri: REDIRECT, code: CODE });
    const secrets = [SHORT, LONG, CODE, app.clientSecret];
    for (const request of fake.requests) {
      for (const secret of secrets) expect(request.query.toString()).not.toContain(secret);
    }
    const exchange = fake.requests[0]!;
    expect(exchange.form?.get("code")).toBe(CODE);
    expect(exchange.form?.get("client_secret")).toBe(app.clientSecret);
    expect(fake.requests[1]!.form?.get("fb_exchange_token")).toBe(SHORT);
  });

  it("refuses a grant without ads_read or ads_management", async () => {
    const fake = installFakeMetaGraph();
    fake.on("POST", "/oauth/access_token", { json: { access_token: LONG } });
    routeLogin(fake, ["pages_show_list"]);
    const error = await failure(connect.finish({ app, redirectUri: REDIRECT, code: CODE }));
    expect(error.failure.code).toBe("ADS_META_PERMISSION_MISSING");
    expect(error.failure.kind).toBe("permission");
  });

  it("classifies a failed code exchange without leaking the code", async () => {
    const fake = installFakeMetaGraph();
    fake.on("POST", "/oauth/access_token", graphError(400, 100));
    const error = await failure(connect.finish({ app, redirectUri: REDIRECT, code: CODE }));
    expect(error.message).not.toContain(CODE);
  });
});

const account = (over: Record<string, unknown> = {}) => ({
  id: "act_1", account_id: "1", name: "Main", currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1,
  business: { id: "b1", name: "Biz" }, amount_spent: "1234", spend_cap: "50000", ...over,
});
const scopes = ["ads_read", "ads_management"];

describe("meta connect: ad accounts", () => {
  it("maps money, status and currency support", async () => {
    const fake = installFakeMetaGraph();
    fake.on("GET", "/me/adaccounts", { json: { data: [
      account(),
      account({ id: "act_2", account_id: "2", currency: "JPY", spend_cap: "1500", amount_spent: "0" }),
      account({ id: "act_3", account_id: "3", spend_cap: "0", account_status: 2, disable_reason: 3 }),
      account({ id: "act_4", account_id: "4", currency: "XYZ" }),
      account({ id: "act_5", account_id: "5", spend_cap: undefined, user_tasks: ["ANALYZE"] }),
    ] } });
    const { accounts, truncated } = await connect.listAccounts({ app, accessToken: LONG, grantedScopes: scopes });
    expect(truncated).toBe(false);
    expect(accounts[0]).toMatchObject({ externalId: "act_1", currency: "EUR", timezone: "Europe/Berlin", providerStatus: "ACTIVE", status: "active", businessId: "b1", businessName: "Biz", spendCapMicros: 500_000_000n, amountSpentMicros: 12_340_000n, canWrite: true, currencySupported: true });
    expect(accounts[1]).toMatchObject({ spendCapMicros: 1_500_000_000n, amountSpentMicros: 0n });
    expect(accounts[2]).toMatchObject({ spendCapMicros: null, status: "disabled", providerStatus: "DISABLED:3" });
    expect(accounts[3]).toMatchObject({ currencySupported: false, spendCapMicros: null, amountSpentMicros: null });
    expect(accounts[4]).toMatchObject({ spendCapMicros: null, canWrite: false });
    expect(fake.requests[0]!.query.get("limit")).toBe("100");
    expect(fake.requests[0]!.query.get("fields")).toContain("user_tasks");
  });

  it("treats a malformed amount as not available without failing the list or read", async () => {
    const fake = installFakeMetaGraph();
    fake.on("GET", "/me/adaccounts", { json: { data: [
      account({ id: "act_8", account_id: "8", amount_spent: "12.5x", spend_cap: "-1" }),
      account({ id: "act_9", account_id: "9" }),
    ] } });
    const { accounts } = await connect.listAccounts({ app, accessToken: LONG, grantedScopes: scopes });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ externalId: "act_8", amountSpentMicros: null, spendCapMicros: null });
    expect(accounts[1]).toMatchObject({ externalId: "act_9", amountSpentMicros: 12_340_000n, spendCapMicros: 500_000_000n });
    fake.on("GET", "/act_8", { json: account({ id: "act_8", account_id: "8", amount_spent: "1e3" }) });
    const read = await connect.readAccount({ app, accessToken: LONG, grantedScopes: scopes, externalId: "act_8" });
    expect(read.amountSpentMicros).toBeNull();
    expect(read.spendCapMicros).toBe(500_000_000n);
  });

  it("canWrite needs ads_management", async () => {
    const fake = installFakeMetaGraph();
    fake.on("GET", "/act_1", { json: account({ user_tasks: ["MANAGE"] }) });
    const read = await connect.readAccount({ app, accessToken: LONG, grantedScopes: ["ads_read"], externalId: "act_1" });
    expect(read.canWrite).toBe(false);
    const write = await connect.readAccount({ app, accessToken: LONG, grantedScopes: scopes, externalId: "act_1" });
    expect(write.canWrite).toBe(true);
  });

  it("stops after 10 pages and reports truncation", async () => {
    const fake = installFakeMetaGraph();
    fake.on("GET", "/me/adaccounts", request => {
      const n = Number(request.query.get("after") ?? "0") + 1;
      return { json: { data: [account({ id: `act_${n}`, account_id: String(n) })], paging: { cursors: { after: String(n) }, next: "https://x.invalid/next" } } };
    });
    const { accounts, truncated } = await connect.listAccounts({ app, accessToken: LONG, grantedScopes: scopes });
    expect(fake.requests).toHaveLength(10);
    expect(accounts).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it("refuses an invalid account id without a request", async () => {
    const fake = installFakeMetaGraph();
    const error = await failure(connect.readAccount({ app, accessToken: LONG, grantedScopes: scopes, externalId: "act_12x" }));
    expect(error.failure.code).toBe("ADS_ACCOUNT_ID_INVALID");
    expect(fake.requests).toHaveLength(0);
  });

  it("classifies provider failures", async () => {
    const fake = installFakeMetaGraph();
    fake.on("GET", "/act_1", graphError(401, 190));
    expect((await failure(connect.readAccount({ app, accessToken: LONG, grantedScopes: scopes, externalId: "act_1" }))).failure.kind).toBe("auth");
    fake.on("GET", "/act_1", { status: 500, json: {} });
    expect((await failure(connect.readAccount({ app, accessToken: LONG, grantedScopes: scopes, externalId: "act_1" }))).failure.kind).toBe("transient");
  });
});

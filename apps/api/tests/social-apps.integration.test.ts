import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { centralProviders, createConnection, grantConnection, revokeConnectionGrant, rotateSecret } from "../src/platform/administration/connections.ts";
import { registeredConnectionProvider } from "../src/platform/modules/contributions.ts";
import { appCredentials, appReadiness, redirectUri } from "../src/modules/social/accounts/apps.ts";
import { setSocialFetchForTests, socialFetch } from "../src/modules/social/accounts/http.ts";
import { sealSecret } from "../src/platform/connections/secrets.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

const X_SECRET = JSON.stringify({ clientId: "client-1-abcdef", clientSecret: "x-client-secret-0123456789" });
const META_SECRET = JSON.stringify({ appId: "1234567890", appSecret: "meta-app-secret-0123456789", configId: "9876543210" });

/**
 * Developer apps (ADR 0020, S2 Task 3): system connections that the
 * administration grants to an organization and a project; the social
 * module reads them only through that grant.
 */
describe.skipIf(!enabled)("social developer apps", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let third: Awaited<ReturnType<typeof createSocialProject>>;
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const created: string[] = [];

  const app = async (provider: string, secret: string, grantTo = p) => {
    const connection = await createConnection(admin, { provider, label: `Synthetic ${provider}`, config: {}, secret });
    created.push(connection.id);
    await grantConnection(admin, connection.id, {
      workspaceId: grantTo.owner.workspaceId,
      purposes: ["social_oauth"],
      modules: ["social"],
    });
    await grantConnection(admin, connection.id, {
      workspaceId: grantTo.owner.workspaceId,
      projectId: grantTo.owner.projectId,
      purposes: ["social_oauth"],
      modules: ["social"],
    });
    return connection.id;
  };
  // A malformed secret stored before entry validation existed: written
  // straight into the active secret row, as the forms now refuse it.
  const legacyMalformedApp = async (provider: string, secret: string, grantTo: typeof p) => {
    const id = await app(provider, provider === "social.app.meta" ? META_SECRET : X_SECRET, grantTo);
    await authDb.connectionSecret.updateMany({ where: { connectionId: id, state: "active" }, data: sealSecret(secret) });
    return id;
  };

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
    third = await createSocialProject({ name: "Synthetic social C" });
  });
  afterEach(() => setSocialFetchForTests(null));
  afterAll(async () => {
    await authDb.connection.deleteMany({ where: { id: { in: created } } });
    await p?.cleanup();
    await other?.cleanup();
    await third?.cleanup();
    await closeDatabase();
  });

  it("registers the developer apps as system providers and the accounts as module-managed", () => {
    expect(registeredConnectionProvider("social.app.x")).toMatchObject({ scopes: ["system"], purposes: ["social_oauth"], owner: "social" });
    expect(registeredConnectionProvider("social.app.meta")).toMatchObject({ scopes: ["system"], purposes: ["social_oauth"], owner: "social" });
    for (const platform of ["x", "facebook", "instagram", "telegram"])
      expect(registeredConnectionProvider(`social.account.${platform}`)).toMatchObject({
        scopes: ["project"],
        managedByModule: true,
        purposes: ["social_publish"],
        owner: "social",
      });
  });

  it("resolves a developer app granted to the project", async () => {
    const id = await app("social.app.x", X_SECRET);
    const found = await p.run((tx) => appCredentials(tx, p.owner, "x"));
    expect(found).toEqual({ connectionId: id, x: { clientId: "client-1-abcdef", clientSecret: "x-client-secret-0123456789" } });
  });

  it("refuses an app that is not granted to the project", async () => {
    await expect(other.run((tx) => appCredentials(tx, other.owner, "meta"))).rejects.toMatchObject({
      code: "SOCIAL_APP_NOT_GRANTED",
      status: 409,
    });
  });

  it("refuses a malformed app secret without echoing it", async () => {
    await legacyMalformedApp("social.app.meta", JSON.stringify({ appId: "12", appSecret: "leaky-secret-value" }), other);
    const error = await other.run((tx) => appCredentials(tx, other.owner, "meta")).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error?.code).toBe("SOCIAL_APP_INVALID");
    expect(error?.message).not.toContain("leaky-secret-value");
  });

  it("tells which developer apps are ready, not granted or invalid, without the secret", async () => {
    expect(await third.run((tx) => appReadiness(tx, third.owner))).toEqual({ x: "not_granted", meta: "not_granted" });
    await app("social.app.x", X_SECRET, third);
    await legacyMalformedApp("social.app.meta", JSON.stringify({ appId: "12", appSecret: "leaky-secret-value" }), third);
    const readiness = await third.run((tx) => appReadiness(tx, third.owner));
    expect(readiness).toEqual({ x: "ready", meta: "invalid" });
    expect(JSON.stringify(readiness)).not.toContain("leaky-secret-value");
  });

  it("tells an app granted to the organization but not to the project apart", async () => {
    const connection = await createConnection(admin, {
      provider: "social.app.x",
      label: "Synthetic organization-only X app",
      config: {},
      secret: X_SECRET,
    });
    created.push(connection.id);
    const grant = await grantConnection(admin, connection.id, {
      workspaceId: other.owner.workspaceId,
      purposes: ["social_oauth"],
      modules: ["social"],
    });
    expect((await other.run((tx) => appReadiness(tx, other.owner))).x).toBe("project_not_granted");
    await revokeConnectionGrant(admin, grant.id);
    expect((await other.run((tx) => appReadiness(tx, other.owner))).x).toBe("not_granted");
  });

  it("offers a separate field per key and the callback path for each developer app", () => {
    const providers = centralProviders();
    const fields = (id: string) =>
      providers.find((p) => p.id === id)!.secretFields!.map((f) => [f.key, Boolean(f.secret)]);
    expect(fields("social.app.x")).toEqual([
      ["clientId", false],
      ["clientSecret", true],
    ]);
    expect(fields("social.app.meta")).toEqual([
      ["appId", false],
      ["appSecret", true],
      ["configId", false],
    ]);
    expect(providers.find((p) => p.id === "social.app.x")!.callbackPath).toBe("/api/social/oauth/callback/x");
    expect(providers.find((p) => p.id === "social.app.meta")!.callbackPath).toBe("/api/social/oauth/callback/meta");
    for (const p of providers.filter((p) => !/^[a-z][a-z0-9_]*\.app\./.test(p.id)))
      expect(p).not.toHaveProperty("secretFields");
    // The browser's patterns accept what the server accepts.
    for (const [id, secret] of [
      ["social.app.x", JSON.parse(X_SECRET)],
      ["social.app.meta", JSON.parse(META_SECRET)],
    ] as const)
      for (const f of providers.find((p) => p.id === id)!.secretFields!)
        expect(new RegExp(`^(?:${f.pattern})$`).test(secret[f.key]), `${id} ${f.key}`).toBe(true);
  });

  it("refuses a malformed developer app secret when it is stored or replaced, without echoing it", async () => {
    const leaky = JSON.stringify({ appId: "12ab", appSecret: "leaky-secret-value-123", configId: "9876543210" });
    const created = await createConnection(admin, { provider: "social.app.meta", label: "Bad", config: {}, secret: leaky }).then(
      () => undefined,
      (e: Error & { code?: string; status?: number }) => e,
    );
    expect(created).toMatchObject({ code: "SOCIAL_APP_INVALID", status: 422 });
    expect(JSON.stringify(created) + created?.message).not.toContain("leaky-secret-value");
    const id = await app("social.app.x", X_SECRET, third);
    await expect(rotateSecret(admin, id, { secret: JSON.stringify({ clientId: "short", clientSecret: "x" }) })).rejects.toMatchObject({
      code: "SOCIAL_APP_INVALID",
      status: 422,
    });
  });

  it("checks a Meta app with its app token in a header, never in the URL", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setSocialFetchForTests(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "1234567890", name: "Orbit" }), { status: 200 });
    });
    const check = registeredConnectionProvider("social.app.meta")!.check!;
    expect(await check({ provider: "social.app.meta" }, META_SECRET)).toMatchObject({ status: "read_verified" });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/v26.0/1234567890");
    expect(calls[0]!.url).not.toContain("meta-app-secret");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer 1234567890|meta-app-secret-0123456789",
    );
  });

  it("reports a refused Meta app without the secret", async () => {
    setSocialFetchForTests(async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }));
    const check = registeredConnectionProvider("social.app.meta")!.check!;
    const error = await check({}, META_SECRET).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error?.code).toBe("SOCIAL_APP_CHECK_FAILED");
    expect(JSON.stringify(error)).not.toContain("meta-app-secret");
  });

  it("builds the callback URLs from the web origin", () => {
    expect(redirectUri({ APP_ORIGIN: "https://orbit.example/" }, "x")).toBe("https://orbit.example/api/social/oauth/callback/x");
    expect(redirectUri({ APP_ORIGIN: "https://orbit.example" }, "meta")).toBe("https://orbit.example/api/social/oauth/callback/meta");
  });

  it("sends through the bounded transport: a Request is accepted, http and private hosts are refused", async () => {
    await expect(socialFetch(new Request("http://example.com/"))).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    await expect(socialFetch("https://127.0.0.1/")).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT" });
  });
});

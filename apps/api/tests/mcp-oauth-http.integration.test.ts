import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import {
  ORIGIN_EXEMPT_OAUTH,
  oauthAuthPaths,
} from "../src/platform/mcp-auth/http.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const origin = process.env.APP_ORIGIN!;
const WEB_HOP = "10.0.3.4";
const METADATA = "/.well-known/oauth-authorization-server/api/auth";
const KEYS = ["ORBIT_MCP_OAUTH", "ORBIT_MCP_DCR"] as const;

/** Builds the app (and Better Auth) with the given flags, then restores the env. */
async function withFlags(
  flags: Partial<Record<(typeof KEYS)[number], string>>,
) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, flags);
  try {
    return { app: await buildServer(), auth: makeAuth(), config: loadConfig() };
  } finally {
    for (const k of KEYS)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

const form = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("oauthAuthPaths", () => {
  const config = (oauth: string, dcr: string) =>
    ({ ORBIT_MCP_OAUTH: oauth, ORBIT_MCP_DCR: dcr }) as never;
  it("is empty with the flag off and lists register only with DCR on", () => {
    expect(oauthAuthPaths(config("false", "true"))).toEqual([]);
    const on = oauthAuthPaths(config("true", "false"));
    expect(on).toContain("/api/auth/oauth2/token");
    expect(on).toContain("/api/auth/jwks");
    expect(on).toContain("/api/auth/.well-known/openid-configuration");
    expect(on).not.toContain("/api/auth/oauth2/register");
    expect(oauthAuthPaths(config("true", "true"))).toContain(
      "/api/auth/oauth2/register",
    );
  });
  it("exempts only the machine endpoints from the browser Origin check", () => {
    for (const p of ["token", "revoke", "introspect", "register"])
      expect(ORIGIN_EXEMPT_OAUTH.test(`/api/auth/oauth2/${p}`)).toBe(true);
    for (const p of ["consent", "authorize", "continue", "tokenx"])
      expect(ORIGIN_EXEMPT_OAUTH.test(`/api/auth/oauth2/${p}`)).toBe(false);
    expect(ORIGIN_EXEMPT_OAUTH.test("/api/auth/oauth2/token?x=1")).toBe(false);
  });
});

describe.skipIf(!enabled)("OAuth HTTP surface, flag off", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    ({ app } = await withFlags({ ORBIT_MCP_OAUTH: "false" }));
  });
  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it("flag off: oauth2 endpoints answer 403 AUTH_ENDPOINT_DISABLED and well-known answers 404", async () => {
    for (const url of [
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/authorize",
      "/api/auth/jwks",
      "/api/auth/.well-known/openid-configuration",
    ]) {
      const r = await app.inject({
        method: "POST",
        url,
        headers: { origin, ...FORM },
        payload: form({ grant_type: "authorization_code" }),
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("AUTH_ENDPOINT_DISABLED");
    }
    // Without Origin the exemption does not apply either: the check comes first.
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: FORM,
      payload: form({ grant_type: "authorization_code" }),
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error.code).toBe("ORIGIN_REQUIRED");
    expect((await app.inject({ url: METADATA })).statusCode).toBe(404);
  });
});

describe.skipIf(!enabled)("OAuth HTTP surface, flag on", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let auth: ReturnType<typeof makeAuth>;
  const users: string[] = [];
  beforeAll(async () => {
    ({ app, auth } = await withFlags({ ORBIT_MCP_OAUTH: "true" }));
  });
  afterAll(async () => {
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("flag on: authorization server metadata validates", async () => {
    const r = await app.inject({ url: METADATA });
    expect(r.statusCode).toBe(200);
    const meta = r.json();
    expect(meta.issuer).toBe(`${origin}/api/auth`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.scopes_supported).toContain("orbit:read");
    expect(meta).not.toHaveProperty("registration_endpoint");
    for (const grant of meta.grant_types_supported)
      expect(["authorization_code", "refresh_token"]).toContain(grant);
    expect(meta.token_endpoint).toBe(`${origin}/api/auth/oauth2/token`);
  });

  it("openid configuration exposes userinfo and jwks", async () => {
    const r = await app.inject({
      url: "/api/auth/.well-known/openid-configuration",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().userinfo_endpoint).toBe(
      `${origin}/api/auth/oauth2/userinfo`,
    );
    expect(r.json().jwks_uri).toBe(`${origin}/api/auth/jwks`);
    const jwks = await app.inject({ url: "/api/auth/jwks" });
    expect(jwks.statusCode).toBe(200);
    expect(Array.isArray(jwks.json().keys)).toBe(true);
  });

  it("keeps /token and unlisted auth endpoints closed", async () => {
    for (const url of ["/api/auth/token", "/api/auth/sign-up/email"]) {
      const r = await app.inject({
        method: "POST",
        url,
        headers: { origin },
        payload: {},
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("AUTH_ENDPOINT_DISABLED");
    }
  });

  it("token endpoint accepts a form-encoded body without Origin", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: WEB_HOP,
      headers: { ...FORM, "x-orbit-client-ip": "198.51.100.7" },
      payload: form({
        grant_type: "authorization_code",
        code: "nope",
        client_id: "https://client.invalid/client.json",
        code_verifier: "x".repeat(43),
        redirect_uri: "https://client.invalid/cb",
        resource: `${origin}/mcp`,
      }),
    });
    // An OAuth error from Better Auth, not ORIGIN_REQUIRED and not a parse error.
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    const body = r.json();
    expect(body.error?.code).toBeUndefined();
    expect(typeof body.error).toBe("string");
    expect(["invalid_client", "invalid_request", "invalid_grant"]).toContain(
      body.error,
    );
    // The form fields were read: a double-encoded body would not name a client.
    expect(body.error).toBe("invalid_client");
  });

  it("consent endpoint still requires the browser Origin", async () => {
    const without = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/consent",
      headers: { "content-type": "application/json" },
      payload: { accept: true },
    });
    expect(without.statusCode).toBe(403);
    expect(without.json().error.code).toBe("ORIGIN_REQUIRED");
    const withOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/consent",
      headers: { origin },
      payload: { accept: true },
    });
    expect(withOrigin.json().error?.code).not.toBe("ORIGIN_REQUIRED");
  });

  it("the Origin exemption cannot be reached through a query string or a sibling path", async () => {
    for (const url of [
      "/api/auth/oauth2/consent?x=/api/auth/oauth2/token",
      "/api/auth/oauth2/consent/oauth2/token",
      "/api/auth/oauth2/token/",
    ]) {
      const r = await app.inject({
        method: "POST",
        url,
        headers: FORM,
        payload: form({ a: "b" }),
      });
      expect(r.statusCode).toBe(403);
    }
  });

  it("token endpoint is limited per client IP", async () => {
    const call = (ip: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/oauth2/token",
        remoteAddress: WEB_HOP,
        headers: { ...FORM, "x-orbit-client-ip": ip },
        payload: form({ grant_type: "authorization_code", client_id: "x" }),
      });
    for (let i = 0; i < 20; i++)
      expect((await call("198.51.100.20")).statusCode).toBeLessThan(429);
    expect((await call("198.51.100.20")).statusCode).toBe(429);
    expect([400, 401]).toContain((await call("198.51.100.21")).statusCode);
  });

  it("sign-in responses carry no set-auth-jwt header (flag on)", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await auth.api.signUpEmail({
      body: { email, name: "Synthetic OAuth HTTP user", password },
    });
    users.push(created.user.id);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: WEB_HOP,
      headers: { origin, "x-orbit-client-ip": "198.51.100.30" },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["set-auth-jwt"]).toBeUndefined();
    expect(r.headers["set-cookie"]).toBeDefined();
    const cookie = (r.headers["set-cookie"] as string[] | string)
      .toString()
      .split(";")[0]!;
    const session = await app.inject({
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers["set-auth-jwt"]).toBeUndefined();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

// F-02: rate limits are per browser, not per web container. The web proxy
// reaches the API from a private address; a direct caller from a public one.
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const WEB_HOP = "10.0.3.4";
const DIRECT = "203.0.113.50";

describe.skipIf(!enabled)("Client address for rate limits", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  beforeAll(async () => {
    app = await buildServer();
  });
  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // Public registration is refused (403) behind the 20/min auth route limit,
  // so this counts only the Fastify limiter.
  const disabledAuth = (remoteAddress: string, headers = {}) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress,
      headers: { origin, ...headers },
      payload: {},
    });

  it("gives clients forwarded by the web hop separate buckets", async () => {
    const a = { "x-orbit-client-ip": "198.51.100.1" };
    for (let i = 0; i < 20; i++)
      expect((await disabledAuth(WEB_HOP, a)).statusCode).toBe(403);
    expect((await disabledAuth(WEB_HOP, a)).statusCode).toBe(429);
    expect(
      (await disabledAuth(WEB_HOP, { "x-orbit-client-ip": "198.51.100.2" }))
        .statusCode,
    ).toBe(403);
    // The same client over IPv4-mapped IPv6 is the same bucket.
    expect(
      (
        await disabledAuth(`::ffff:${WEB_HOP}`, {
          "x-orbit-client-ip": "::ffff:198.51.100.1",
        })
      ).statusCode,
    ).toBe(429);
  });

  it("ignores the header from a direct caller, so it cannot pick a bucket", async () => {
    // Not the exhausted bucket of 198.51.100.1 ...
    expect(
      (await disabledAuth(DIRECT, { "x-orbit-client-ip": "198.51.100.1" }))
        .statusCode,
    ).toBe(403);
    // ... and no fresh bucket per invented address.
    for (let i = 2; i <= 20; i++)
      expect(
        (
          await disabledAuth(DIRECT, {
            "x-orbit-client-ip": `198.51.100.${100 + i}`,
            "x-forwarded-for": `198.51.100.${200 + i}`,
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (await disabledAuth(DIRECT, { "x-orbit-client-ip": "198.51.100.99" }))
        .statusCode,
    ).toBe(429);
  });

  it("keys the web hop's own bucket when it forwards no valid address", async () => {
    const hop = "10.0.3.5";
    for (let i = 0; i < 20; i++)
      expect(
        (
          await disabledAuth(hop, {
            "x-orbit-client-ip": i % 2 ? "not-an-ip" : "",
          })
        ).statusCode,
      ).toBe(403);
    expect((await disabledAuth(hop)).statusCode).toBe(429);
  });

  it("gives Better Auth's sign-in limit the same client address", async () => {
    const email = randomUUID() + "@example.invalid";
    const signIn = (remoteAddress: string, headers = {}) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress,
        headers: { origin, ...headers },
        payload: { email, password: "wrong-password-123" },
      });
    const a = { "x-orbit-client-ip": "198.51.100.11" };
    // Better Auth allows 3 sign-ins per 10 seconds and address.
    for (let i = 0; i < 3; i++)
      expect((await signIn(WEB_HOP, a)).statusCode).toBe(401);
    expect((await signIn(WEB_HOP, a)).statusCode).toBe(429);
    expect(
      (await signIn(WEB_HOP, { "x-orbit-client-ip": "198.51.100.12" }))
        .statusCode,
    ).toBe(401);
    // A direct caller naming the limited client, in either header, is not it.
    expect(
      (
        await signIn("203.0.113.51", {
          ...a,
          "x-forwarded-for": "198.51.100.11",
        })
      ).statusCode,
    ).toBe(401);
  });

  it("does not store the client address with the session", async () => {
    const password = randomBytes(24).toString("base64url");
    const { user } = await makeAuth().api.signUpEmail({
      body: {
        email: randomUUID() + "@example.invalid",
        name: "Synthetic client-ip user",
        password,
      },
    });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: WEB_HOP,
        headers: { origin, "x-orbit-client-ip": "198.51.100.21" },
        payload: { email: user.email, password },
      });
      expect(r.statusCode).toBe(200);
      const sessions = await authDb.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions.map((s) => s.ipAddress)).toEqual([""]);
    } finally {
      await authDb.user.delete({ where: { id: user.id } });
    }
  });
});

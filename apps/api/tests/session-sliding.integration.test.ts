import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const EIGHT_HOURS = 8 * 3600;

/**
 * The session slides (8 hours, renewed every 30 minutes of use), but the
 * renewal stayed in the database: the browser kept the sign-in cookie and
 * dropped it 8 hours after sign-in, also during work (production 2026-10-06).
 */
describe.skipIf(!enabled)("Sliding sign-in session", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId: string;
  let cookie: string;
  const origin = process.env.APP_ORIGIN!;
  // The session as if it was last renewed 31 minutes ago.
  const ageSession = () =>
    authDb.session.updateMany({
      where: { userId },
      data: {
        expiresAt: new Date(Date.now() + (EIGHT_HOURS - 31 * 60) * 1000),
      },
    });
  const sessionCookie = (header: string | string[] | undefined) =>
    (Array.isArray(header) ? header : header ? [header] : []).find((value) =>
      /orbit\.session_token=/.test(value),
    );

  beforeAll(async () => {
    app = await buildServer();
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    userId = (
      await makeAuth().api.signUpEmail({
        body: { email, name: "Synthetic session user", password },
      })
    ).user.id;
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const cookies = signIn.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((value) => value!.split(";")[0])
      .join("; ");
  });
  afterAll(async () => {
    await authDb.user.deleteMany({ where: { id: userId } });
    await app?.close();
    await closeDatabase();
  });

  it("returns the renewed sign-in cookie when a request renews the session", async () => {
    await ageSession();
    const response = await app.inject({ url: "/api/me", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const renewed = sessionCookie(response.headers["set-cookie"]);
    expect(renewed).toBeDefined();
    expect(renewed).toMatch(new RegExp(`Max-Age=${EIGHT_HOURS}`));
    expect(renewed).toMatch(/HttpOnly/i);
    expect(renewed).toMatch(/SameSite=Lax/i);
    const session = await authDb.session.findFirstOrThrow({
      where: { userId },
    });
    expect(session.expiresAt.valueOf()).toBeGreaterThan(
      Date.now() + (EIGHT_HOURS - 60) * 1000,
    );
  });

  it("sets no cookie when the session is not due for renewal", async () => {
    const response = await app.inject({ url: "/api/me", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(sessionCookie(response.headers["set-cookie"])).toBeUndefined();
  });

  it("still refuses a request without a session", async () => {
    expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
  });
});

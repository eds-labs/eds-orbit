import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { buildServer } from "../src/server.ts";
import { connectionSecret } from "../src/platform/connections/central.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { grantSocialApp, META_APP_SECRET } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PATH = "/api/callbacks/social/meta-data-deletion";

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function signedRequest(payload: object, secret = META_APP_SECRET.appSecret) {
  const body = b64url(JSON.stringify(payload));
  return `${b64url(createHmac("sha256", secret).update(body).digest())}.${body}`;
}

/**
 * Meta's data-deletion callback (ADR 0020, S2 Task 11): a signed request
 * from Meta disconnects every account of that Meta user, in every project;
 * Meta gets a confirmation code. Exists only with ORBIT_PUBLIC_INGRESS.
 */
describe.skipIf(!enabled)("Meta data-deletion callback", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let a: Awaited<ReturnType<typeof createSocialProject>>;
  let b: Awaited<ReturnType<typeof createSocialProject>>;
  let cleanupApp: () => Promise<unknown>;
  const metaUserId = `meta-user-${randomUUID()}`;

  const page = (project: typeof a, id: string, user = metaUserId) =>
    saveConnectedAccount(project.owner, {
      platform: "facebook",
      externalId: id,
      handle: `Page ${id}`,
      displayName: `Page ${id}`,
      secret: JSON.stringify({ pageToken: `page-token-${id}` }),
      config: { metaUserId: user, pageId: id },
    });
  const post = (body: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: PATH,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      payload: body,
    });
  const status = (project: typeof a, id: string) =>
    project.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id } }));

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    app = await buildServer();
    a = await createSocialProject();
    b = await createSocialProject({ name: "Synthetic social B" });
    cleanupApp = (await grantSocialApp(a, "social.app.meta", META_APP_SECRET)).cleanup;
  });
  beforeEach(() => {
    process.env.ORBIT_SOCIAL = "true";
    process.env.ORBIT_PUBLIC_INGRESS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    await authDb.connection.deleteMany({ where: { projectId: { in: [a.owner.projectId, b.owner.projectId] } } });
    await cleanupApp?.();
    await a?.cleanup();
    await b?.cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("disconnects the Meta user's accounts in every project and returns a confirmation code", async () => {
    const one = await page(a, "301");
    const two = await page(b, "302");
    const other = await page(a, "303", "someone-else");
    const response = await post(
      `signed_request=${signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), user_id: metaUserId })}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.confirmation_code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(body.url).toBe(`${new URL(process.env.APP_ORIGIN!).origin}/social/data-deletion?code=${body.confirmation_code}`);
    expect(await status(a, one.accountId)).toMatchObject({ status: "disabled" });
    expect(await status(b, two.accountId)).toMatchObject({ status: "disabled" });
    expect(await status(a, other.accountId)).toMatchObject({ status: "active" });
    const row = await status(a, one.accountId);
    expect(await a.run((tx) => connectionSecret(tx, row.connectionId))).toBeNull();
    const audits = await a.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: a.owner.projectId, action: "social.meta.data_deletion" } }),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(metaUserId);
  });

  it("refuses a wrong signature and changes nothing", async () => {
    const kept = await page(a, "311");
    const response = await post(
      `signed_request=${signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), user_id: metaUserId }, "wrong-secret-0123456789")}`,
    );
    expect(response.statusCode).toBe(400);
    expect(await status(a, kept.accountId)).toMatchObject({ status: "active" });
  });

  it("refuses an old request", async () => {
    const response = await post(
      `signed_request=${signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000) - 2 * 86400, user_id: metaUserId })}`,
    );
    expect(response.statusCode).toBe(400);
  });

  it("refuses an unexpected algorithm and a malformed body", async () => {
    const wrong = await post(
      `signed_request=${signedRequest({ algorithm: "NONE", issued_at: Math.floor(Date.now() / 1000), user_id: metaUserId })}`,
    );
    expect(wrong.statusCode).toBe(400);
    expect((await post("signed_request=garbage")).statusCode).toBe(400);
    expect((await post("")).statusCode).toBe(400);
  });

  it("does not exist while public ingress is off", async () => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
    expect((await post("signed_request=x")).statusCode).toBe(404);
  });

  it("refuses large bodies", async () => {
    expect((await post(`signed_request=${"a".repeat(20_000)}`)).statusCode).toBe(413);
  });
});

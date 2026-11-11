import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { buildServer } from "../src/server.ts";
import { connectionSecret } from "../src/platform/connections/central.ts";
import { saveGrant } from "../src/modules/ads/accounts/vault.ts";
import { ADS_META_APP, createAdsProject, expectNoSecret, grantAdsMetaApp, type AdsProject } from "./support/ads-fixtures.ts";
import { META_APP_SECRET } from "./support/social-apps.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PATH = "/api/callbacks/ads/meta-data-deletion";

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function signedRequest(payload: object, secret: string = ADS_META_APP.appSecret) {
  const body = b64url(JSON.stringify(payload));
  return `${b64url(createHmac("sha256", secret).update(body).digest())}.${body}`;
}
const fresh = (userId: string, over: object = {}) => ({
  algorithm: "HMAC-SHA256",
  issued_at: Math.floor(Date.now() / 1000),
  user_id: userId,
  ...over,
});

/**
 * Meta's data-deletion callback for the ads app (ADR 0025, A3 Task 7): a
 * request signed with the ads app's secret unlinks every ad account of that
 * Meta user in every organization and wipes the tokens. Social's app secret
 * does not verify here. Exists only with ORBIT_PUBLIC_INGRESS.
 */
describe.skipIf(!enabled)("ads Meta data-deletion callback", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let a: AdsProject;
  let b: AdsProject;
  const cleanups: Array<() => Promise<unknown>> = [];
  const metaUserId = `meta-user-${randomUUID()}`;
  const secrets: string[] = [];

  /** A connection of the Meta user with one linked ad account, written like a finished connect + assign. */
  const linked = async (project: AdsProject, appConnectionId: string, externalId: string, user = metaUserId) => {
    const token = `EAABdeletion${randomUUID().replaceAll("-", "")}`;
    secrets.push(token);
    const grant = {
      userId: user,
      userName: null,
      accessToken: token,
      tokenType: "long_lived",
      expiresAt: null,
      grantedScopes: ["ads_read"],
    };
    const { connectionId } = await saveGrant(project.owner, grant as never, appConnectionId);
    const account = await project.run((tx) =>
      tx.adAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          provider: "meta",
          externalId,
          name: `Account ${externalId}`,
          currency: "EUR",
          timezone: "Europe/Berlin",
          connectionId,
          createdBy: project.ids.owner,
        },
      }),
    );
    return { connectionId, accountId: account.id };
  };
  const post = (body: string) =>
    app.inject({
      method: "POST",
      url: PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: body,
    });
  const accountOf = (project: AdsProject, id: string) => project.run((tx) => tx.adAccount.findUniqueOrThrow({ where: { id } }));
  const auditOf = (project: AdsProject) =>
    project.run((tx) => tx.auditEvent.findMany({ where: { projectId: project.projectId, action: "ads.meta.data_deletion" } }));

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_ADS = "true";
    app = await buildServer();
    a = await createAdsProject({ app });
    b = await createAdsProject({ app, name: "Synthetic ads B" });
    cleanups.push(() => a.cleanup(), () => b.cleanup());
    for (const project of [a, b]) cleanups.push((await grantAdsMetaApp(project)).cleanup);
  });
  beforeEach(() => {
    process.env.ORBIT_ADS = "true";
    process.env.ORBIT_PUBLIC_INGRESS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    await authDb.connection.deleteMany({ where: { projectId: { in: [a.projectId, b.projectId] } } });
    for (const cleanup of cleanups.reverse()) await cleanup?.();
    await app?.close();
    await closeDatabase();
  });

  const appOf = async (project: AdsProject) =>
    (await authDb.connection.findFirstOrThrow({
      where: { provider: "ads.app.meta", grants: { some: { workspaceId: project.workspaceId } } },
      select: { id: true },
    })).id;

  it("unlinks the Meta user's accounts in every organization and returns a confirmation code", async () => {
    const one = await linked(a, await appOf(a), "act_401");
    const two = await linked(b, await appOf(b), "act_402");
    const other = await linked(a, await appOf(a), "act_403", "someone-else");
    const response = await post(`signed_request=${signedRequest(fresh(metaUserId))}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.confirmation_code).toMatch(/^[a-f0-9]{42}$/);
    expect(body.url).toBe(`${new URL(process.env.APP_ORIGIN!).origin}/data-deletion/ads?code=${body.confirmation_code}`);
    expect(await accountOf(a, one.accountId)).toMatchObject({ status: "unlinked", writesEnabled: false });
    expect(await accountOf(b, two.accountId)).toMatchObject({ status: "unlinked" });
    expect(await accountOf(a, other.accountId)).toMatchObject({ status: "active" });
    // Tokens are gone; the other user's connection keeps its token.
    expect(await a.run((tx) => connectionSecret(tx, one.connectionId))).toBeNull();
    expect(await b.run((tx) => connectionSecret(tx, two.connectionId))).toBeNull();
    expect(await a.run((tx) => connectionSecret(tx, other.connectionId))).not.toBeNull();
    // One audit row per unlinked account, carrying only the code.
    const audits = await auditOf(a);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: "meta-data-deletion", resourceId: one.accountId, metadata: { confirmationCode: body.confirmation_code } });
    expect(await auditOf(b)).toHaveLength(1);
    expectNoSecret({ audits, body: response.body }, [metaUserId, ...secrets]);
  });

  it("still unlinks while the ads module is off in the project", async () => {
    const off = await createAdsProject({ app, name: "Synthetic ads off", enabled: false });
    cleanups.push(() => off.cleanup());
    const granted = await grantAdsMetaApp(off);
    cleanups.push(granted.cleanup);
    const user = `meta-user-${randomUUID()}`;
    const kept = await linked(off, granted.connectionId, "act_411", user);
    expect((await post(`signed_request=${signedRequest(fresh(user))}`)).statusCode).toBe(200);
    expect(await accountOf(off, kept.accountId)).toMatchObject({ status: "unlinked" });
  });

  it("shows the status of a confirmation code it issued, and nothing for any other code", async () => {
    const before = Date.now();
    const response = await post(`signed_request=${signedRequest(fresh(`nobody-${randomUUID()}`))}`);
    const code: string = response.json().confirmation_code;
    const lookup = (value: string) => app.inject({ method: "GET", url: `/api/public/ads/data-deletion/${value}` });
    const found = await lookup(code);
    expect(found.statusCode).toBe(200);
    expect(found.headers["cache-control"]).toBe("no-store");
    expect(found.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(found.json()).toEqual({ status: "completed", requestedAt: expect.any(String) });
    expect(Date.parse(found.json().requestedAt)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    const forged = code.slice(0, -1) + (code.endsWith("0") ? "1" : "0");
    const otherTime = code.slice(0, 18) + (code[18] === "0" ? "1" : "0") + code.slice(19);
    for (const value of [forged, otherTime, "abc", "z".repeat(42), code.slice(0, 41)])
      expect((await lookup(value)).statusCode).toBe(404);
    // Social's codes use another key: they are unknown here.
    delete process.env.ORBIT_PUBLIC_INGRESS;
    expect((await lookup(code)).statusCode).toBe(404);
  });

  it("refuses a request signed with Social's app secret or any other secret and changes nothing", async () => {
    const kept = await linked(a, await appOf(a), "act_421");
    for (const secret of [META_APP_SECRET.appSecret, "wrong-secret-0123456789"]) {
      const response = await post(`signed_request=${signedRequest(fresh(metaUserId), secret)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("ADS_SIGNED_REQUEST_INVALID");
    }
    expect(await accountOf(a, kept.accountId)).toMatchObject({ status: "active" });
    expect(await a.run((tx) => connectionSecret(tx, kept.connectionId))).not.toBeNull();
  });

  it("refuses an old request, an unexpected algorithm and malformed bodies", async () => {
    const old = await post(`signed_request=${signedRequest(fresh(metaUserId, { issued_at: Math.floor(Date.now() / 1000) - 2 * 86400 }))}`);
    expect(old.statusCode).toBe(400);
    const ahead = await post(`signed_request=${signedRequest(fresh(metaUserId, { issued_at: Math.floor(Date.now() / 1000) + 3600 }))}`);
    expect(ahead.statusCode).toBe(400);
    const wrong = await post(`signed_request=${signedRequest(fresh(metaUserId, { algorithm: "NONE" }))}`);
    expect(wrong.statusCode).toBe(400);
    const valid = signedRequest(fresh(metaUserId));
    expect((await post(`signed_request=${valid}.extra`)).statusCode).toBe(400);
    expect((await post("signed_request=a.b.c")).statusCode).toBe(400);
    expect((await post("signed_request=!!!.@@@")).statusCode).toBe(400);
    expect((await post("signed_request=garbage")).statusCode).toBe(400);
    expect((await post("")).statusCode).toBe(400);
  });

  it("does not exist while public ingress is off or the module is off for the installation", async () => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
    expect((await post("signed_request=x")).statusCode).toBe(404);
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    process.env.ORBIT_ADS = "false";
    const response = await post("signed_request=x");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ADS_DISABLED");
  });

  it("refuses large bodies", async () => {
    expect((await post(`signed_request=${"a".repeat(20_000)}`)).statusCode).toBe(413);
  });
});

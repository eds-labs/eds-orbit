import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { buildServer } from "../src/server.ts";
import { adsAppCredentials, adsAppReadiness } from "../src/modules/ads/accounts/app.ts";
import { centralProviders } from "../src/platform/administration/connections.ts";
import { registeredConnectionProvider } from "../src/platform/modules/contributions.ts";
import { ADS_META_APP, createAdsProject, expectNoSecret, grantAdsMetaApp, type AdsProject } from "./support/ads-fixtures.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * The ads Meta developer app (ADR 0025, A3 Task 2): a system connection
 * granted to an organization and a project; readiness is a boolean-only view.
 */
describe.skipIf(!enabled)("ads Meta developer app", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: AdsProject;
  const cleanups: Array<() => Promise<unknown>> = [];
  const fresh = async () => {
    const project = await createAdsProject({ app });
    cleanups.push(() => project.cleanup());
    return project;
  };

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_ADS = "true";
    app = await buildServer();
    p = await createAdsProject({ app });
  });
  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
    await p?.cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("is not_granted without the system connection and refuses credentials", async () => {
    const q = await fresh();
    expect(await q.run((tx) => adsAppReadiness(tx, q.owner))).toBe("not_granted");
    await expect(q.run((tx) => adsAppCredentials(tx, q.owner))).rejects.toMatchObject({ code: "ADS_META_APP_NOT_GRANTED", status: 409 });
  });

  it("is project_not_granted with only the organization grant", async () => {
    const q = await fresh();
    const granted = await grantAdsMetaApp(q, ADS_META_APP, { project: false });
    cleanups.push(granted.cleanup);
    expect(await q.run((tx) => adsAppReadiness(tx, q.owner))).toBe("project_not_granted");
  });

  it("is ready with the project grant and resolves the parsed secret", async () => {
    const q = await fresh();
    const granted = await grantAdsMetaApp(q);
    cleanups.push(granted.cleanup);
    expect(await q.run((tx) => adsAppReadiness(tx, q.owner))).toBe("ready");
    expect(await q.run((tx) => adsAppCredentials(tx, q.owner))).toEqual({
      connectionId: granted.connectionId,
      clientId: ADS_META_APP.appId,
      clientSecret: ADS_META_APP.appSecret,
      configId: ADS_META_APP.configId,
    });
  });

  it("is invalid when the stored secret is malformed", async () => {
    const q = await fresh();
    const granted = await grantAdsMetaApp(q);
    cleanups.push(granted.cleanup);
    const { sealSecret } = await import("../src/platform/connections/secrets.ts");
    await authDb.connectionSecret.updateMany({
      where: { connectionId: granted.connectionId, state: "active" },
      data: sealSecret("not json at all"),
    });
    expect(await q.run((tx) => adsAppReadiness(tx, q.owner))).toBe("invalid");
    await expect(q.run((tx) => adsAppCredentials(tx, q.owner))).rejects.toMatchObject({ code: "ADS_META_APP_INVALID", status: 500 });
  });

  it("registers both providers; the administration lists only the system app", () => {
    expect(registeredConnectionProvider("ads.app.meta")).toMatchObject({ scopes: ["system"], owner: "ads" });
    expect(registeredConnectionProvider("ads.account.meta")).toMatchObject({ managedByModule: true, owner: "ads" });
    const listed = centralProviders();
    expect(listed.find((x) => x.id === "ads.app.meta")).toMatchObject({
      purposes: ["ads_oauth"],
      checkable: true,
      callbackPath: "/api/ads/oauth/callback/meta",
    });
    expect(listed.find((x) => x.id === "ads.account.meta")).toBeUndefined();
    expectNoSecret(listed, [ADS_META_APP.appSecret]);
  });

  it("the generic connector action refuses the module-managed provider", async () => {
    const response = await p.call("owner", "POST", "/actions/connector", {
      provider: "ads.account.meta",
      credential: "plain-credential-0123456789",
    });
    expect(response.statusCode).toBe(400);
    expectNoSecret(response.body, ["plain-credential-0123456789"]);
  });
});

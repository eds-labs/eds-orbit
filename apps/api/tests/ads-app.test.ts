import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { metaAdsAppSecret, adsRedirectUri } from "../src/modules/ads/accounts/app.ts";
import { adsConnectionProviders } from "../src/modules/ads/accounts/providers.ts";
import { graphError, installFakeMetaGraph } from "./support/fake-meta-graph.ts";

const SECRET = { appId: "2234567890", appSecret: "ads-app-secret-0123456789", configId: "8876543210" };
const app = adsConnectionProviders["ads.app.meta"]!;

describe("ads Meta app secret", () => {
  it("accepts the fixture and refuses extra keys, short secrets and bad ids", () => {
    expect(metaAdsAppSecret.safeParse(SECRET).success).toBe(true);
    expect(metaAdsAppSecret.safeParse({ ...SECRET, extra: "x" }).success).toBe(false);
    expect(metaAdsAppSecret.safeParse({ ...SECRET, appSecret: "short" }).success).toBe(false);
    expect(metaAdsAppSecret.safeParse({ ...SECRET, appId: "12" }).success).toBe(false);
    expect(metaAdsAppSecret.safeParse({ ...SECRET, configId: "abc" }).success).toBe(false);
  });

  it("validateSecret refuses malformed input with 422 and never echoes it", () => {
    expect(() => app.validateSecret!(JSON.stringify(SECRET))).not.toThrow();
    for (const bad of ["not json ads-app-secret-0123456789", JSON.stringify({ ...SECRET, appSecret: "tiny" })]) {
      try {
        app.validateSecret!(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "ADS_META_APP_INVALID", status: 422 });
        expect(JSON.stringify(error) + String((error as Error).message)).not.toContain("ads-app-secret");
      }
    }
  });

  it("builds the callback URL on the web origin", () => {
    expect(adsRedirectUri({ APP_ORIGIN: "https://orbit.example.com/some/path" })).toBe(
      "https://orbit.example.com/api/ads/oauth/callback/meta",
    );
  });

  it("declares the system app and the module-managed ad access", () => {
    expect(app).toMatchObject({ scopes: ["system"], purposes: ["ads_oauth"], callbackPath: "/api/ads/oauth/callback/meta" });
    expect(app.secretFields!.map((f) => [f.key, f.secret === true])).toEqual([["appId", false], ["appSecret", true], ["configId", false]]);
    expect(adsConnectionProviders["ads.account.meta"]).toMatchObject({
      scopes: ["project"],
      managedByModule: true,
      purposes: ["ads_manage"],
      checkUnsupported: "ADS_CONNECTION_CHECK_IN_MODULE",
    });
  });
});

describe("ads Meta app check", () => {
  const fake = installFakeMetaGraph();

  it("sends one GET with header auth and appsecret_proof, no secret in the URL", async () => {
    fake.on("GET", "/2234567890", { json: { id: "2234567890", name: "Synthetic app" } });
    const result = await app.check!({}, JSON.stringify(SECRET));
    expect(result).toEqual({ status: "read_verified", capabilities: ["ads_oauth"] });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    const token = `${SECRET.appId}|${SECRET.appSecret}`;
    expect(request).toMatchObject({ method: "GET", path: "/2234567890", authorization: `Bearer ${token}` });
    expect(request!.query.get("fields")).toBe("id,name");
    expect(request!.query.get("appsecret_proof")).toBe(createHmac("sha256", SECRET.appSecret).update(token).digest("hex"));
    expect(request!.query.toString()).not.toContain(SECRET.appSecret);
    expect(request!.query.has("access_token")).toBe(false);
  });

  it("maps a Graph failure to ADS_META_APP_CHECK_FAILED without the secret", async () => {
    fake.on("GET", "/2234567890", graphError(400, 190));
    try {
      await app.check!({}, JSON.stringify(SECRET));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "ADS_META_APP_CHECK_FAILED", status: 409 });
      expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(SECRET.appSecret);
    }
  });
});

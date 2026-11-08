import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { appSecretProof, createMetaGraphClient } from "../src/modules/ads/providers/meta/graph.ts";
import { setMetaAdsFetchForTests } from "../src/modules/ads/providers/meta/transport.ts";
import { AdsProviderError } from "../src/modules/ads/providers/types.ts";
import { afterCommit, createFakeMetaGraph, graphError, sequence, usageHeaders } from "./support/fake-meta-graph.ts";

const credentials = { accessToken: "test-access-token-0001", appSecret: "test-app-secret-0123456789" };
const PROOF = "a220b78fcb7c0e661a88e7a04803dff413c58eb8f7506d633c6f9d600f3083f4";
const any = z.object({ ok: z.boolean() });

let current: ReturnType<typeof createFakeMetaGraph> | null = null;
function setup() {
  const fake = createFakeMetaGraph();
  current = fake;
  setMetaAdsFetchForTests(fake.fetch);
  return { fake, client: createMetaGraphClient(credentials) };
}
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(AdsProviderError); return error as AdsProviderError; }
  throw new Error("expected failure");
}

afterEach(() => {
  setMetaAdsFetchForTests(null);
  const misses = current?.misses ?? [];
  current = null;
  expect(misses).toEqual([]);
});

describe("meta graph client", () => {
  it("sends the token only in the authorization header", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1", { json: { ok: true } });
    await client.get("/act_1", { fields: "id" }, any);
    const r = fake.requests[0]!;
    expect(r.authorization).toBe("Bearer test-access-token-0001");
    expect(`${r.path}?${r.query}`).not.toContain(credentials.accessToken);
    expect(r.query.has("access_token")).toBe(false);
  });

  it("signs every call", async () => {
    const { fake, client } = setup();
    expect(appSecretProof(credentials.accessToken, credentials.appSecret)).toBe(PROOF);
    fake.on("GET", "/act_1", { json: { ok: true } });
    fake.on("POST", "/act_1/campaigns", { json: { ok: true } });
    await client.get("/act_1", {}, any);
    await client.post("/act_1/campaigns", { name: "x" }, any);
    expect(fake.requests[0]!.query.get("appsecret_proof")).toBe(PROOF);
    expect(fake.requests[1]!.form!.get("appsecret_proof")).toBe(PROOF);
  });

  it("calls the pinned version", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1", { json: { ok: true } });
    const seen: string[] = [];
    setMetaAdsFetchForTests(async (url, init) => { seen.push(String(url)); return fake.fetch(url, init); });
    await client.get("/act_1", {}, any);
    expect(seen.length).toBe(1);
    for (const url of seen) expect(url.startsWith("https://graph.facebook.com/v27.0/")).toBe(true);
  });

  it("posts a form with the proof in the body", async () => {
    const { fake, client } = setup();
    let contentType: string | null = null;
    setMetaAdsFetchForTests(async (url, init) => { contentType = new Headers(init?.headers).get("content-type"); return fake.fetch(url, init); });
    fake.on("POST", "/act_1/campaigns", { json: { ok: true } });
    await client.post("/act_1/campaigns", { name: "x" }, any);
    const r = fake.requests[0]!;
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(r.form!.get("name")).toBe("x");
    expect(r.form!.get("appsecret_proof")).toBe(PROOF);
    expect(r.form!.has("access_token")).toBe(false);
    expect(r.form!.toString()).not.toContain(credentials.accessToken);
    expect(r.query.toString()).toBe("");
  });

  it("refuses reserved or unsafe input", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1", { json: { ok: true } });
    await expect(client.get("/act_1", { access_token: "x" }, any)).rejects.toThrow(Error);
    await expect(client.post("/act_1", { appsecret_proof: "x" }, any)).rejects.toThrow(Error);
    await expect(client.get("/act_1/../me", {}, any)).rejects.toThrow(Error);
    await expect(client.get("/act_1?x=1", {}, any)).rejects.toThrow(Error);
    expect(fake.requests).toHaveLength(0);
  });

  it("pages by cursor and never follows next links", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1/campaigns", sequence(
      { json: { data: [{ id: "1" }], paging: { cursors: { after: "c2" }, next: "https://evil.example/x" } } },
      { json: { data: [{ id: "2" }], paging: { cursors: { after: "c3" } } } },
    ));
    const item = z.object({ id: z.string() });
    const first = await client.page("/act_1/campaigns", { limit: "1" }, item);
    expect(first.items).toEqual([{ id: "1" }]);
    expect(first.after).toBe("c2");
    const second = await client.page("/act_1/campaigns", { limit: "1" }, item, first.after);
    expect(second.items).toEqual([{ id: "2" }]);
    expect(second.after).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.method).toBe("GET");
    expect(fake.requests[1]!.path).toBe("/act_1/campaigns");
    expect(fake.requests[1]!.query.get("after")).toBe("c2");
  });

  it("classifies a Graph error", async () => {
    const { fake, client } = setup();
    fake.on("POST", "/act_1/campaigns", graphError(400, 100, { blame: [["special_ad_categories"]] }));
    const error = await failure(client.post("/act_1/campaigns", { name: "x" }, any));
    expect(error.failure.kind).toBe("validation");
    expect(error.failure.fieldPaths).toEqual(["special_ad_categories"]);
    for (const text of [JSON.stringify(error.failure), error.message]) {
      expect(text).not.toContain(credentials.accessToken);
      expect(text).not.toContain(credentials.appSecret);
    }
  });

  it("treats a lost write as unknown", async () => {
    const { fake, client } = setup();
    fake.on("POST", "/act_1/lost", { throw: new ConnectorError("REQUEST_TIMEOUT", "unknown") });
    const lost = await failure(client.post("/act_1/lost", {}, any));
    expect(lost.failure).toMatchObject({ outcome: "unknown", retryable: false });

    fake.on("GET", "/act_1/unsent", { throw: new ConnectorError("DNS_FAILED", "not_sent", true) });
    const unsent = await failure(client.get("/act_1/unsent", {}, any));
    expect(unsent.failure).toMatchObject({ outcome: "not_sent", retryable: true });

    let committed = false;
    fake.on("POST", "/act_1/commit", afterCommit(() => { committed = true; }, { status: 500 }));
    const after = await failure(client.post("/act_1/commit", {}, any));
    expect(committed).toBe(true);
    expect(after.failure.outcome).toBe("unknown");
  });

  it("rejects a 2xx body that fails the schema", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1", { json: { nope: 1 } });
    const error = await failure(client.get("/act_1", {}, any));
    expect(error.failure.code).toBe("ADS_PROVIDER_RESPONSE_INVALID");
  });

  it("returns usage with each answer", async () => {
    const { fake, client } = setup();
    fake.on("GET", "/act_1", { json: { ok: true }, headers: usageHeaders({ type: "ads_management", callCount: 80 }) });
    const answer = await client.get("/act_1", {}, any);
    expect(answer.usage.buckets).toEqual([expect.objectContaining({ bucket: "meta_ads_management", usagePct: 80 })]);
  });

  it("records a miss for an unregistered route", async () => {
    const { fake, client } = setup();
    await failure(client.get("/act_1/unregistered", {}, any));
    expect(fake.misses).toHaveLength(1);
    expect(fake.misses[0]).toContain("GET https://graph.facebook.com/v27.0/act_1/unregistered");
    fake.misses.length = 0;
  });

  it("refuses the test hook outside tests", () => {
    const { VITEST, NODE_ENV } = process.env;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      expect(() => setMetaAdsFetchForTests(null)).toThrow("test only");
    } finally {
      if (VITEST !== undefined) process.env.VITEST = VITEST;
      if (NODE_ENV !== undefined) process.env.NODE_ENV = NODE_ENV;
    }
  });
});

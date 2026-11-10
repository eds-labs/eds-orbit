import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { senderFor, type SendInput } from "../src/modules/social/adapters/registry.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Sending to Instagram (ADR 0020, S5) with a fake Graph API: containers,
 * processing, one media_publish per publication even across retries, the
 * daily quota, and no request at all without public media URLs.
 */
describe.skipIf(!enabled)("Instagram sender", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  type Call = { method: string; path: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  let reply: (call: Call) => Response = () => new Response("{}", { status: 500 });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ig = () => senderFor("instagram")!;
  const input = (over: Partial<SendInput> = {}): SendInput => ({
    publicationId: randomUUID(),
    credentials: { platform: "instagram", accessToken: "page-token", externalId: "17841", pageId: "99", config: { igUserId: "17841" } },
    account: { externalId: "17841", handle: "@orbit_ig", settings: {} },
    body: "We are live.",
    options: {},
    media: [{ fileId: "f1", bytes: new Uint8Array([1]), mime: "image/jpeg", width: 1080, height: 1080, publicUrl: "https://orbit.example/api/public/social/media/t1" }],
    providerState: {},
    ...over,
  });
  /** A Graph API whose containers report `states` in turn. */
  const graph = (states: string[], quota = { used: 0, total: 50 }) => {
    let container = 0;
    let poll = 0;
    reply = (call) => {
      if (call.path.endsWith("/content_publishing_limit"))
        return json(200, { data: [{ config: { quota_total: quota.total, quota_duration: 86400 }, quota_usage: quota.used }] });
      if (call.method === "POST" && call.path.endsWith("/17841/media")) return json(200, { id: `c${++container}` });
      if (call.method === "POST" && call.path.endsWith("/17841/media_publish")) return json(200, { id: "media-1" });
      if (call.method === "GET" && /\/c\d+$/.test(call.path))
        return json(200, { id: call.path.split("/").pop(), status_code: states[Math.min(poll++, states.length - 1)] });
      if (call.method === "GET" && call.path.endsWith("/media-1"))
        return json(200, { id: "media-1", permalink: "https://www.instagram.com/p/abc/" });
      return json(404, {});
    };
  };
  const publishes = () => calls.filter((c) => c.path.endsWith("/media_publish")).length;

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    setSocialFetchForTests(async (url, init = {}) => {
      const u = new URL(String(url));
      const raw = init.body ? String(init.body) : "";
      const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      const call = { method: String(init.method ?? "GET"), path: u.pathname, body };
      calls.push(call);
      return reply(call);
    });
  });
  afterEach(() => {
    calls = [];
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await p?.cleanup();
    await closeDatabase();
  });

  it("publishes a finished image once, with its permalink", async () => {
    graph(["FINISHED"]);
    expect(await ig().send(p.owner, input())).toEqual({
      kind: "published",
      externalPostId: "media-1",
      permalink: "https://www.instagram.com/p/abc/",
      providerState: { workflowId: expect.stringMatching(/^pub_/) },
    });
    expect(publishes()).toBe(1);
    const created = calls.find((c) => c.method === "POST" && c.path.endsWith("/17841/media"))!;
    expect(created.body).toMatchObject({ image_url: "https://orbit.example/api/public/social/media/t1", caption: "We are live." });
  });

  it("reports processing, then publishes on a later read-back exactly once", async () => {
    graph(["IN_PROGRESS", "FINISHED"]);
    const sent = input();
    const first = await ig().send(p.owner, sent);
    expect(first).toEqual({ kind: "processing", providerState: { workflowId: `pub_${sent.publicationId}` } });
    expect(publishes()).toBe(0);
    const since = new Date();
    expect(await ig().reconcile!(p.owner, { ...sent, since })).toMatchObject({ kind: "published", externalPostId: "media-1" });
    expect(await ig().reconcile!(p.owner, { ...sent, since })).toMatchObject({ kind: "published", externalPostId: "media-1" });
    expect(publishes()).toBe(1);
    // A second send of the same publication continues the workflow, never a new container.
    calls = [];
    await ig().send(p.owner, sent);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/17841/media"))).toHaveLength(0);
  });

  it("calls a failed container creation unknown and keeps the created ids", async () => {
    let n = 0;
    reply = (call) =>
      call.path.endsWith("/content_publishing_limit")
        ? json(200, { data: [{ config: { quota_total: 50 }, quota_usage: 0 }] })
        : call.method === "POST" && call.path.endsWith("/17841/media")
          ? n++ === 0
            ? json(200, { id: "c1" })
            : json(500, {})
          : json(404, {});
    const media = [1, 2].map((i) => ({ ...input().media[0]!, fileId: `f${i}` }));
    const result = await ig().send(p.owner, input({ media }));
    expect(result).toMatchObject({ kind: "unknown", providerState: { workflowId: expect.stringMatching(/^pub_/), containerIds: ["c1"] } });
  });

  it("waits while the daily quota is used up, before creating anything", async () => {
    graph(["FINISHED"], { used: 50, total: 50 });
    expect(await ig().send(p.owner, input())).toEqual({ kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 3_600_000 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("sends nothing without a public media URL", async () => {
    graph(["FINISHED"]);
    const media = [{ ...input().media[0]!, publicUrl: null }];
    expect(await ig().send(p.owner, input({ media }))).toEqual({ kind: "failed", code: "SOCIAL_MEDIA_PUBLIC_REQUIRED", retry: "never" });
    expect(calls).toHaveLength(0);
  });

  it("publishes a carousel as one post", async () => {
    graph(["FINISHED"]);
    const media = [1, 2, 3].map((i) => ({ ...input().media[0]!, fileId: `f${i}` }));
    expect(await ig().send(p.owner, input({ media }))).toMatchObject({ kind: "published", externalPostId: "media-1" });
    const created = calls.filter((c) => c.method === "POST" && c.path.endsWith("/17841/media"));
    expect(created.map((c) => c.body.media_type ?? "IMAGE")).toEqual(["IMAGE", "IMAGE", "IMAGE", "CAROUSEL"]);
    expect(publishes()).toBe(1);
  });

  it("asks for a reconnect when the token is refused", async () => {
    reply = () => json(401, {});
    expect(await ig().send(p.owner, input())).toMatchObject({ kind: "failed", retry: "after-reconnect" });
  });
});

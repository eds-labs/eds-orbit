import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data } from "../src/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { RECONCILE } from "../src/modules/social/dispatch/jobs.ts";
import { RECONCILE_DELAYS_MS, RECONCILE_MAX, reconcilePublication } from "../src/modules/social/dispatch/reconcile.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { createPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * After the send (ADR 0020 §7, S5): Instagram's processing is polled with a
 * backoff until it publishes (once) or is given up as unknown; an unknown X
 * or Instagram send is read back and confirmed when found, never resent.
 */
describe.skipIf(!enabled)("social reconcile", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  let image = "";
  type Call = { method: string; path: string };
  let calls: Call[] = [];
  let reply: (call: Call) => Response = () => new Response("{}", { status: 500 });
  const saved = { ...process.env };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const account = async (platform: "instagram" | "x") => {
    const externalId = platform === "instagram" ? "17841" : "42";
    const secret =
      platform === "instagram"
        ? { pageToken: "page-token" }
        : { accessToken: "x-token", refreshToken: null, expiresAt: null, scopes: ["tweet.write"] };
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform,
      externalId,
      handle: platform === "instagram" ? "@orbit_ig" : "@orbit_x",
      displayName: platform,
      secret: JSON.stringify(secret),
      config: platform === "instagram" ? { pageId: "99", igUserId: "17841" } : {},
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability: "write_verified" } }));
    return accountId;
  };
  /** A delivered publication of a one-account post (publish now). */
  const delivered = async (accountId: string, withImage: boolean) => {
    const post = await p.run((tx) =>
      createPost(tx, p.owner, { baseText: "We are live.", baseMedia: withImage ? [image] : [], variants: [{ accountId }] }),
    );
    const approved = await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    await dispatchPost(worker, post.id, approved.version);
    const variant = await p.run((tx) => tx.socialPostVariant.findFirstOrThrow({ where: { postId: post.id } }));
    const pub = await p.run((tx) => tx.socialPublication.findFirstOrThrow({ where: { variantId: variant.id } }));
    await deliverPublication(worker, pub.id);
    return pub.id;
  };
  const pub = (id: string) => p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id } }));
  const reconcileKeys = (id: string) =>
    p.run(async (tx) =>
      (await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" } }))
        .map((j) => data(j))
        .filter((j) => j.topic === RECONCILE && j.resourceId === id)
        .map((j) => String(j.idempotencyKey))
        .sort(),
    );
  /** A Graph API whose container reports `states` in turn. */
  const graph = (states: string[]) => {
    let poll = 0;
    reply = (call) => {
      if (call.path.endsWith("/content_publishing_limit")) return json(200, { data: [{ config: { quota_total: 50 }, quota_usage: 0 }] });
      if (call.method === "POST" && call.path.endsWith("/17841/media")) return json(200, { id: "c1" });
      if (call.method === "POST" && call.path.endsWith("/17841/media_publish")) return json(200, { id: "media-1" });
      if (call.method === "GET" && call.path.endsWith("/c1")) return json(200, { id: "c1", status_code: states[Math.min(poll++, states.length - 1)] });
      if (call.method === "GET" && call.path.endsWith("/media-1")) return json(200, { id: "media-1", permalink: "https://www.instagram.com/p/abc/" });
      return json(404, {});
    };
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ORBIT_PUBLIC_INGRESS: "true",
      ORBIT_SOCIAL_MEDIA_PUBLIC: "true",
      EXECUTION_MODE: "live",
      ENABLE_EXTERNAL_WRITES: "true",
      ORBIT_SOCIAL_PLATFORMS: "x,instagram",
    });
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    image = (await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" })).id;
    setSocialFetchForTests(async (url, init = {}) => {
      const call = { method: String(init.method ?? "GET"), path: new URL(String(url)).pathname };
      calls.push(call);
      return reply(call);
    });
  });
  afterEach(() => {
    calls = [];
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS", "ORBIT_PUBLIC_INGRESS", "ORBIT_SOCIAL_MEDIA_PUBLIC"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await p?.cleanup();
    await closeDatabase();
  });

  it("polls Instagram's processing with a backoff and publishes once", async () => {
    graph(["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    const id = await delivered(await account("instagram"), true);
    expect((await pub(id)).status).toBe("processing");
    expect(await reconcileKeys(id)).toEqual([`social-reconcile:${id}:1`]);
    await reconcilePublication(worker, id, 1);
    expect((await pub(id)).status).toBe("processing");
    expect(await reconcileKeys(id)).toContain(`social-reconcile:${id}:2`);
    await reconcilePublication(worker, id, 2);
    expect(await pub(id)).toMatchObject({ status: "published", externalPostId: "media-1", permalink: "https://www.instagram.com/p/abc/" });
    expect(calls.filter((c) => c.path.endsWith("/media_publish"))).toHaveLength(1);
    const reads = await p.run((tx) => tx.socialDeliveryAttempt.findMany({ where: { publicationId: id, step: "status" } }));
    expect(reads).toHaveLength(2);
  });

  it("gives up after the last poll as an unknown outcome", async () => {
    graph(["IN_PROGRESS"]);
    const id = await delivered(await account("instagram"), true);
    await reconcilePublication(worker, id, RECONCILE_MAX);
    expect((await pub(id)).status).toBe("outcome_unknown");
    expect(calls.filter((c) => c.path.endsWith("/media_publish"))).toHaveLength(0);
  });

  it("confirms an unknown X send it can read back, and never posts again", async () => {
    reply = (call) =>
      call.path.endsWith("/2/tweets")
        ? json(503, {})
        : call.path.endsWith("/2/users/42/tweets")
          ? json(200, { data: [{ id: "301", text: "We are live.", author_id: "42", created_at: new Date().toISOString() }] })
          : json(404, {});
    const id = await delivered(await account("x"), false);
    expect((await pub(id)).status).toBe("outcome_unknown");
    expect(await reconcileKeys(id)).toEqual([`social-reconcile:${id}:unknown`]);
    await reconcilePublication(worker, id, "unknown");
    expect(await pub(id)).toMatchObject({
      status: "published",
      externalPostId: "301",
      resolution: "published_confirmed",
      resolvedBy: "system",
      permalink: "https://x.com/orbit_x/status/301",
    });
    expect(calls.filter((c) => c.path.endsWith("/2/tweets"))).toHaveLength(1);
  });

  it("leaves an unknown send to the owner when the read-back finds nothing", async () => {
    reply = (call) => (call.path.endsWith("/2/tweets") ? json(503, {}) : call.path.includes("/2/users/") ? json(200, { data: [] }) : json(404, {}));
    const id = await delivered(await account("x"), false);
    await reconcilePublication(worker, id, "unknown");
    expect((await pub(id)).status).toBe("outcome_unknown");
    expect(calls.filter((c) => c.path.endsWith("/2/tweets"))).toHaveLength(1);
  });

  it("waits longer between polls, at most 15 minutes", () => {
    expect([1, 2, 3, 4, 7, 12].map(RECONCILE_DELAYS_MS)).toEqual([15_000, 30_000, 60_000, 120_000, 900_000, 900_000]);
    expect(RECONCILE_MAX).toBe(12);
  });

  it("ignores a read-back for a publication that is no longer waiting", async () => {
    expect(await reconcilePublication(worker, randomUUID(), 1)).toEqual({ status: "succeeded", errorCode: "NOT_FOUND" });
  });
});

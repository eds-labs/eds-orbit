import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { data } from "../src/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { requestWriteVerification } from "../src/modules/social/accounts/verify-write.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { DISPATCH, RECONCILE } from "../src/modules/social/dispatch/jobs.ts";
import { reconcilePublication } from "../src/modules/social/dispatch/reconcile.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { createPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * Facebook Pages through the dispatcher (ADR 0020, S5b): a live post with
 * an image goes out as one unpublished photo plus one /feed call, without
 * public media URLs; an unclear /feed answer is read back, never resent;
 * the approved test post makes the Page write-verified.
 */
describe.skipIf(!enabled)("social facebook delivery", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  let image = "";
  type Call = { method: string; path: string; body: unknown };
  let calls: Call[] = [];
  let reply: (call: Call) => Response = () => new Response("{}", { status: 500 });
  const saved = { ...process.env };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** A connected Facebook Page with its Page token in the vault. */
  const page = async (capability = "write_verified") => {
    const pageId = String(Math.floor(Math.random() * 1e12));
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "facebook",
      externalId: pageId,
      handle: "Orbit Page",
      displayName: "Orbit Page",
      secret: JSON.stringify({ pageToken: "page-token" }),
      config: { metaUserId: "7", pageId, appConnectionId: randomUUID() },
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability } }));
    return { accountId, pageId };
  };
  /** A publish-now post to one account, dispatched and delivered: its publication. */
  const delivered = async (accountId: string, text: string, withImage: boolean) => {
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: text, baseMedia: withImage ? [image] : [], variants: [{ accountId }] }));
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
        .map((j) => String(j.idempotencyKey)),
    );

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTION_MODE: "live",
      ENABLE_EXTERNAL_WRITES: "true",
      ORBIT_SOCIAL_PLATFORMS: "facebook",
    });
    delete process.env.ORBIT_SOCIAL_MEDIA_PUBLIC;
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    image = (await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" })).id;
    setSocialFetchForTests(async (url, init = {}) => {
      const call = { method: String(init.method ?? "GET"), path: new URL(String(url)).pathname, body: init.body };
      calls.push(call);
      return reply(call);
    });
  });
  afterEach(() => {
    calls = [];
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS", "ORBIT_SOCIAL_MEDIA_PUBLIC"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await p?.cleanup();
    await closeDatabase();
  });

  it("posts an image and a text as one Page post, without public media URLs", async () => {
    const { accountId, pageId } = await page();
    reply = (call) => (call.path.endsWith("/photos") ? json(200, { id: "ph1" }) : json(200, { id: `${pageId}_1` }));
    const id = await delivered(accountId, "We are live.", true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /v26.0/${pageId}/photos`, `POST /v26.0/${pageId}/feed`]);
    // The library keeps an opaque PNG as a JPEG original (S3): that file goes up.
    const asset = await p.run((tx) => tx.socialMediaAsset.findUniqueOrThrow({ where: { id: image } }));
    const source = (calls[0]!.body as FormData).get("source") as Blob;
    expect([source.type, source.size]).toEqual([asset.mime, asset.size]);
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ message: "We are live.", attached_media: [{ media_fbid: "ph1" }] });
    expect(await pub(id)).toMatchObject({
      status: "published",
      externalPostId: `${pageId}_1`,
      permalink: `https://www.facebook.com/${pageId}_1`,
    });
  });

  it("reads an unclear post back instead of sending it again", async () => {
    const { accountId, pageId } = await page();
    reply = () => {
      throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
    };
    const text = `Unclear ${randomUUID()}`;
    const id = await delivered(accountId, text, false);
    expect((await pub(id)).status).toBe("outcome_unknown");
    expect(await reconcileKeys(id)).toEqual([`social-reconcile:${id}:unknown`]);
    reply = () => json(200, { data: [{ id: `${pageId}_9`, message: text, created_time: new Date().toISOString().replace("Z", "+0000") }] });
    await reconcilePublication(worker, id, "unknown");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await pub(id)).toMatchObject({ status: "published", externalPostId: `${pageId}_9` });
  });

  it("marks the Page write-verified once the approved test post is out", async () => {
    const { accountId, pageId } = await page("read_verified");
    reply = () => json(200, { id: `${pageId}_5` });
    const { requestId } = await p.run((tx) => requestWriteVerification(tx, p.owner, accountId, { version: 1, text: "Orbit connection test" }));
    const row = await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } }));
    await p.run((tx) => decideActionRequest(tx, p.owner, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" }));
    const job = (await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "desc" } })))
      .map((j) => data(j))
      .find((j) => j.topic === DISPATCH)!;
    await dispatchPost(worker, String(job.resourceId), Number(job.postVersion));
    const variant = await p.run((tx) => tx.socialPostVariant.findFirstOrThrow({ where: { postId: String(job.resourceId) } }));
    const publication = await p.run((tx) => tx.socialPublication.findFirstOrThrow({ where: { variantId: variant.id } }));
    await deliverPublication(worker, publication.id);
    expect(await pub(publication.id)).toMatchObject({ status: "published", externalPostId: `${pageId}_5` });
    expect((await p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id: accountId } }))).capability).toBe("write_verified");
  });
});

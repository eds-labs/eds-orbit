import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { applyAiLabel, provenanceXmp, verifyAiLabel, type RelBox } from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  imageProvenance,
  labelFinalImage,
  recordImageProvenance,
  recordUnlabeledSource,
} from "../src/platform/provenance/image-provenance.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { importOriginMedia } from "../src/modules/social/contract.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { reconcilePublication } from "../src/modules/social/dispatch/reconcile.ts";
import { mediaContent, uploadMedia } from "../src/modules/social/media/library.ts";
import { publicMediaUrl, servePublicMedia } from "../src/modules/social/media/public-url.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { createPost, draftIssues } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
const BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";

// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(new URL("../../../packages/creative/package.json", import.meta.url))("sharp") as Sharp;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic noise (mulberry32), so a busy background never makes a test flaky. */
function noise(width: number, height: number, seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = next();
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/**
 * AI image labels in the Social module (ADR 0028): provenance follows an
 * image into the library, validation names an unlabelled AI image, and the
 * delivery gate blocks any AI image without a valid label before the
 * provider is called. With ORBIT_AI_IMAGE_LABELS off nothing changes.
 */
describe.skipIf(!enabled)("social AI image labels", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  type Call = { url: string; body: unknown };
  let calls: Call[] = [];
  const saved = { ...process.env };
  const keys = [
    "ORBIT_SOCIAL",
    "ORBIT_FILES",
    "FILES_BACKEND",
    "FILES_ENCRYPTION_KEY",
    "EXECUTION_MODE",
    "ENABLE_EXTERNAL_WRITES",
    "ORBIT_SOCIAL_PLATFORMS",
    "ORBIT_SOCIAL_MEDIA_PUBLIC",
    "ORBIT_PUBLIC_INGRESS",
    "ORBIT_AI_IMAGE_LABELS",
  ];
  const flag = (on: boolean) => {
    process.env.ORBIT_AI_IMAGE_LABELS = on ? "true" : "false";
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const subject = { module: "marketing", kind: "asset", id: "synthetic" };

  const facebookPage = async () => {
    const pageId = String(Math.floor(Math.random() * 1e12));
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "facebook",
      externalId: pageId,
      handle: "Orbit Page",
      displayName: "Orbit Page",
      secret: JSON.stringify({ pageToken: "page-token" }),
      config: { metaUserId: "7", pageId, appConnectionId: randomUUID() },
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability: "write_verified" } }));
    return accountId;
  };
  const telegramChannel = async () => {
    const chatId = `-100${Math.floor(Math.random() * 1e9)}`;
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "telegram",
      externalId: chatId,
      handle: "@orbit_news",
      displayName: "Orbit news",
      secret: JSON.stringify({ botToken: BOT }),
      config: { chatId, botId: "222222222", botUsername: "orbit_pub_bot" },
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability: "write_verified" } }));
    return accountId;
  };
  /** An approved, dispatched publish-now post with one image: its publication. */
  const dispatched = async (accountId: string, mediaId: string) => {
    const post = await p.run((tx) =>
      createPost(tx, p.owner, { baseText: `Post ${randomUUID()}`, baseMedia: [mediaId], variants: [{ accountId }] }),
    );
    const approved = await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    await dispatchPost(worker, post.id, approved.version);
    const variant = await p.run((tx) => tx.socialPostVariant.findFirstOrThrow({ where: { postId: post.id } }));
    return p.run((tx) => tx.socialPublication.findFirstOrThrow({ where: { variantId: variant.id } }));
  };
  const pub = (id: string) => p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id } }));
  const asset = (id: string) => p.run((tx) => tx.socialMediaAsset.findUniqueOrThrow({ where: { id } }));
  /** The provenance records of a library image's original and JPEG rendition. */
  const records = async (id: string) => {
    const row = await asset(id);
    const jpeg = await p.run((tx) => tx.file.findUniqueOrThrow({ where: { id: row.jpegFileId } }));
    return p.run(async (tx: DbTx) => [await imageProvenance(tx, p.owner, row.sha256), await imageProvenance(tx, p.owner, jpeg.sha256)]);
  };
  const provenanceCount = () => p.run((tx) => tx.imageProvenance.count({ where: { projectId: p.owner.projectId } }));
  /** The bytes of the first file in a provider request (multipart). */
  const sentImage = async (call: Call) => {
    const form = call.body as FormData;
    const blob = [...form.values()].find((v): v is File => typeof v !== "string");
    return Buffer.from(await blob!.arrayBuffer());
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTION_MODE: "live",
      ENABLE_EXTERNAL_WRITES: "true",
      ORBIT_SOCIAL_PLATFORMS: "facebook,telegram",
    });
    delete process.env.ORBIT_SOCIAL_MEDIA_PUBLIC;
    delete process.env.ORBIT_PUBLIC_INGRESS;
    flag(true);
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    setSocialFetchForTests(async (url, init = {}) => {
      const call = { url: String(url), body: init.body };
      calls.push(call);
      if (call.url.includes("api.telegram.org")) return json({ ok: true, result: { message_id: 7 } });
      if (call.url.endsWith("/photos")) return json({ id: "ph1" });
      return json({ id: "page_1" });
    });
  });
  afterEach(() => {
    calls = [];
    flag(true);
    delete process.env.ORBIT_SOCIAL_MEDIA_PUBLIC;
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await p?.cleanup();
    await closeDatabase();
  });

  it("records a plain photo as an original upload without a label, and publishes it", async () => {
    const media = await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" });
    const [original, jpeg] = await records(media.id);
    for (const row of [original, jpeg])
      expect(row).toMatchObject({ origin: "original_upload", labelState: "not_required", labelBox: null, subjectModule: "social" });
    const accountId = await facebookPage();
    const issues = await p.run((tx) => draftIssues(tx, p.owner, { baseText: "Hi", baseMedia: [media.id], variants: [{ accountId }] }));
    expect(issues[0]!.issues.map((i) => i.code)).not.toContain("SOCIAL_AI_LABEL_MISSING");
    const publication = await dispatched(accountId, media.id);
    await deliverPublication(worker, publication.id);
    expect((await pub(publication.id)).status).toBe("published");
    expect(calls.some((c) => c.url.endsWith("/photos"))).toBe(true);
  });

  it("labels an upload whose own XMP declares AI, in both stored renditions", async () => {
    const declared = await noise(1200, 900, 11)
      .png()
      .withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" }))
      .toBuffer();
    const media = await uploadMedia(p.editor, { bytes: declared, mime: "image/png" });
    const rows = await records(media.id);
    for (const row of rows) expect(row).toMatchObject({ origin: "ai_generated", labelState: "labeled", labelVersion: 1 });
    const box = rows[0]!.labelBox as RelBox;
    for (const rendition of ["original", "jpeg"] as const) {
      const { bytes } = await mediaContent(p.owner, media.id, rendition);
      expect((await verifyAiLabel(Buffer.from(bytes), box)).ok).toBe(true);
    }
  });

  it("takes a labelled Marketing image over and sends it with a legible label", async () => {
    const art = await noise(1200, 900, 21).png().toBuffer();
    const labelled = await p.run((tx) =>
      labelFinalImage(tx, p.owner, { bytes: art, origin: "ai_generated", subject, createdBy: p.owner.userId }),
    );
    const mediaId = await importOriginMedia(p.owner, { bytes: labelled.result.bytes, mime: "image/png" });
    const rows = await records(mediaId);
    for (const row of rows)
      expect(row).toMatchObject({ origin: "ai_generated", labelState: "labeled", parentSha256: labelled.result.sha256 });
    const publication = await dispatched(await facebookPage(), mediaId);
    await deliverPublication(worker, publication.id);
    expect((await pub(publication.id)).status).toBe("published");
    const upload = calls.find((c) => c.url.endsWith("/photos"))!;
    const sent = await sentImage(upload);
    expect(sha(sent)).toBe((await asset(mediaId)).sha256);
    expect((await verifyAiLabel(sent, labelled.result.label.box)).ok).toBe(true);
  });

  it("stores an image that already carries Orbit's label unchanged, without a second label", async () => {
    // Labelled elsewhere (no record in this project): only the XMP names the label.
    const labelled = await applyAiLabel(await noise(1200, 900, 25).png().toBuffer(), { origin: "ai_generated" });
    const media = await uploadMedia(p.editor, { bytes: labelled.bytes, mime: "image/png" });
    const source = await p.run((tx) => imageProvenance(tx, p.owner, labelled.sha256));
    // The ingest source is the upload itself: recorded labelled, not derived from a second labelling.
    expect(source).toMatchObject({ origin: "ai_generated", labelState: "labeled", labelBox: labelled.label.box, parentSha256: null });
    for (const row of await records(media.id))
      expect(row).toMatchObject({ labelState: "labeled", labelBox: labelled.label.box, parentSha256: labelled.sha256 });
    for (const rendition of ["original", "jpeg"] as const) {
      const { bytes } = await mediaContent(p.owner, media.id, rendition);
      expect((await verifyAiLabel(Buffer.from(bytes), labelled.label.box)).ok).toBe(true);
    }
  });

  it("refuses raw generated art pushed into the library without a label", async () => {
    const raw = await noise(800, 600, 31).png().toBuffer();
    await p.run((tx) => recordUnlabeledSource(tx, p.owner, { bytes: raw, origin: "ai_generated", subject, createdBy: p.owner.userId }));
    const before = await p.run((tx) => tx.socialMediaAsset.count({ where: { projectId: p.owner.projectId } }));
    await expect(importOriginMedia(p.owner, { bytes: raw, mime: "image/png" })).rejects.toMatchObject({ code: "AI_LABEL_MISSING", status: 409 });
    expect(await p.run((tx) => tx.socialMediaAsset.count({ where: { projectId: p.owner.projectId } }))).toBe(before);
  });

  it("names an unlabelled AI image as a validation error and refuses to publish it", async () => {
    flag(false);
    const media = await uploadMedia(p.editor, { bytes: await noise(800, 600, 41).jpeg().toBuffer(), mime: "image/jpeg" });
    flag(true);
    const row = await asset(media.id);
    await p.run((tx) =>
      recordImageProvenance(tx, p.owner, { sha256: row.sha256, origin: "ai_generated", labelState: "unlabeled_source", subject, createdBy: p.owner.userId }),
    );
    const accountId = await telegramChannel();
    const issues = await p.run((tx) => draftIssues(tx, p.owner, { baseText: "Hi", baseMedia: [media.id], variants: [{ accountId }] }));
    expect(issues[0]!.issues).toContainEqual({ code: "SOCIAL_AI_LABEL_MISSING", severity: "error", path: "media" });
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: "Hi", baseMedia: [media.id], variants: [{ accountId }] }));
    await expect(p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }))).rejects.toMatchObject({ code: "SOCIAL_VALIDATION_FAILED" });
    // Off, the same image raises nothing.
    flag(false);
    const off = await p.run((tx) => draftIssues(tx, p.owner, { baseText: "Hi", baseMedia: [media.id], variants: [{ accountId }] }));
    expect(off[0]!.issues.map((i) => i.code)).not.toContain("SOCIAL_AI_LABEL_MISSING");
  });

  it("blocks a delivery whose recorded label does not show in the pixels, before any provider call", async () => {
    flag(false);
    const media = await uploadMedia(p.editor, { bytes: await noise(800, 600, 51).jpeg().toBuffer(), mime: "image/jpeg" });
    flag(true);
    const publication = await dispatched(await telegramChannel(), media.id);
    const row = await asset(media.id);
    // A record claiming a label where nothing is drawn.
    await p.run((tx) =>
      recordImageProvenance(tx, p.owner, {
        sha256: row.sha256,
        origin: "ai_generated",
        labelState: "labeled",
        labelVersion: 1,
        labelBox: { x: 0.8, y: 0.9, w: 0.15, h: 0.06 },
        subject,
        createdBy: p.owner.userId,
      }),
    );
    expect(await deliverPublication(worker, publication.id)).toEqual({ status: "succeeded", errorCode: "AI_LABEL_INVALID" });
    expect(calls).toHaveLength(0);
    expect(await pub(publication.id)).toMatchObject({ status: "blocked", blockedCode: "AI_LABEL_INVALID", fence: null });
    const audits = await p.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: { in: ["image.ai_label.blocked", "social.publication.blocked"] } } }),
    );
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["image.ai_label.blocked", "social.publication.blocked"]));
    const attempts = await p.run((tx) => tx.socialDeliveryAttempt.findMany({ where: { publicationId: publication.id } }));
    expect(attempts).toMatchObject([{ outcome: "not_sent", providerCode: "AI_LABEL_INVALID" }]);
    // Nothing sends it later: another delivery skips, reconcile only reads waiting publications.
    await deliverPublication(worker, publication.id);
    await reconcilePublication(worker, publication.id, "unknown");
    await reconcilePublication(worker, publication.id, 1);
    expect(calls).toHaveLength(0);
    expect((await pub(publication.id)).status).toBe("blocked");
    // A public media link for the blocked publication serves nothing.
    Object.assign(process.env, { ORBIT_SOCIAL_MEDIA_PUBLIC: "true", ORBIT_PUBLIC_INGRESS: "true" });
    const url = publicMediaUrl(p.owner, { publicationId: publication.id, fileId: row.jpegFileId });
    await expect(servePublicMedia(url.split("/").pop()!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("blocks an AI image without any label at delivery with AI_LABEL_MISSING", async () => {
    flag(false);
    const media = await uploadMedia(p.editor, { bytes: await noise(800, 600, 61).jpeg().toBuffer(), mime: "image/jpeg" });
    flag(true);
    const publication = await dispatched(await facebookPage(), media.id);
    const row = await asset(media.id);
    // Recorded as AI on the JPEG rendition only: the original that Facebook gets has no record of its own.
    const jpeg = await p.run((tx) => tx.file.findUniqueOrThrow({ where: { id: row.jpegFileId } }));
    await p.run((tx) =>
      recordImageProvenance(tx, p.owner, { sha256: jpeg.sha256, origin: "ai_generated", labelState: "unlabeled_source", subject, createdBy: p.owner.userId }),
    );
    expect(await deliverPublication(worker, publication.id)).toEqual({ status: "succeeded", errorCode: "AI_LABEL_MISSING" });
    expect(calls).toHaveLength(0);
    expect(await pub(publication.id)).toMatchObject({ status: "blocked", blockedCode: "AI_LABEL_MISSING" });
  });

  it("changes nothing while the flag is off", async () => {
    flag(false);
    const before = await provenanceCount();
    const declared = await noise(1000, 750, 71)
      .png()
      .withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" }))
      .toBuffer();
    const media = await uploadMedia(p.editor, { bytes: declared, mime: "image/png" });
    expect(await provenanceCount()).toBe(before);
    expect(await records(media.id)).toEqual([null, null]);
    // Off, the stored bytes are as before ADR 0028: no provenance XMP is carried.
    for (const rendition of ["original", "jpeg"] as const) {
      const { bytes } = await mediaContent(p.owner, media.id, rendition);
      expect((await sharp(Buffer.from(bytes)).metadata()).xmp).toBeUndefined();
    }
    // An unlabelled AI record does not stop a delivery while the flag is off.
    const row = await asset(media.id);
    await p.run((tx) =>
      recordImageProvenance(tx, p.owner, { sha256: row.sha256, origin: "ai_generated", labelState: "unlabeled_source", subject, createdBy: p.owner.userId }),
    );
    const publication = await dispatched(await telegramChannel(), media.id);
    await deliverPublication(worker, publication.id);
    expect((await pub(publication.id)).status).toBe("published");
    expect(calls.length).toBeGreaterThan(0);
  });
});

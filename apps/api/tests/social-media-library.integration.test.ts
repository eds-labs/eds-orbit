import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  listMedia,
  mediaAssetByFile,
  mediaContent,
  removeMedia,
  updateMedia,
  uploadMedia,
} from "../src/modules/social/media/library.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// 800x600 fixtures (apps/api cannot import sharp; it lives in packages/creative).
const image = async (format: "png" | "jpeg" | "webp", _width?: number, _height?: number) =>
  readFileSync(
    new URL(`./fixtures/social/photo-800x600.${format === "jpeg" ? "jpg" : format}`, import.meta.url),
  );
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

/**
 * The social media library (ADR 0020, S3): images become a normalized
 * original and a JPEG rendition in the platform file storage; an image a
 * post uses is only archived.
 */
describe.skipIf(!enabled)("social media library", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  const files = () => p.run((tx) => tx.file.findMany({ where: { projectId: p.owner.projectId, deletedAt: null } }));

  it("stores a PNG as original and JPEG rendition and reports the dimensions", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("png"), mime: "image/png", name: "Launch Banner.png" });
    expect(view).toMatchObject({
      name: "Launch Banner.png",
      mime: "image/png",
      width: 800,
      height: 600,
      jpegWidth: 800,
      jpegHeight: 600,
      altText: null,
      version: 1,
    });
    const content = await mediaContent(p.viewer, view.id, "jpeg");
    expect(content.mime).toBe("image/jpeg");
    expect(isJpeg(content.bytes)).toBe(true);
    const original = await mediaContent(p.viewer, view.id, "original");
    expect(isPng(original.bytes)).toBe(true);
    expect((await files()).filter((f) => f.moduleId === "social").length).toBeGreaterThanOrEqual(2);
  });

  it("turns a WebP into a PNG original", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("webp"), mime: "image/webp", name: "x.webp" });
    expect(view.mime).toBe("image/png");
  });

  it("refuses video and other types, and broken images, without storing anything", async () => {
    const before = (await files()).length;
    await expect(uploadMedia(p.editor, { bytes: Buffer.from("video"), mime: "video/mp4" })).rejects.toMatchObject({
      code: "SOCIAL_VIDEO_NOT_AVAILABLE",
      status: 415,
    });
    await expect(uploadMedia(p.editor, { bytes: Buffer.from("%PDF-1.4"), mime: "application/pdf" })).rejects.toMatchObject({
      code: "SOCIAL_MEDIA_TYPE",
      status: 415,
    });
    await expect(
      uploadMedia(p.editor, { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mime: "image/png" }),
    ).rejects.toMatchObject({ code: "SOCIAL_MEDIA_INVALID", status: 422 });
    expect((await files()).length).toBe(before);
  });

  it("lists the library and updates the alt text with the current version only", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("jpeg"), mime: "image/jpeg", name: "team.jpg" });
    const listed = await p.run((tx) => listMedia(tx, p.viewer));
    expect(listed.items.map((i) => i.id)).toContain(view.id);
    const saved = await p.run((tx) => updateMedia(tx, p.editor, view.id, { altText: "The team at the launch", version: 1 }));
    expect(saved).toMatchObject({ altText: "The team at the launch", version: 2 });
    await expect(p.run((tx) => updateMedia(tx, p.editor, view.id, { altText: "x", version: 1 }))).rejects.toMatchObject({
      code: "SOCIAL_VERSION_CONFLICT",
      status: 409,
    });
  });

  it("deletes an unused image with its files", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("png", 400, 400), mime: "image/png" });
    const asset = await p.run((tx) => tx.socialMediaAsset.findUniqueOrThrow({ where: { id: view.id } }));
    expect(await removeMedia(p.editor, view.id)).toEqual({ id: view.id, removed: "deleted" });
    const left = await p.run((tx) =>
      tx.file.findMany({ where: { id: { in: [asset.fileId, asset.jpegFileId] }, deletedAt: null } }),
    );
    expect(left).toEqual([]);
    expect(await p.run((tx) => tx.socialMediaAsset.count({ where: { id: view.id } }))).toBe(0);
  });

  it("only archives an image a post uses, and keeps its files", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("png", 500, 500), mime: "image/png" });
    const asset = await p.run((tx) => tx.socialMediaAsset.findUniqueOrThrow({ where: { id: view.id } }));
    await p.run(async (tx) => {
      const ids = () => ({ id: randomUUID(), workspaceId: p.owner.workspaceId, projectId: p.owner.projectId });
      const account = await tx.socialAccount.create({
        data: { ...ids(), connectionId: randomUUID(), platform: "telegram", externalId: randomUUID(), handle: "@c", displayName: "C", createdBy: p.owner.userId },
      });
      const post = await tx.socialPost.create({ data: { ...ids(), scheduleTimezone: "UTC", createdBy: p.owner.userId } });
      const variant = await tx.socialPostVariant.create({
        data: { ...ids(), postId: post.id, accountId: account.id, body: "Hi", contentHash: "c".repeat(64) },
      });
      await tx.socialPostMedia.create({
        data: { ...ids(), variantId: variant.id, fileId: asset.fileId, position: 0, kind: "image", sha256: asset.sha256 },
      });
    });
    expect(await removeMedia(p.editor, view.id)).toEqual({ id: view.id, removed: "archived" });
    const listed = await p.run((tx) => listMedia(tx, p.viewer));
    expect(listed.items.map((i) => i.id)).not.toContain(view.id);
    expect((await mediaContent(p.viewer, view.id, "original")).bytes.length).toBeGreaterThan(0);
    expect(await p.run((tx) => mediaAssetByFile(tx, p.owner, asset.jpegFileId))).toMatchObject({ id: view.id });
  });

  it("never serves another project's image", async () => {
    const view = await uploadMedia(p.editor, { bytes: await image("png", 300, 300), mime: "image/png" });
    await expect(mediaContent(other.viewer, view.id, "original")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(removeMedia(other.owner, view.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { buildServer } from "../src/server.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { publicMediaUrl, verifyMediaToken } from "../src/modules/social/media/public-url.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * Public media URLs (ADR 0020, S3): a platform such as Instagram fetches a
 * post's image from a short-lived signed URL. It serves only the named
 * rendition of a medium of a publication that is being sent, and the same
 * 404 for everything else.
 */
describe.skipIf(!enabled)("social public media URLs", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;

  type Setup = { publicationId: string; fileId: string; jpegFileId: string; otherFileId: string };
  const publication = async (status: string, q = p): Promise<Setup> => {
    const media = await uploadMedia(q.editor, { bytes: PNG, mime: "image/png", name: "post.png" });
    const unrelated = await uploadMedia(q.editor, { bytes: PNG, mime: "image/png", name: "other.png" });
    return q.run(async (tx) => {
      const ids = () => ({ id: randomUUID(), workspaceId: q.owner.workspaceId, projectId: q.owner.projectId });
      const asset = await tx.socialMediaAsset.findUniqueOrThrow({ where: { id: media.id } });
      const otherAsset = await tx.socialMediaAsset.findUniqueOrThrow({ where: { id: unrelated.id } });
      const account = await tx.socialAccount.create({
        data: { ...ids(), connectionId: randomUUID(), platform: "instagram", externalId: randomUUID(), handle: "@ig", displayName: "IG", createdBy: q.owner.userId },
      });
      const post = await tx.socialPost.create({ data: { ...ids(), scheduleTimezone: "UTC", createdBy: q.owner.userId } });
      const variant = await tx.socialPostVariant.create({
        data: { ...ids(), postId: post.id, accountId: account.id, body: "Hi", contentHash: "c".repeat(64) },
      });
      await tx.socialPostMedia.create({
        data: { ...ids(), variantId: variant.id, fileId: asset.fileId, position: 0, kind: "image", sha256: asset.sha256 },
      });
      const row = await tx.socialPublication.create({
        data: { ...ids(), variantId: variant.id, accountId: account.id, idempotencyKey: randomUUID(), status, ...(status === "blocked" ? { blockedCode: "X" } : {}) },
      });
      return { publicationId: row.id, fileId: asset.fileId, jpegFileId: asset.jpegFileId, otherFileId: otherAsset.jpegFileId };
    });
  };
  const get = (url: string) => app.inject({ method: "GET", url: new URL(url).pathname });

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    app = await buildServer();
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
  });
  beforeEach(() => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    process.env.ORBIT_SOCIAL_MEDIA_PUBLIC = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
    delete process.env.ORBIT_SOCIAL_MEDIA_PUBLIC;
    await p?.cleanup();
    await other?.cleanup();
    await app?.close();
    await closeDatabase();
  });

  it("serves the named rendition of a publication that is being sent", async () => {
    const s = await publication("sending");
    const url = publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId });
    expect(url.startsWith(`${new URL(loadConfig().APP_ORIGIN).origin}/api/public/social/media/`)).toBe(true);
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.rawPayload[0]).toBe(0xff);
    const audits = await p.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "social.media.public_served" } }),
    );
    expect(audits.map((a) => a.resourceId)).toContain(s.publicationId);
    // The original works too while it belongs to the publication.
    expect((await get(publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.fileId }))).statusCode).toBe(200);
  });

  it("serves nothing for a tampered token, another file or another project", async () => {
    const s = await publication("claimed");
    const url = publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId });
    const token = url.split("/").pop()!;
    const flipped = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect((await app.inject({ method: "GET", url: `/api/public/social/media/${flipped}` })).statusCode).toBe(404);
    expect((await get(publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.otherFileId }))).statusCode).toBe(404);
    expect((await get(publicMediaUrl(other.owner, { publicationId: s.publicationId, fileId: s.jpegFileId }))).statusCode).toBe(404);
  });

  it("serves nothing once the token expired", async () => {
    const s = await publication("processing");
    const old = new Date(Date.now() - 3 * 3600_000);
    expect((await get(publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId }, old))).statusCode).toBe(404);
    const token = publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId }, old).split("/").pop()!;
    expect(verifyMediaToken(token)).toBeNull();
    expect(verifyMediaToken(token, new Date(old.getTime() + 60_000))).toMatchObject({ publicationId: s.publicationId });
  });

  it("serves nothing for a publication that is not being sent", async () => {
    for (const status of ["pending", "published", "canceled", "blocked"]) {
      const s = await publication(status);
      expect((await get(publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId }))).statusCode, status).toBe(404);
    }
  });

  it("issues no URL and serves nothing while either switch is off", async () => {
    const s = await publication("sending");
    const url = publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId });
    process.env.ORBIT_SOCIAL_MEDIA_PUBLIC = "false";
    expect(() => publicMediaUrl(p.owner, { publicationId: s.publicationId, fileId: s.jpegFileId })).toThrow(
      expect.objectContaining({ code: "SOCIAL_MEDIA_PUBLIC_DISABLED" }),
    );
    expect((await get(url)).statusCode).toBe(404);
    process.env.ORBIT_SOCIAL_MEDIA_PUBLIC = "true";
    process.env.ORBIT_PUBLIC_INGRESS = "false";
    expect((await get(url)).statusCode).toBe(404);
  });

  it("lists nothing and refuses malformed tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/api/public/social/media/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/public/social/media/not-a-token" })).statusCode).toBe(404);
    expect(verifyMediaToken("x".repeat(400))).toBeNull();
  });
});

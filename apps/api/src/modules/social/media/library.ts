import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareSocialImage } from "../../../../../../packages/creative/src/index.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  cleanFileName,
  deleteFile,
  markFilesDeleted,
  purgeMarkedFiles,
  readFile,
  storeFile,
} from "../../../platform/files/files.ts";
import { audit, DomainError } from "../../../shared.ts";

// The social module's media library (ADR 0020, S3): every image is stored
// twice in the platform file storage (private to the module): the
// normalized original (orientation applied, no metadata) and a JPEG
// rendition at most 1440 pixels wide for Instagram. An image a post uses is
// only archived, so the post keeps its media.

const MODULE = "social";
// Decoding is CPU- and memory-heavy: at most this many images per process
// at a time; more answer 503 SOCIAL_MEDIA_BUSY instead of queueing.
const MEDIA_SLOTS = 2;
let busy = 0;

const starts = (bytes: Uint8Array, signature: number[], at = 0) =>
  signature.every((value, i) => bytes[at + i] === value);

/** The image type the bytes start with; the declared type is not trusted. */
function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Runs `work` in one of the media slots, or refuses with 503 when all are taken. */
export async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  if (busy >= MEDIA_SLOTS) throw new DomainError("SOCIAL_MEDIA_BUSY", 503);
  busy += 1;
  try {
    return await work();
  } finally {
    busy -= 1;
  }
}

type AssetRow = {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  jpegWidth: number;
  jpegHeight: number;
  jpegSize: number;
  altText: string | null;
  version: number;
  createdAt: Date;
};

export type MediaView = Omit<AssetRow, "createdAt"> & { createdAt: string };

const view = (row: AssetRow): MediaView => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  width: row.width,
  height: row.height,
  size: row.size,
  jpegWidth: row.jpegWidth,
  jpegHeight: row.jpegHeight,
  jpegSize: row.jpegSize,
  altText: row.altText,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
});

const notFound = () => new DomainError("NOT_FOUND", 404);
const discard = (scope: Scope, ...ids: string[]) =>
  Promise.all(ids.map((id) => deleteFile(scope, id).catch(() => undefined)));

/** Accepts an image, stores its original and JPEG rendition, and lists it. */
export async function uploadMedia(
  scope: Scope,
  input: { bytes: Uint8Array; mime: string; name?: unknown },
): Promise<MediaView> {
  const mime = input.mime.toLowerCase().split(";")[0]!.trim();
  if (mime.startsWith("video/")) throw new DomainError("SOCIAL_VIDEO_NOT_AVAILABLE", 415);
  if (!sniffImage(input.bytes)) throw new DomainError("SOCIAL_MEDIA_TYPE", 415);
  const bytes = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const prepared = await withMediaSlot(async () => {
    try {
      return await prepareSocialImage(bytes);
    } catch {
      throw new DomainError("SOCIAL_MEDIA_INVALID", 422);
    }
  });
  const ext = prepared.original.mime === "image/png" ? "png" : "jpg";
  // The stored type may differ from the upload's (an opaque PNG becomes a
  // JPEG), so the name takes the stored type's extension.
  const stem = typeof input.name === "string" ? input.name.replace(/\.(png|jpe?g|webp)$/i, "") : input.name;
  const name = cleanFileName(stem, prepared.original.mime) ?? `image.${ext}`;
  const original = await storeFile(scope, {
    moduleId: MODULE,
    bytes: prepared.original.bytes,
    mime: prepared.original.mime,
    name,
  });
  let jpeg;
  try {
    jpeg = await storeFile(scope, {
      moduleId: MODULE,
      bytes: prepared.jpeg.bytes,
      mime: "image/jpeg",
      name: `${name.replace(/\.[a-z]+$/i, "")}-1440.jpg`,
    });
  } catch (error) {
    await discard(scope, original.id);
    throw error;
  }
  try {
    return await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await tx.socialMediaAsset.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          fileId: original.id,
          jpegFileId: jpeg.id,
          name,
          mime: prepared.original.mime,
          width: prepared.original.width,
          height: prepared.original.height,
          size: original.size,
          jpegWidth: prepared.jpeg.width,
          jpegHeight: prepared.jpeg.height,
          jpegSize: jpeg.size,
          sha256: original.sha256,
          createdBy: scope.userId,
        },
      });
      await audit(tx, scope, "social.media.uploaded", row.id, { mime: row.mime, size: row.size });
      return view(row);
    });
  } catch (error) {
    await discard(scope, original.id, jpeg.id);
    throw error;
  }
}

/** The library: images not archived, newest first. */
export async function listMedia(tx: DbTx, scope: Scope): Promise<{ items: MediaView[] }> {
  const rows = await tx.socialMediaAsset.findMany({
    where: { projectId: scope.projectId, archivedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  });
  return { items: rows.map(view) };
}

const updateInput = z
  .object({ altText: z.string().trim().max(1000).nullable(), version: z.int().min(1) })
  .strict();

export async function updateMedia(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<MediaView> {
  const input = updateInput.parse(raw);
  const changed = await tx.socialMediaAsset.updateMany({
    where: { id, projectId: scope.projectId, archivedAt: null, version: input.version },
    data: { altText: input.altText || null, version: { increment: 1 } },
  });
  const row = await tx.socialMediaAsset.findFirst({ where: { id, projectId: scope.projectId, archivedAt: null } });
  if (!row) throw notFound();
  if (changed.count !== 1) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  return view(row);
}

/**
 * Deletes an unused image with its files; archives one a post uses. The
 * usage check, the entry and marking both files deleted are one
 * transaction, so no post can attach the image in between; the stored
 * objects are purged after the commit.
 */
export async function removeMedia(scope: Scope, id: string): Promise<{ id: string; removed: "archived" | "deleted" }> {
  const outcome = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await tx.socialMediaAsset.findFirst({ where: { id, projectId: scope.projectId } });
    if (!row) throw notFound();
    // Locking the file rows waits for (and then blocks) a post inserting a
    // reference to them, so the count below sees every committed use.
    await tx.$queryRaw`SELECT id FROM "File" WHERE id IN (${row.fileId}::uuid, ${row.jpegFileId}::uuid) AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
    const used = await tx.socialPostMedia.count({
      where: { projectId: scope.projectId, fileId: { in: [row.fileId, row.jpegFileId] } },
    });
    if (used) {
      await tx.socialMediaAsset.update({
        where: { id: row.id },
        data: { archivedAt: row.archivedAt ?? new Date(), version: { increment: 1 } },
      });
      await audit(tx, scope, "social.media.archived", row.id, {});
      return { row, removed: "archived" as const };
    }
    await tx.socialMediaAsset.delete({ where: { id: row.id } });
    await markFilesDeleted(tx, scope, [row.fileId, row.jpegFileId]);
    await audit(tx, scope, "social.media.deleted", row.id, {});
    return { row, removed: "deleted" as const };
  });
  if (outcome.removed === "deleted") await purgeMarkedFiles(scope, [outcome.row.fileId, outcome.row.jpegFileId]);
  return { id, removed: outcome.removed };
}

/** The bytes of one rendition of a library image of this project. */
export async function mediaContent(
  scope: Scope,
  id: string,
  rendition: "original" | "jpeg",
): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.socialMediaAsset.findFirst({ where: { id, projectId: scope.projectId } }),
  );
  if (!row) throw notFound();
  const { file, bytes } = await readFile(scope, rendition === "jpeg" ? row.jpegFileId : row.fileId);
  if (file.moduleId !== MODULE) throw notFound();
  return { bytes, mime: file.mime, name: file.name ?? row.name };
}

/** The library image a file belongs to (as original or rendition). */
export function mediaAssetByFile(tx: DbTx, scope: Scope, fileId: string) {
  return tx.socialMediaAsset.findFirst({
    where: { projectId: scope.projectId, OR: [{ fileId }, { jpegFileId: fileId }] },
  });
}

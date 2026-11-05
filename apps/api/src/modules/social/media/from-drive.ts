import { z } from "zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  driveContent,
  driveFileId,
  driveFileInRoot,
} from "../../../platform/connections/google-drive.ts";
import { DomainError } from "../../../shared.ts";
import { uploadMedia, type MediaView } from "./library.ts";

// Images from the project's Google Drive into the Social media library
// (Drive page design 2026-11-05 §4.4). The platform connection checks the
// project root and the 20 MB cap; the library then treats the bytes like an
// upload (normalized, metadata removed, JPEG rendition). Videos wait for S3b.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const input = z
  .object({ fileId: driveFileId, name: z.string().min(1).max(200).optional() })
  .strict();

export async function importDriveMedia(scope: Scope, raw: unknown): Promise<MediaView> {
  const { fileId, name } = input.parse(raw);
  const meta = await driveFileInRoot(scope, fileId);
  if (meta.mimeType.startsWith("video/")) throw new DomainError("SOCIAL_VIDEO_NOT_AVAILABLE", 415);
  if (!IMAGE_TYPES.has(meta.mimeType)) throw new DomainError("SOCIAL_MEDIA_TYPE", 415);
  // The checksum pins the file the member chose: a change in between is refused.
  const content = await driveContent(scope, fileId, {
    md5Checksum: meta.md5Checksum,
    modifiedTime: meta.modifiedTime,
  });
  return uploadMedia(scope, { bytes: content.bytes, mime: content.mime, name: name ?? meta.name });
}

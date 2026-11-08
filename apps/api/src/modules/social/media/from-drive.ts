import { z } from "zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { DomainError } from "../../../shared.ts";
import { ingestMedia, type MediaView } from "./library.ts";

// Images from the project's Google Drive into the Social media library
// (Drive page design 2026-11-05 §4.4). The platform connection checks the
// project root and the 20 MB cap; the library then treats the bytes like an
// upload (normalized, metadata removed, JPEG rendition). Videos wait for S3b.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// The Drive id shape, checked here too: nothing of the Drive module is used
// at load time, so suites that replace it whole still load the routes.
const input = z
  .object({
    fileId: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export async function importDriveMedia(scope: Scope, raw: unknown): Promise<MediaView> {
  return (await importDriveMediaWith(scope, raw)).media;
}

/** `importDriveMedia` with the library's options (MCP: reuse identical images, alt text). */
export async function importDriveMediaWith(
  scope: Scope,
  raw: unknown,
  options: { reuseIdentical?: boolean; altText?: string | null } = {},
): Promise<{ media: MediaView; duplicate: boolean }> {
  const { fileId, name } = input.parse(raw);
  // One Drive read: the type is checked on the metadata, before the download.
  const content = await driveContent(scope, fileId, undefined, {
    accept: (meta) => {
      if (meta.mimeType.startsWith("video/")) throw new DomainError("SOCIAL_VIDEO_NOT_AVAILABLE", 415);
      if (!IMAGE_TYPES.has(meta.mimeType)) throw new DomainError("SOCIAL_MEDIA_TYPE", 415);
    },
  });
  return ingestMedia(
    scope,
    { bytes: content.bytes, mime: content.mime, name: name ?? content.name },
    { ...options, source: "drive" },
  );
}

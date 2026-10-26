import { sha256Hex } from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { DomainError } from "../../../shared.ts";
import { assetBytes } from "../../assets.ts";

const RASTER_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type RasterMime = (typeof RASTER_MIMES)[number];

/**
 * An image asset's bytes: the stored copy (its SHA-256 checked against the
 * asset's) or, for a Drive-imported asset without one, the Drive file (checked
 * for the checksum or modification time imported). `sha256` is always
 * computed over the returned bytes, so a Drive asset gets one too. Only
 * raster images (`BRAND_IMAGE_FORMAT_UNSUPPORTED`, 415).
 */
export async function assetContent(
  scope: Scope,
  d: Record<string, any>,
): Promise<{ bytes: Buffer; mime: RasterMime; sha256: string }> {
  const content =
    d.driveFileId && !d.base64
      ? await driveContent(scope, d.driveFileId, {
          md5Checksum: d.md5Checksum,
          modifiedTime: d.driveModifiedTime,
        })
      : assetBytes(d);
  if (!(RASTER_MIMES as readonly string[]).includes(content.mime))
    throw new DomainError("BRAND_IMAGE_FORMAT_UNSUPPORTED", 415);
  return {
    bytes: content.bytes,
    mime: content.mime as RasterMime,
    sha256: sha256Hex(content.bytes),
  };
}

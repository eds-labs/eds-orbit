import { sha256Hex } from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { DomainError } from "../../../shared.ts";
import { assetBytes } from "../../assets.ts";
import { isRasterMime, type RasterMime } from "../brand/asset-rules.ts";

const unsupported = () =>
  new DomainError("BRAND_IMAGE_FORMAT_UNSUPPORTED", 415);

/**
 * An image asset's bytes: the stored copy (its SHA-256 checked against the
 * asset's) or, for a Drive-imported asset without one, the Drive file (checked
 * for the checksum or modification time imported). `sha256` is always
 * computed over the returned bytes, so a Drive asset gets one too. Only
 * raster images, from either source (`BRAND_IMAGE_FORMAT_UNSUPPORTED`, 415).
 */
export async function assetContent(
  scope: Scope,
  d: Record<string, any>,
): Promise<{ bytes: Buffer; mime: RasterMime; sha256: string }> {
  let content: { bytes: Buffer; mime: string };
  if (d.driveFileId && !d.base64)
    content = await driveContent(scope, d.driveFileId, {
      md5Checksum: d.md5Checksum,
      modifiedTime: d.driveModifiedTime,
    });
  else {
    // Before assetBytes, which answers any other mime with a raw validation error.
    if (!isRasterMime(d.mime)) throw unsupported();
    content = assetBytes(d);
  }
  if (!isRasterMime(content.mime)) throw unsupported();
  return {
    bytes: content.bytes,
    mime: content.mime,
    sha256: sha256Hex(content.bytes),
  };
}

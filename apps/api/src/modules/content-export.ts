import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { assetBytes } from "./assets.ts";
import { driveContent } from "./google-drive.ts";

/**
 * Resolve the approved PNG attached to exported content. Drive-imported assets
 * keep no inline bytes, so they are read from Drive with the recorded checksum,
 * as the asset preview does.
 */
export async function exportAssetContent(
  scope: Scope,
  asset: Record<string, any> | null,
  readDrive: typeof driveContent = driveContent,
) {
  if (!asset || asset.usageApproved !== true || asset.mime !== "image/png")
    return null;
  const content =
    asset.driveFileId && !asset.base64
      ? await readDrive(scope, asset.driveFileId, {
          md5Checksum: asset.md5Checksum,
          modifiedTime: asset.driveModifiedTime,
        })
      : assetBytes(asset);
  return content.mime === "image/png" ? content : null;
}

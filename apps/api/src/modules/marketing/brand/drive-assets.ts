import { createHash, randomBytes } from "node:crypto";
import { brandAssetUploadInput, normalizeBrandAsset } from "../../assets.ts";
import { encodeWebp } from "../../../../../../packages/creative/src/index.ts";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { create, data, DomainError, list, update } from "../../../shared.ts";
import {
  driveAccessToken as accessToken,
  driveChildren as children,
  driveContains as isWithin,
  driveFile as file,
  DRIVE_FILE_FIELDS as fileFields,
  driveFileId as id,
  driveJson as googleJson,
  driveStorage as storage,
  DRIVE_FOLDER_MIME as folderMime,
  ensureDriveFolder as ensureFolder,
  escapeDriveQuery as escapeQuery,
  projectDriveRow as one,
  type DriveFile,
} from "../../../platform/connections/google-drive.ts";

/**
 * Marketing's brand assets in the project's Google Drive (WP2.5d): importing
 * a Drive file as an asset, listing the brand folders, saving generated
 * images and approved drafts, uploading a user's raster, and marking a failed
 * sync. Moved unchanged from `google-drive.ts`; the platform keeps the OAuth
 * connection, the storage root and the Drive access these build on (plan 04:
 * brand-asset import and draft save stay marketing until Q-06 is decided).
 */
export async function importDriveFile(
  scope: Scope,
  fileId: string,
  type:
    | "logo"
    | "photo"
    | "background"
    | "banner"
    | "icon"
    | "document"
    | "other" = "photo",
) {
  const conf = await storage(scope),
    token = await accessToken(scope);
  if (!(await isWithin(token, fileId, conf.rootFolderId)))
    throw new DomainError("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT", 403);
  const meta = await file(token, fileId);
  if (meta.mimeType === folderMime)
    throw new DomainError("GOOGLE_DRIVE_FILE_REQUIRED");
  if (
    ["logo", "photo", "background", "banner", "icon"].includes(type) &&
    !meta.mimeType.startsWith("image/")
  )
    throw new DomainError("GOOGLE_DRIVE_IMAGE_REQUIRED", 415);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const prior = (await list(tx, scope, "assets")).find(
      (row) => data(row).driveFileId === fileId,
    );
    const value = {
      name: meta.name,
      filename: meta.name,
      type,
      mime: meta.mimeType,
      bytes: Number(meta.size ?? 0),
      width: meta.imageMediaMetadata?.width,
      height: meta.imageMediaMetadata?.height,
      source: "Google Drive",
      sourceType: "DRIVE_EXISTING",
      driveFileId: meta.id,
      driveFolderId: meta.parents?.[0],
      webViewLink: meta.webViewLink,
      driveModifiedTime: meta.modifiedTime,
      md5Checksum: meta.md5Checksum,
      lastIndexedAt: new Date().toISOString(),
      assetStatus: "reference",
      usageApproved: false,
      tags: [],
    };
    return prior
      ? update(tx, scope, prior, { ...data(prior), ...value })
      : create(tx, scope, "assets", value);
  });
}
export async function brandAssets(scope: Scope) {
  const conf = await storage(scope),
    token = await accessToken(scope);
  const folders = [conf.brandLogoFolderId, conf.brandImagesFolderId].filter(
    Boolean,
  ) as string[];
  const files = [] as DriveFile[];
  for (const folderId of folders) {
    if (!(await isWithin(token, folderId, conf.rootFolderId)))
      throw new DomainError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
    files.push(
      ...(await children(token, folderId)).files.filter(
        (f) => f.mimeType !== folderMime,
      ),
    );
  }
  return files;
}
export async function saveGeneratedAsset(
  scope: Scope,
  assetId: string,
  channel = "Other",
) {
  const conf = await storage(scope),
    token = await accessToken(scope);
  const asset = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.entity.findFirst({
      where: {
        id: assetId,
        kind: "assets",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
    }),
  );
  if (!asset) throw new DomainError("NOT_FOUND", 404);
  const value = data(asset);
  if (
    value.type !== "generated_artwork" ||
    value.mime !== "image/png" ||
    !value.base64
  )
    throw new DomainError("GENERATED_ASSET_REQUIRED", 409);
  if (value.driveFileId) return asset;
  let parent = conf.rootFolderId;
  const marketing = (await children(token, parent)).files.find(
    (f) => f.name === "04_Website_und_Marketing" && f.mimeType === folderMime,
  );
  if (marketing) parent = marketing.id;
  const generatedFolder = await ensureFolder(token, parent, "Orbit_Generated");
  const requestedCategory =
    channel === "Other" ? (value.channel ?? channel) : channel;
  const category = [
    "Social",
    "Ads",
    "Blog",
    "Website",
    "Campaigns",
    "Other",
  ].includes(requestedCategory)
    ? requestedCategory
    : "Other";
  const categoryFolder = await ensureFolder(token, generatedFolder, category);
  const platform =
    category === "Social" &&
    ["X", "Telegram", "LinkedIn", "Instagram", "Facebook"].includes(
      value.platform,
    )
      ? value.platform
      : null;
  const target = platform
    ? await ensureFolder(token, categoryFolder, platform)
    : categoryFolder;
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "asset";
  const project = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.project.findUniqueOrThrow({ where: { id: scope.projectId } }),
  );
  const filename = `${slug(project.name)}-${slug(platform ?? category)}-${slug(value.name)}-${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}.png`;
  const lookup = new URL("https://www.googleapis.com/drive/v3/files");
  lookup.searchParams.set(
    "q",
    `'${escapeQuery(target)}' in parents and appProperties has { key='orbitAssetId' and value='${assetId}' } and trashed = false`,
  );
  lookup.searchParams.set("fields", `files(${fileFields})`);
  const prior = (
    await googleJson<{ files: DriveFile[] }>(lookup.toString(), token)
  ).files[0];
  const boundary = `orbit${randomBytes(12).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: filename, parents: [target], appProperties: { orbitAssetId: assetId } })}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`,
    ),
    Buffer.from(value.base64, "base64"),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const uploaded =
    prior ??
    (await googleJson<DriveFile>(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(fileFields)}`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    ));
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await tx.entity.findUniqueOrThrow({
      where: { id: assetId },
    });
    const storageRow = await one(tx, scope, "drive_storage");
    if (
      storageRow &&
      (data(storageRow).generatedAssetsFolderId !== generatedFolder ||
        data(storageRow).generatedFolderIds?.[category] !== categoryFolder ||
        (platform &&
          data(storageRow).generatedFolderIds?.[`Social/${platform}`] !==
            target))
    )
      await update(tx, scope, storageRow, {
        ...data(storageRow),
        generatedAssetsFolderId: generatedFolder,
        generatedFolderIds: {
          ...(data(storageRow).generatedFolderIds ?? {}),
          [category]: categoryFolder,
          ...(platform ? { [`Social/${platform}`]: target } : {}),
        },
      });
    return update(tx, scope, current, {
      ...data(current),
      driveFileId: uploaded.id,
      driveFolderId: target,
      filename,
      webViewLink: `https://drive.google.com/file/d/${uploaded.id}/view`,
      driveSyncStatus: "SYNCED",
      sourceType:
        value.source === "template" ? "TEMPLATE_GENERATED" : "AI_GENERATED",
      lastIndexedAt: new Date().toISOString(),
    });
  });
}
/**
 * Saves an approved blog or newsletter draft as a private file under
 * `Orbit_Drafts/<category>` next to the generated assets. A file of the same
 * content and body hash is found again (`appProperties`) instead of uploaded
 * twice. Never publishes anything.
 */
export async function saveDraftDocument(
  scope: Scope,
  draft: {
    contentId: string;
    bodyHash: string;
    category: "Blog" | "Newsletter";
    filename: string;
    mime: "text/markdown";
    bytes: Buffer;
  },
) {
  const conf = await storage(scope),
    token = await accessToken(scope);
  let parent = conf.rootFolderId;
  const marketing = (await children(token, parent)).files.find(
    (f) => f.name === "04_Website_und_Marketing" && f.mimeType === folderMime,
  );
  if (marketing) parent = marketing.id;
  const drafts = await ensureFolder(token, parent, "Orbit_Drafts");
  const target = await ensureFolder(token, drafts, draft.category);
  const lookup = new URL("https://www.googleapis.com/drive/v3/files");
  lookup.searchParams.set(
    "q",
    `'${escapeQuery(target)}' in parents and appProperties has { key='orbitContentId' and value='${escapeQuery(draft.contentId)}' } and appProperties has { key='orbitBodyHash' and value='${escapeQuery(draft.bodyHash)}' } and trashed = false`,
  );
  lookup.searchParams.set("fields", `files(${fileFields})`);
  const prior = (
    await googleJson<{ files: DriveFile[] }>(lookup.toString(), token)
  ).files[0];
  const boundary = `orbit${randomBytes(12).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: draft.filename, parents: [target], appProperties: { orbitContentId: draft.contentId, orbitBodyHash: draft.bodyHash } })}\r\n--${boundary}\r\nContent-Type: ${draft.mime}; charset=UTF-8\r\n\r\n`,
    ),
    draft.bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const uploaded =
    prior ??
    (await googleJson<DriveFile>(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(fileFields)}`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    ));
  return {
    id: uploaded.id,
    folderId: target,
    webViewLink: `https://drive.google.com/file/d/${uploaded.id}/view`,
  };
}
export async function uploadUserRaster(scope: Scope, raw: unknown) {
  const input = brandAssetUploadInput
    .extend({ folderId: id.optional() })
    .parse(raw);
  const { folderId: selectedFolderId, ...assetInput } = input;
  const normalized = await normalizeBrandAsset(assetInput);
  const conf = await storage(scope),
    token = await accessToken(scope);
  const folderId = selectedFolderId ?? conf.rootFolderId;
  if (!(await isWithin(token, folderId, conf.rootFolderId)))
    throw new DomainError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
  const mime = input.mime === "image/webp" ? "image/webp" : "image/png";
  const bytes =
    mime === "image/webp"
      ? await encodeWebp(Buffer.from(normalized.base64, "base64"))
      : Buffer.from(normalized.base64, "base64");
  if (bytes.length > 5_000_000)
    throw new DomainError("ASSET_UPLOAD_TOO_LARGE", 413);
  const slug =
    input.name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "asset";
  const filename = `${slug}.${mime === "image/webp" ? "webp" : "png"}`;
  const boundary = `orbit${randomBytes(12).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: filename, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const uploaded = await googleJson<DriveFile>(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(fileFields)}`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  return scoped(scope.workspaceId, scope.projectId, (tx) =>
    create(tx, scope, "assets", {
      name: input.name,
      type: input.type,
      mime,
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: normalized.width,
      height: normalized.height,
      source: input.source,
      license: input.license,
      validUses: input.validUses,
      rightsInformationConfirmed: true,
      sourceType: "USER_UPLOAD",
      assetStatus: "reference",
      usageApproved: false,
      driveFileId: uploaded.id,
      driveFolderId: folderId,
      md5Checksum: uploaded.md5Checksum,
      driveModifiedTime: uploaded.modifiedTime,
      webViewLink: `https://drive.google.com/file/d/${uploaded.id}/view`,
      driveSyncStatus: "SYNCED",
      uploadedBy: scope.userId,
      uploadedAt: new Date().toISOString(),
    }),
  );
}
export async function markSyncFailed(scope: Scope, assetId: string) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await tx.entity.findUniqueOrThrow({ where: { id: assetId } });
    const attempts = Math.min(5, Number(data(row).driveRetryAttempts ?? 0) + 1);
    return update(tx, scope, row, {
      ...data(row),
      driveSyncStatus: "FAILED",
      driveRetryAttempts: attempts,
      driveRetryAt: new Date(
        Date.now() + Math.min(3_600_000, 60_000 * 2 ** (attempts - 1)),
      ).toISOString(),
    });
  });
}

/**
 * Drive readiness from recorded state only. A rejected OAuth refresh is
 * persisted on the connection by the Drive adapter, so dashboards report it
 * without calling Google on every load.
 */

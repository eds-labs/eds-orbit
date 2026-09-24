import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createHash } from "node:crypto";
import { brandAssetUploadInput, normalizeBrandAsset } from "./assets.ts";
import { encodeWebp } from "../../../../packages/creative/src/index.ts";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  decrypt,
  DomainError,
  encrypt,
  list,
  update,
} from "../shared.ts";

const scopeUrl = "https://www.googleapis.com/auth/drive";
const folderMime = "application/vnd.google-apps.folder";
const fileFields =
  "id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink,imageMediaMetadata,md5Checksum";
const id = z.string().regex(/^[A-Za-z0-9_-]{10,100}$/);
const rootInput = z
  .object({
    rootFolderId: id,
    brandLogoFolderId: id.optional(),
    brandImagesFolderId: id.optional(),
  })
  .strict();
const pageInput = z.object({
  folderId: id.optional(),
  query: z.string().max(120).optional(),
  pageToken: z.string().max(500).optional(),
});
type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  thumbnailLink?: string;
  imageMediaMetadata?: { width?: number; height?: number };
  md5Checksum?: string;
};

function credentials() {
  const c = loadConfig();
  if (!c.GOOGLE_DRIVE_CLIENT_ID || !c.GOOGLE_DRIVE_CLIENT_SECRET)
    throw new DomainError("GOOGLE_DRIVE_NOT_CONFIGURED", 409);
  return {
    clientId: c.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: c.GOOGLE_DRIVE_CLIENT_SECRET,
    redirectUri: `${c.APP_ORIGIN}/api/google-drive/callback`,
    key: c.CREDENTIAL_KEY,
  };
}
function escapeQuery(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
async function googleJson<T>(
  url: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new DomainError(
      response.status === 401
        ? "GOOGLE_DRIVE_RECONNECT_REQUIRED"
        : "GOOGLE_DRIVE_REQUEST_FAILED",
      response.status === 401 ? 409 : 502,
    );
  return response.json() as Promise<T>;
}
async function tokenRequest(body: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new DomainError("GOOGLE_DRIVE_OAUTH_FAILED", 502);
  return z
    .object({ access_token: z.string(), refresh_token: z.string().optional() })
    .parse(await response.json());
}
async function one(tx: DbTx, scope: Scope, kind: string) {
  return (await list(tx, scope, kind))[0] ?? null;
}
export async function connectionStatus(scope: Scope) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const connection = await one(tx, scope, "drive_connection");
    const storage = await one(tx, scope, "drive_storage");
    return {
      configured: Boolean(
        loadConfig().GOOGLE_DRIVE_CLIENT_ID &&
        loadConfig().GOOGLE_DRIVE_CLIENT_SECRET,
      ),
      connected: Boolean(connection && data(connection).encryptedRefreshToken),
      account: data(connection).account ?? null,
      rootFolderId: data(storage).rootFolderId ?? null,
      brandLogoFolderId: data(storage).brandLogoFolderId ?? null,
      brandImagesFolderId: data(storage).brandImagesFolderId ?? null,
      enabled: data(storage).enabled === true,
      scope: scopeUrl,
    };
  });
}
export async function beginConnect(scope: Scope) {
  const c = credentials();
  const state = `${scope.projectId}.${randomBytes(32).toString("base64url")}`;
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    create(tx, scope, "drive_oauth_state", {
      state,
      userId: scope.userId,
      expiresAt: Date.now() + 10 * 60_000,
    }),
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: scopeUrl,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return { url: url.toString() };
}
export async function finishConnect(scope: Scope, state: string, code: string) {
  const c = credentials();
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = (await list(tx, scope, "drive_oauth_state")).find(
      (r) => data(r).state === state,
    );
    if (
      !row ||
      data(row).userId !== scope.userId ||
      data(row).expiresAt < Date.now() ||
      data(row).used
    )
      throw new DomainError("GOOGLE_DRIVE_OAUTH_STATE_INVALID", 403);
    await update(tx, scope, row, { ...data(row), used: true });
  });
  const tokens = await tokenRequest(
    new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  );
  const account = await googleJson<{
    user?: { emailAddress?: string; displayName?: string };
  }>(
    "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)",
    tokens.access_token,
  );
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const old = await one(tx, scope, "drive_connection");
    const refresh =
      tokens.refresh_token ??
      (old ? decrypt(data(old).encryptedRefreshToken, c.key) : null);
    if (!refresh)
      throw new DomainError("GOOGLE_DRIVE_REFRESH_TOKEN_MISSING", 409);
    const value = {
      account:
        account.user?.emailAddress ??
        account.user?.displayName ??
        "Connected account",
      encryptedRefreshToken: encrypt(refresh, c.key),
      connectedAt: new Date().toISOString(),
    };
    if (old) await update(tx, scope, old, value);
    else await create(tx, scope, "drive_connection", value);
  });
}
export async function testDriveConnection(scope: Scope) {
  const token = await accessToken(scope);
  const about = await googleJson<{ user?: { emailAddress?: string } }>(
    "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
    token,
  );
  const current = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    one(tx, scope, "drive_storage"),
  );
  if (current && data(current).rootFolderId)
    await file(token, data(current).rootFolderId);
  return {
    healthy: true,
    account: about.user?.emailAddress ?? null,
    rootAccessible: Boolean(current && data(current).rootFolderId),
  };
}
export async function disconnect(scope: Scope) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await one(tx, scope, "drive_connection");
    if (row) await tx.entity.delete({ where: { id: row.id } });
    const storage = await one(tx, scope, "drive_storage");
    if (storage)
      await update(tx, scope, storage, { ...data(storage), enabled: false });
  });
}

async function accessToken(scope: Scope) {
  const c = credentials();
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    one(tx, scope, "drive_connection"),
  );
  if (!row) throw new DomainError("GOOGLE_DRIVE_NOT_CONNECTED", 409);
  const refresh = decrypt(data(row).encryptedRefreshToken, c.key);
  return (
    await tokenRequest(
      new URLSearchParams({
        refresh_token: refresh,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: "refresh_token",
      }),
    )
  ).access_token;
}
async function file(token: string, fileId: string): Promise<DriveFile> {
  return googleJson(
    `https://www.googleapis.com/drive/v3/files/${id.parse(fileId)}?fields=${encodeURIComponent(fileFields)}`,
    token,
  );
}
async function children(
  token: string,
  parent: string,
  query?: string,
  pageToken?: string,
) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${escapeQuery(parent)}' in parents and trashed = false${query ? ` and name contains '${escapeQuery(query)}'` : ""}`,
  );
  url.searchParams.set("fields", `nextPageToken,files(${fileFields})`);
  url.searchParams.set("pageSize", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return googleJson<{ files: DriveFile[]; nextPageToken?: string }>(
    url.toString(),
    token,
  );
}
async function isWithin(token: string, target: string, root: string) {
  let current = target;
  for (let depth = 0; depth < 30; depth++) {
    if (current === root) return true;
    const node = await file(token, current);
    current = node.parents?.[0] ?? "";
    if (!current) return false;
  }
  return false;
}
async function storage(scope: Scope) {
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    one(tx, scope, "drive_storage"),
  );
  if (!row || !data(row).enabled)
    throw new DomainError("GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED", 409);
  return data(row) as {
    rootFolderId: string;
    brandLogoFolderId?: string;
    brandImagesFolderId?: string;
    generatedAssetsFolderId?: string;
    enabled: boolean;
  };
}
export async function configureRoot(scope: Scope, raw: unknown) {
  const input = rootInput.parse(raw),
    token = await accessToken(scope);
  const root = await file(token, input.rootFolderId);
  if (root.mimeType !== folderMime)
    throw new DomainError("GOOGLE_DRIVE_ROOT_NOT_FOLDER");
  for (const folderId of [input.brandLogoFolderId, input.brandImagesFolderId]) {
    if (!folderId) continue;
    if (!(await isWithin(token, folderId, root.id)))
      throw new DomainError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
    if ((await file(token, folderId)).mimeType !== folderMime)
      throw new DomainError("GOOGLE_DRIVE_BRAND_FOLDER_INVALID", 400);
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const existing = await one(tx, scope, "drive_storage");
    const value = {
      provider: "google_drive",
      connectionId: (await one(tx, scope, "drive_connection"))?.id,
      rootFolderId: root.id,
      rootName: root.name,
      brandLogoFolderId: input.brandLogoFolderId,
      brandImagesFolderId: input.brandImagesFolderId,
      enabled: true,
      generatedAssetsFolderId:
        existing && data(existing).rootFolderId === root.id
          ? data(existing).generatedAssetsFolderId
          : undefined,
    };
    return existing
      ? update(tx, scope, existing, value)
      : create(tx, scope, "drive_storage", value);
  });
}
export async function browseDrive(scope: Scope, raw: unknown) {
  const input = pageInput.parse(raw),
    conf = await storage(scope),
    token = await accessToken(scope);
  const folderId = input.folderId ?? conf.rootFolderId;
  if (!(await isWithin(token, folderId, conf.rootFolderId)))
    throw new DomainError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
  const page = await children(token, folderId, input.query, input.pageToken);
  return {
    folderId,
    files: page.files,
    nextPageToken: page.nextPageToken ?? null,
  };
}
export async function driveContent(
  scope: Scope,
  fileId: string,
  expected?: { md5Checksum?: string; modifiedTime?: string },
) {
  const conf = await storage(scope),
    token = await accessToken(scope);
  if (!(await isWithin(token, fileId, conf.rootFolderId)))
    throw new DomainError("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT", 403);
  const meta = await file(token, fileId);
  if (expected?.md5Checksum && meta.md5Checksum !== expected.md5Checksum)
    throw new DomainError("DRIVE_ASSET_CHANGED", 409);
  if (
    !expected?.md5Checksum &&
    expected?.modifiedTime &&
    meta.modifiedTime !== expected.modifiedTime
  )
    throw new DomainError("DRIVE_ASSET_CHANGED", 409);
  if (
    meta.mimeType === folderMime ||
    ![
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/svg+xml",
      "application/pdf",
    ].includes(meta.mimeType)
  )
    throw new DomainError("GOOGLE_DRIVE_PREVIEW_UNSUPPORTED", 415);
  if (Number(meta.size) > 20_000_000)
    throw new DomainError("GOOGLE_DRIVE_PREVIEW_TOO_LARGE", 413);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${id.parse(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw new DomainError("GOOGLE_DRIVE_DOWNLOAD_FAILED", 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 20_000_000)
    throw new DomainError("GOOGLE_DRIVE_PREVIEW_TOO_LARGE", 413);
  return { bytes, mime: meta.mimeType };
}
async function ensureFolder(token: string, parent: string, name: string) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${escapeQuery(parent)}' in parents and name = '${escapeQuery(name)}' and mimeType = '${folderMime}' and trashed = false`,
  );
  url.searchParams.set("fields", "files(id,name,mimeType)");
  const existing = (
    await googleJson<{ files: DriveFile[] }>(url.toString(), token)
  ).files[0];
  if (existing) return existing.id;
  const created = await googleJson<DriveFile>(
    "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: folderMime, parents: [parent] }),
    },
  );
  return created.id;
}
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

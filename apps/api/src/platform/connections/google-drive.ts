import { randomBytes } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  decrypt,
  DomainError,
  encrypt,
  list,
  update,
} from "../../shared.ts";

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
// Bounded OAuth error codes; anything else is stored as its HTTP status.
const oauthErrorCodes = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_scope",
  "unsupported_grant_type",
]);
async function oauthErrorCode(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" && oauthErrorCodes.has(body.error)
    ? body.error
    : `HTTP_${response.status}`;
}
/**
 * `onRejected` runs when Google rejects the grant (400/401/403). Rate limits,
 * server errors and timeouts are transient and are not recorded.
 */
async function tokenRequest(
  body: URLSearchParams,
  onRejected?: (code: string) => Promise<void>,
) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if (onRejected && [400, 401, 403].includes(response.status))
      await onRejected(await oauthErrorCode(response));
    throw new DomainError("GOOGLE_DRIVE_OAUTH_FAILED", 502);
  }
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
      reconnectRequired: driveReconnectRequired(connection),
      lastRefreshFailedAt: data(connection).lastRefreshFailedAt ?? null,
      lastRefreshErrorCode: data(connection).lastRefreshErrorCode ?? null,
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
  return autoConfigureRoot(scope, tokens.access_token);
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
  const stored = data(row).encryptedRefreshToken;
  const refresh = decrypt(stored, c.key);
  const tokens = await tokenRequest(
    new URLSearchParams({
      refresh_token: refresh,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
    }),
    (code) =>
      recordRefreshState(scope, stored, {
        lastRefreshFailedAt: new Date().toISOString(),
        lastRefreshErrorCode: code,
      }),
  );
  // Only write when a recorded failure has to be cleared.
  if (data(row).lastRefreshFailedAt)
    await recordRefreshState(scope, stored, null);
  return tokens.access_token;
}
/**
 * Persist or clear the last refresh failure so readiness can report a
 * required reconnect without calling Google. Skips the write if the token
 * was replaced meanwhile (reconnect or disconnect). Recording must never hide
 * the original OAuth outcome, so its own errors are only logged.
 */
async function recordRefreshState(
  scope: Scope,
  encryptedRefreshToken: string,
  failure: { lastRefreshFailedAt: string; lastRefreshErrorCode: string } | null,
) {
  try {
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await one(tx, scope, "drive_connection");
      if (!row || data(row).encryptedRefreshToken !== encryptedRefreshToken)
        return;
      const {
        lastRefreshFailedAt: _at,
        lastRefreshErrorCode: _code,
        ...rest
      } = data(row);
      if (!failure && !_at) return;
      await update(tx, scope, row, failure ? { ...rest, ...failure } : rest);
    });
  } catch (error) {
    console.error(
      "Orbit Drive refresh state write failed",
      error instanceof DomainError ? error.code : "unknown",
    );
  }
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
async function namedFolders(token: string, parent: string, name: string) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${escapeQuery(parent)}' in parents and name = '${escapeQuery(name)}' and mimeType = '${folderMime}' and trashed = false`,
  );
  url.searchParams.set("fields", `nextPageToken,files(${fileFields})`);
  url.searchParams.set("pageSize", "100");
  return googleJson<{ files: DriveFile[]; nextPageToken?: string }>(
    url.toString(),
    token,
  );
}
async function uniqueNamedFolder(token: string, parent: string, name: string) {
  const page = await namedFolders(token, parent, name);
  return page.files.length === 1 && !page.nextPageToken ? page.files[0] : null;
}
export async function rootCandidates(scope: Scope, pageToken?: string) {
  const token = await accessToken(scope);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'root' in parents and mimeType = '${folderMime}' and trashed = false`,
  );
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
  url.searchParams.set("pageSize", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const page = await googleJson<{ files: DriveFile[]; nextPageToken?: string }>(
    url.toString(),
    token,
  );
  return {
    folders: page.files
      .filter((item) => item.mimeType === folderMime)
      .map(({ id, name }) => ({ id, name })),
    nextPageToken: page.nextPageToken ?? null,
  };
}
async function autoConfigureRoot(scope: Scope, token: string) {
  const current = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    one(tx, scope, "drive_storage"),
  );
  if (current && data(current).rootFolderId) {
    try {
      await configureRootWithToken(
        scope,
        {
          rootFolderId: data(current).rootFolderId,
          brandLogoFolderId: data(current).brandLogoFolderId,
          brandImagesFolderId: data(current).brandImagesFolderId,
        },
        token,
      );
      return true;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        update(tx, scope, current, { ...data(current), enabled: false }),
      );
    }
  }
  const project = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
      select: { name: true },
    }),
  );
  const match = await uniqueNamedFolder(token, "root", project.name);
  if (!match) return false;
  await configureRootWithToken(scope, { rootFolderId: match.id }, token);
  return true;
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
  return configureRootWithToken(scope, input, token);
}
async function configureRootWithToken(
  scope: Scope,
  input: z.infer<typeof rootInput>,
  token: string,
) {
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
  const brandParent = await uniqueNamedFolder(
    token,
    root.id,
    "01_Marke_und_Design",
  );
  const brandLogoFolderId =
    input.brandLogoFolderId ??
    (brandParent
      ? (await uniqueNamedFolder(token, brandParent.id, "01_Logos"))?.id
      : undefined);
  const brandImagesFolderId =
    input.brandImagesFolderId ??
    (brandParent
      ? (await uniqueNamedFolder(token, brandParent.id, "03_Bildwelt"))?.id
      : undefined);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const existing = await one(tx, scope, "drive_storage");
    const value = {
      provider: "google_drive",
      connectionId: (await one(tx, scope, "drive_connection"))?.id,
      rootFolderId: root.id,
      rootName: root.name,
      brandLogoFolderId,
      brandImagesFolderId,
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
export function driveReconnectRequired(
  connection: { data: unknown } | null | undefined,
) {
  const value = data(connection);
  return Boolean(value.encryptedRefreshToken && value.lastRefreshFailedAt);
}

/**
 * The Drive access a module builds on (WP2.5d): the configured storage, a
 * fresh access token, file and folder reads inside the root and folder
 * creation. Marketing's brand assets (`modules/marketing/brand/drive-assets.ts`)
 * use them; the token never leaves the server.
 */
export {
  accessToken as driveAccessToken,
  children as driveChildren,
  isWithin as driveContains,
  file as driveFile,
  fileFields as DRIVE_FILE_FIELDS,
  id as driveFileId,
  googleJson as driveJson,
  storage as driveStorage,
  folderMime as DRIVE_FOLDER_MIME,
  ensureFolder as ensureDriveFolder,
  escapeQuery as escapeDriveQuery,
  one as projectDriveRow,
  type DriveFile,
};

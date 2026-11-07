import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { defineTool, type ToolContext } from "../../../platform/agents/tools/registry.ts";
import { readMemberFile } from "../../../platform/files/routes.ts";
import { browseDrive } from "../../../platform/connections/google-drive.ts";
import { MODULE_CONTENT_SCOPES, SOCIAL_SCOPE } from "../../../platform/mcp/scopes.ts";
import { assertModuleEnabledFor } from "../../../platform/modules/enforcement.ts";
import { modelParameters, readOperation, serviceArgs } from "../../../platform/tasks/operation-tools.ts";
import { userScoped } from "../../../platform/tenancy/scope.ts";
import { authorize } from "../../../platform/tenancy/permissions.ts";
import type { PermissionDef } from "../../../../../../packages/module-contracts/src/index.ts";
import { audit, create, data, DomainError, hash } from "../../../shared.ts";
import { requireSocial } from "../gate.ts";
import { SOCIAL_COMPOSE, SOCIAL_READ } from "../permissions.ts";
import { importDriveMediaWith } from "./from-drive.ts";
import { fetchMediaUrl } from "./from-url.ts";
import { ingestMedia, mediaAssetByFile, mediaById, searchMedia, type MediaView } from "./library.ts";
import { MEDIA_RECEIPT_KIND, openUploadSession, uploadSessionState, type UploadMime } from "./upload-sessions.ts";

// The media library over MCP (social_media_list, social_drive_files,
// social_media_import, social_media_upload). They use the library the native Social pages use
// (library.ts): no second store. Reading needs `social.read`; importing
// and uploading need `social.compose`, the module on in the project and,
// over MCP, `orbit:social` plus the write scope `orbit:write` (risk
// W0_internal): a library image is internal and private, nothing is
// published, and every post that uses it keeps its owner approval (S-D9).
// Writes take an idempotency key: a retry with the same key and arguments
// returns the first result, other arguments under the key are a conflict.
// Identical images are recognized by the hash of their normalized bytes and
// not stored twice. Audit records name the source, type and size only.

const shared = { module: "social", feature: "social" as const, mcpScopes: [SOCIAL_SCOPE] };
const id = z.string().regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Largest inline image: its base64 stays well inside the gateway's 256 KB request limit. */
export const INLINE_MAX_BYTES = 160_000;
const INLINE_MAX_CHARS = Math.ceil(INLINE_MAX_BYTES / 3) * 4 + 64;

const mediaOut = (m: MediaView, scope: Pick<Scope, "projectId">) => ({
  mediaId: m.id,
  name: m.name,
  kind: "image" as const,
  mime: m.mime,
  width: m.width,
  height: m.height,
  size: m.size,
  jpegWidth: m.jpegWidth,
  jpegHeight: m.jpegHeight,
  jpegSize: m.jpegSize,
  altText: m.altText,
  createdAt: m.createdAt,
  // Opens in a browser signed in to Orbit (member read access); never public.
  previewUrl: `${new URL(loadConfig().APP_ORIGIN).origin}/api/projects/${scope.projectId}/social/media/${m.id}/content?rendition=jpeg`,
});

const mediaShape = z
  .object({
    mediaId: z.string(),
    name: z.string(),
    kind: z.literal("image"),
    mime: z.string(),
    width: z.number(),
    height: z.number(),
    size: z.number(),
    jpegWidth: z.number(),
    jpegHeight: z.number(),
    jpegSize: z.number(),
    altText: z.string().nullable(),
    createdAt: z.string(),
    previewUrl: z.string(),
  })
  .strict();

// ------------------------------------------------------------------ list

const listInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    type: z.enum(["image", "video", "any"]).optional(),
    mimeTypes: z.array(z.enum(IMAGE_MIMES)).min(1).max(3).optional(),
    sort: z.enum(["newest", "oldest"]).optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const socialMediaListTool = readOperation({
  ...shared,
  name: "social_media_list",
  description:
    "The project's Social media library: images with mediaId (use in social_draft_create baseMedia or per-account media), name, type, size, dimensions. Filter by name (query), type, mimeTypes; sort newest/oldest; limit and cursor page. Videos are not supported yet.",
  input: listInput,
  permission: SOCIAL_READ,
  async run(tx, scope, args: z.infer<typeof listInput>) {
    const limit = args.limit ?? 50;
    // The library holds images only (videos wait for S3b).
    if (args.type === "video") return { items: [], nextCursor: null };
    const { items, nextCursor } = await searchMedia(tx, scope, {
      query: args.query,
      mimes: args.mimeTypes,
      order: args.sort,
      limit,
      cursor: args.cursor,
    });
    return { items: items.map((m) => mediaOut(m, scope)), nextCursor };
  },
});

// ---------------------------------------------------------- write guards

async function guard(scope: Scope, permission: PermissionDef) {
  authorize(scope, permission);
  await assertModuleEnabledFor(scope, "social");
  await scoped(scope.workspaceId, scope.projectId, (tx) => requireSocial(tx, scope));
}

const clientOf = (ctx: ToolContext) => (ctx.channel?.kind === "mcp" ? ctx.channel.clientId : "");

type Completed = { status: "completed"; media: ReturnType<typeof mediaOut>; duplicate: boolean };

/**
 * Runs a write once per member, client, tool and idempotency key: a retry
 * with the same arguments gets the stored result (the image must still be
 * in the library), other arguments under the key answer 409.
 */
async function once(
  ctx: ToolContext,
  tool: string,
  idempotencyKey: string,
  args: unknown,
  work: () => Promise<{ media: MediaView; duplicate: boolean }>,
): Promise<Completed & { deduplicated: boolean }> {
  const { scope } = ctx;
  const argsHash = hash(args);
  const clientId = clientOf(ctx);
  const receipt = async (tx: DbTx) => {
    const row = await tx.entity.findFirst({
      where: {
        projectId: scope.projectId,
        kind: MEDIA_RECEIPT_KIND,
        AND: [
          { data: { path: ["actorId"], equals: scope.userId } },
          { data: { path: ["clientId"], equals: clientId } },
          { data: { path: ["tool"], equals: tool } },
          { data: { path: ["idempotencyKey"], equals: idempotencyKey } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!row) return null;
    if (data(row).argsHash !== argsHash) throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", 409);
    return {
      media: await mediaById(tx, scope, String(data(row).mediaId)),
      duplicate: Boolean(data(row).duplicate),
    };
  };
  const previous = await userScoped(scope, receipt);
  if (previous) return { status: "completed", media: mediaOut(previous.media, scope), duplicate: previous.duplicate, deduplicated: true };
  const { media, duplicate } = await work();
  // Under the project lock again: a concurrent call with the same key that
  // finished first keeps its receipt, and this one answers with it.
  const raced = await userScoped(scope, async (tx) => {
    const first = await receipt(tx);
    if (first) return first;
    const row = await create(tx, scope, MEDIA_RECEIPT_KIND, {
      actorId: scope.userId,
      clientId,
      tool,
      idempotencyKey,
      argsHash,
      mediaId: media.id,
      duplicate,
    });
    await audit(tx, scope, "social.media.mcp_stored", row.id, { tool, duplicate });
    return null;
  });
  if (raced) return { status: "completed", media: mediaOut(raced.media, scope), duplicate: raced.duplicate, deduplicated: true };
  return { status: "completed", media: mediaOut(media, scope), duplicate, deduplicated: false };
}

const writeOutput = z
  .object({
    status: z.enum(["completed", "upload_required", "expired"]),
    deduplicated: z.boolean(),
    duplicate: z.boolean().optional(),
    media: mediaShape.optional(),
    sessionId: z.string().optional(),
    upload: z
      .object({
        url: z.string(),
        method: z.literal("PUT"),
        headers: z.object({ "Content-Type": z.string() }).strict(),
        maxBytes: z.number(),
        expiresAt: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const result = (output: z.infer<typeof writeOutput>) => ({ output: writeOutput.parse(output), cards: [] });

// ------------------------------------------------------------ Drive list

const DRIVE_FOLDER = "application/vnd.google-apps.folder";
const driveInput = z
  .object({
    // A folder's driveFileId or a pasted Drive folder link (driveFolderIdOf).
    folderId: z.string().trim().min(1).max(2000).optional(),
    // Folder names below the project's root, separated by "/".
    path: z.string().trim().min(1).max(500).optional(),
    query: z.string().trim().min(1).max(120).optional(),
    sort: z.enum(["name", "modified"]).optional(),
    pageToken: z.string().max(500).optional(),
  })
  .strict();
type DriveArgs = z.infer<typeof driveInput>;

const driveOutput = z
  .object({
    folderId: z.string(),
    rootName: z.string().nullable(),
    path: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    items: z.array(
      z
        .object({
          driveFileId: z.string(),
          name: z.string(),
          kind: z.enum(["folder", "image"]),
          mimeType: z.string(),
          size: z.number().nullable(),
          width: z.number().nullable(),
          height: z.number().nullable(),
          modifiedTime: z.string().nullable(),
        })
        .strict(),
    ),
    nextPageToken: z.string().nullable(),
  })
  .strict();

/**
 * Folders and images of the project's Google Drive folder, through Orbit's
 * own Drive connection and only inside the configured root (the Drive page's
 * browse, images only). A Google call, so it runs outside a transaction.
 */
/** A Drive folder id, also from a pasted Drive folder link (…/folders/<id>, ?id=<id>); null otherwise. */
export function driveFolderIdOf(input: string): string | null {
  const value = input.trim();
  if (DRIVE_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)(drive|docs)\.google\.com$/.test(url.hostname)) return null;
    const candidate =
      url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,100})(\/|$)/)?.[1] ?? url.searchParams.get("id") ?? "";
    return DRIVE_ID.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * The folder at `path` (folder names below the root, "/"-separated), one
 * name per level; 404 SOCIAL_DRIVE_FOLDER_NOT_FOUND when a level has no such
 * folder, 409 SOCIAL_DRIVE_FOLDER_AMBIGUOUS when it has several.
 */
async function folderAtPath(scope: Scope, path: string): Promise<string | undefined> {
  let folderId: string | undefined;
  for (const name of path.split("/").map((part) => part.trim()).filter(Boolean)) {
    const page = await browseDrive(scope, { folderId, query: name, kind: "image" });
    const matches = page.files.filter((f) => f.mimeType === DRIVE_FOLDER && sameName(f.name, name));
    if (matches.length > 1) throw new DomainError("SOCIAL_DRIVE_FOLDER_AMBIGUOUS", 409);
    if (!matches[0]) throw new DomainError("SOCIAL_DRIVE_FOLDER_NOT_FOUND", 404);
    folderId = matches[0].id;
  }
  return folderId;
}

/**
 * The folder to list: `path`, else `folderId` as an id or link. A folderId
 * Google cannot read is tried as a folder name or path below the root
 * (clients often pass the name they saw), and is otherwise not found.
 */
async function driveFolder(scope: Scope, args: DriveArgs) {
  const listing = { query: args.query, sort: args.sort, pageToken: args.pageToken, kind: "image" as const };
  if (args.path) return browseDrive(scope, { ...listing, folderId: await folderAtPath(scope, args.path) });
  if (!args.folderId) return browseDrive(scope, listing);
  const id = driveFolderIdOf(args.folderId);
  if (id) {
    try {
      return await browseDrive(scope, { ...listing, folderId: id });
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "GOOGLE_DRIVE_REQUEST_FAILED")) throw error;
      if (/^https:/i.test(args.folderId)) throw new DomainError("SOCIAL_DRIVE_FOLDER_NOT_FOUND", 404);
    }
  } else if (/^https?:/i.test(args.folderId)) {
    throw new DomainError("SOCIAL_DRIVE_FOLDER_NOT_FOUND", 404);
  }
  return browseDrive(scope, { ...listing, folderId: await folderAtPath(scope, args.folderId) });
}

export const socialDriveFilesTool = defineTool({
  name: "social_drive_files",
  namespace: "social",
  description:
    "Folders and images (PNG, JPEG, WebP, GIF) in the project's Google Drive folder, read through Orbit's own Drive connection: driveFileId for social_media_import (source=drive). Without folderId or path the project's root folder. Open a subfolder with folderId = the driveFileId of a folder item (or a Drive folder link), or with path = folder names from the root, e.g. \"04_Website/02_Social\". query matches names in that one folder (not its subfolders); sort name/modified; pageToken pages.",
  parameters: modelParameters(driveInput),
  risk: "R0_read",
  permission: SOCIAL_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  openWorld: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: driveOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(driveInput, raw) as DriveArgs;
    await guard(ctx.scope, SOCIAL_COMPOSE);
    const page = await driveFolder(ctx.scope, args);
    const number = (value: unknown) => (Number.isFinite(Number(value)) && value !== undefined ? Number(value) : null);
    return {
      output: driveOutput.parse({
        folderId: page.folderId,
        rootName: page.rootName ?? null,
        path: page.path.map(({ id, name }) => ({ id, name })),
        items: page.files.map((f) => ({
          driveFileId: f.id,
          name: f.name,
          kind: f.mimeType === DRIVE_FOLDER ? "folder" : "image",
          mimeType: f.mimeType,
          size: number(f.size),
          width: number(f.imageMediaMetadata?.width),
          height: number(f.imageMediaMetadata?.height),
          modifiedTime: f.modifiedTime ?? null,
        })),
        nextPageToken: page.nextPageToken,
      }),
      cards: [],
    };
  },
});

// ---------------------------------------------------------------- import

const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
/** A Drive file id, also from a pasted Drive link (…/d/<id>/… or ?id=<id>). */
export function driveFileIdOf(input: string): string {
  const value = input.trim();
  if (DRIVE_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /(^|\.)(drive|docs)\.google\.com$/.test(url.hostname)) {
      const fromPath = url.pathname.match(/\/d\/([A-Za-z0-9_-]{10,100})(\/|$)/)?.[1];
      const candidate = fromPath ?? url.searchParams.get("id") ?? "";
      if (DRIVE_ID.test(candidate)) return candidate;
    }
  } catch {
    // not a URL
  }
  throw new DomainError("SOCIAL_MEDIA_SOURCE_INVALID", 422);
}

const importInput = z
  .object({
    source: z.enum(["drive", "url", "orbit_file"]),
    driveFileId: z.string().trim().min(1).max(500).optional(),
    url: z.string().trim().min(1).max(4000).optional(),
    fileId: id.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    altText: z.string().trim().max(1000).optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
type ImportArgs = z.infer<typeof importInput>;

/** Modules whose files need their own MCP consent are never read through orbit:social. */
const guardedFileModule = (moduleId: string) => moduleId === "platform" || moduleId in MODULE_CONTENT_SCOPES;

async function importOrbitFile(scope: Scope, fileId: string, args: ImportArgs) {
  // A file of the library itself (original or rendition) is that image.
  const own = await userScoped(scope, (tx) => mediaAssetByFile(tx, scope, fileId));
  if (own && !own.archivedAt) return { media: await userScoped(scope, (tx) => mediaById(tx, scope, own.id)), duplicate: true };
  // Otherwise an Orbit file the member may download through the file route.
  const file = await readMemberFile(scope, fileId);
  if (guardedFileModule(file.moduleId) && file.moduleId !== "social") throw new DomainError("SOCIAL_MEDIA_SOURCE_NOT_ALLOWED", 403);
  return ingestMedia(
    scope,
    { bytes: file.bytes, mime: file.file.mime, name: args.name ?? file.file.name ?? undefined },
    { reuseIdentical: true, altText: args.altText ?? null, source: "orbit_file" },
  );
}

export const socialMediaImportTool = defineTool({
  name: "social_media_import",
  namespace: "social",
  description:
    "Import an image (PNG, JPEG, WebP) into the project's Social media library and get its mediaId. source=drive with driveFileId (id or link of a file in the project's Google Drive folder, read through Orbit's own Drive connection; no public sharing needed), source=url with a public https url, or source=orbit_file with an Orbit fileId. Optional name and altText. Identical images return the existing mediaId (duplicate). Retry with the same idempotencyKey.",
  parameters: modelParameters(importInput),
  risk: "W0_internal",
  permission: SOCIAL_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  openWorld: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: writeOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(importInput, raw) as ImportArgs;
    await guard(ctx.scope, SOCIAL_COMPOSE);
    const { idempotencyKey, ...rest } = args;
    const pick = () => {
      if (args.source === "drive" && args.driveFileId && !args.url && !args.fileId)
        return () =>
          importDriveMediaWith(
            ctx.scope,
            { fileId: driveFileIdOf(args.driveFileId!), ...(args.name ? { name: args.name } : {}) },
            { reuseIdentical: true, altText: args.altText ?? null },
          );
      if (args.source === "url" && args.url && !args.driveFileId && !args.fileId)
        return async () => {
          const fetched = await fetchMediaUrl(args.url!);
          return ingestMedia(
            ctx.scope,
            { bytes: fetched.bytes, mime: fetched.mime, name: args.name ?? fetched.name },
            { reuseIdentical: true, altText: args.altText ?? null, source: "url" },
          );
        };
      if (args.source === "orbit_file" && args.fileId && !args.driveFileId && !args.url)
        return () => importOrbitFile(ctx.scope, args.fileId!, args);
      throw new DomainError("SOCIAL_MEDIA_SOURCE_INVALID", 422);
    };
    const work = pick();
    return result(await once(ctx, "social_media_import", idempotencyKey, rest, work));
  },
});

// ---------------------------------------------------------------- upload

const uploadInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    mimeType: z.enum(IMAGE_MIMES),
    data: z.string().max(INLINE_MAX_CHARS).optional(),
    file: z
      .object({ download_url: z.string().min(1).max(4000), file_id: z.string().min(1).max(300) })
      .strict()
      .optional(),
    sessionId: id.optional(),
    altText: z.string().trim().max(1000).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
type UploadArgs = z.infer<typeof uploadInput>;

/** Base64 (optionally as a data URL of the declared type) to bytes, strictly. */
export function inlineBytes(value: string, mime: UploadMime): Buffer {
  const prefix = `data:${mime};base64,`;
  const body = (value.startsWith(prefix) ? value.slice(prefix.length) : value).replace(/\s+/g, "");
  const bytes = Buffer.from(body, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== body.replace(/=+$/, ""))
    throw new DomainError("SOCIAL_MEDIA_INLINE_INVALID", 422);
  if (bytes.length > INLINE_MAX_BYTES) throw new DomainError("SOCIAL_MEDIA_INLINE_TOO_LARGE", 413);
  return bytes;
}

export const socialMediaUploadTool = defineTool({
  name: "social_media_upload",
  namespace: "social",
  description:
    "Upload a new image (PNG, JPEG, WebP) into the project's Social media library and get its mediaId. Small images (≤160 KB): data as base64. A file the client holds: file {download_url, file_id}. Larger images: call without data/file to get a one-time upload URL (PUT the raw bytes with the Content-Type shown within 15 minutes; the response holds the mediaId), then call with sessionId to read the result. Identical images return the existing mediaId. Retry with the same idempotencyKey.",
  parameters: modelParameters(uploadInput),
  risk: "W0_internal",
  permission: SOCIAL_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  // `file` is fetched from the client's download URL.
  openWorld: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: writeOutput,
  // ChatGPT fills `file` with a file from the conversation (Apps SDK file params).
  mcpMeta: { "openai/fileParams": ["file"] },
  async execute(ctx, raw) {
    const args = serviceArgs(uploadInput, raw) as UploadArgs;
    await guard(ctx.scope, SOCIAL_COMPOSE);
    const { scope } = ctx;
    const modes = [args.data !== undefined, args.file !== undefined, args.sessionId !== undefined].filter(Boolean).length;
    if (modes > 1) throw new DomainError("SOCIAL_MEDIA_SOURCE_INVALID", 422);
    if (args.sessionId) {
      const state = await userScoped(scope, (tx) => uploadSessionState(tx, scope, args.sessionId!));
      if (state.status !== "completed") return result({ ...state, deduplicated: true });
      const media = await userScoped(scope, (tx) => mediaById(tx, scope, state.mediaId));
      return result({ status: "completed", sessionId: state.sessionId, media: mediaOut(media, scope), duplicate: state.duplicate, deduplicated: true });
    }
    if (!args.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 422);
    const { idempotencyKey, ...rest } = args;
    const altText = args.altText ?? null;
    if (args.data !== undefined) {
      const bytes = inlineBytes(args.data, args.mimeType);
      return result(
        await once(ctx, "social_media_upload", idempotencyKey, rest, () =>
          ingestMedia(scope, { bytes, mime: args.mimeType, name: args.name }, { reuseIdentical: true, altText, source: "mcp_upload" }),
        ),
      );
    }
    if (args.file) {
      const file = args.file;
      return result(
        await once(ctx, "social_media_upload", idempotencyKey, rest, async () => {
          const fetched = await fetchMediaUrl(file.download_url);
          return ingestMedia(
            scope,
            { bytes: fetched.bytes, mime: args.mimeType, name: args.name },
            { reuseIdentical: true, altText, source: "mcp_upload" },
          );
        }),
      );
    }
    const opened = await userScoped(scope, (tx) =>
      openUploadSession(tx, scope, {
        clientId: clientOf(ctx),
        idempotencyKey,
        argsHash: hash(rest),
        name: args.name,
        mime: args.mimeType,
        altText,
      }),
    );
    if (opened.status !== "completed") return result(opened);
    const media = await userScoped(scope, (tx) => mediaById(tx, scope, opened.mediaId));
    return result({
      status: "completed",
      sessionId: opened.sessionId,
      media: mediaOut(media, scope),
      duplicate: opened.duplicate,
      deduplicated: opened.deduplicated,
    });
  },
});

export const socialMediaTools = [socialMediaListTool, socialDriveFilesTool, socialMediaImportTool, socialMediaUploadTool];

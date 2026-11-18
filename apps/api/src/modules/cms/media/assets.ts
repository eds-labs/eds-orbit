import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareWebImage } from "../../../../../../packages/creative/src/index.ts";
import { Prisma, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { LIMITS } from "../../../../../../packages/content-doc/src/index.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { cleanFileName, deleteFile, readFile, storeFile } from "../../../platform/files/files.ts";
import { readMemberFile } from "../../../platform/files/routes.ts";
import { aiImageLabelsEnabled } from "../../../platform/provenance/image-provenance.ts";
import { audit, DomainError } from "../../../shared.ts";
import { notFound, refused, requireVersion, UUID_RE, versionInput } from "../entries/common.ts";
import { CMS_MODULE_ID } from "../manifest.ts";
import { provenanceBeforeIngest, recordRenditions } from "./provenance.ts";

// The content media library (ADR 0029 §3.2, CH1.9). Every image is stored in
// the platform file storage (private to the module) as a normalized original
// plus WebP variants for `srcset` and a 1200x630 Open Graph card. Alt text
// and caption are kept per locale. Assets are archived, never deleted here,
// so old revisions keep their images; retention follows in CH1.17.

// Decoding is CPU- and memory-heavy: at most this many images per process
// at a time; more answer 503 CMS_MEDIA_BUSY instead of queueing.
const MEDIA_SLOTS = 2;
let busy = 0;

async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  if (busy >= MEDIA_SLOTS) throw new DomainError("CMS_MEDIA_BUSY", 503);
  busy += 1;
  try {
    return await work();
  } finally {
    busy -= 1;
  }
}

const starts = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((value, i) => bytes[at + i] === value);

/** The image type the bytes start with; the declared type is not trusted. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

export const IMPORT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** A stored rendition: the original or a variant (`w480`, `w960`, `w1600`, `og`). */
export type Rendition = { name: string; fileId: string; mime: string; width: number; height: number; bytes: number; sha256: string };
export type AssetSource = "upload" | "drive" | "orbit_file" | "api" | "mcp";

type AssetRow = Awaited<ReturnType<DbTx["cmsAsset"]["findFirstOrThrow"]>>;

export const renditionsOf = (row: AssetRow): Rendition[] => [
  { name: "original", fileId: row.fileId, mime: row.mime, width: row.width, height: row.height, bytes: row.bytes, sha256: row.sha256 },
  ...((row.variants as Rendition[] | null) ?? []),
];

const localized = (max: number) =>
  z
    .record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), z.string().trim().max(max))
    .refine((value) => Object.keys(value).length <= 20, "too many locales")
    // Empty texts are dropped: "no alt text" is the absence of the locale.
    .transform((value) => Object.fromEntries(Object.entries(value).filter(([, text]) => text.length > 0)));
const altInput = localized(500);
const captionInput = localized(LIMITS.caption);
const focalPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();

async function viewsOf(tx: DbTx, scope: Scope, rows: readonly AssetRow[]) {
  const files = rows.length
    ? await tx.file.findMany({ where: { projectId: scope.projectId, id: { in: rows.map((r) => r.fileId) } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(files.map((f) => [f.id, f.name]));
  const ids = rows.flatMap((r) => (r.provenanceId ? [r.provenanceId] : []));
  const records = ids.length
    ? await tx.imageProvenance.findMany({ where: { projectId: scope.projectId, id: { in: ids } }, select: { id: true, origin: true, labelState: true } })
    : [];
  const recordOf = new Map(records.map((r) => [r.id, r]));
  return rows.map((row) => {
    const record = row.provenanceId ? recordOf.get(row.provenanceId) : undefined;
    return {
      id: row.id,
      name: nameOf.get(row.fileId) ?? null,
      mime: row.mime,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      sha256: row.sha256,
      alt: row.alt as Record<string, string>,
      caption: row.caption as Record<string, string>,
      credit: row.credit,
      license: row.license,
      focalPoint: row.focalPoint as { x: number; y: number } | null,
      renditions: renditionsOf(row).map(({ fileId: _fileId, sha256: _sha, ...rest }) => rest),
      aiLabel: record ? { origin: record.origin, labelState: record.labelState } : null,
      archived: row.archivedAt !== null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export type AssetView = Awaited<ReturnType<typeof viewsOf>>[number];

async function viewOf(tx: DbTx, scope: Scope, row: AssetRow) {
  return (await viewsOf(tx, scope, [row]))[0]!;
}

const discard = (scope: Scope, ids: readonly string[]) => Promise.all(ids.map((id) => deleteFile(scope, id).catch(() => undefined)));

export interface IngestOptions {
  source: AssetSource;
  alt?: Record<string, string>;
  /** Return a live asset with the same normalized bytes instead of a second copy (default true). */
  reuseIdentical?: boolean;
}

/**
 * Accepts an image: provenance first (an AI image is labelled), then the
 * normalized original and its variants are stored and the asset is listed.
 * Identical images (same normalized bytes) return the existing asset.
 */
export async function ingestAsset(
  scope: Scope,
  input: { bytes: Uint8Array; mime?: string; name?: unknown },
  options: IngestOptions,
): Promise<{ asset: AssetView; duplicate: boolean }> {
  if (!sniffImage(input.bytes)) throw new DomainError("CMS_MEDIA_TYPE", 415);
  const alt = altInput.parse(options.alt ?? {});
  const reuse = options.reuseIdentical !== false;
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const assetId = randomUUID();
  const { prepared, source } = await withMediaSlot(async () => {
    const source = await provenanceBeforeIngest(scope, bytes, assetId);
    try {
      const prepared = await prepareWebImage(source?.bytes ?? bytes, {
        carryProvenance: aiImageLabelsEnabled(),
        keepWhole: source?.ai === true,
      });
      return { prepared, source };
    } catch {
      throw new DomainError("CMS_MEDIA_INVALID", 422);
    }
  });
  const digest = createHash("sha256").update(prepared.original.bytes).digest("hex");
  const existing = async (tx: DbTx) =>
    reuse
      ? tx.cmsAsset.findFirst({ where: { projectId: scope.projectId, sha256: digest, archivedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
      : null;
  const early = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await existing(tx);
    return row ? viewOf(tx, scope, row) : null;
  });
  if (early) return { asset: early, duplicate: true };

  const variants = [...prepared.variants, prepared.og];
  let provenanceId: string | null = null;
  let dropped = new Set<string>();
  if (source) {
    const recorded = await recordRenditions(scope, source, assetId, prepared.original.bytes, variants);
    provenanceId = recorded.original?.id ?? null;
    dropped = recorded.dropped;
  }
  const stem = typeof input.name === "string" ? input.name.replace(/\.(png|jpe?g|webp)$/i, "") : input.name;
  const ext = prepared.original.mime === "image/png" ? "png" : "jpg";
  const name = cleanFileName(stem, prepared.original.mime) ?? `image.${ext}`;
  const base = name.replace(/\.[a-z]+$/i, "");
  const stored: string[] = [];
  const renditions: Rendition[] = [];
  try {
    const original = await storeFile(scope, { moduleId: CMS_MODULE_ID, bytes: prepared.original.bytes, mime: prepared.original.mime, name });
    stored.push(original.id);
    for (const variant of variants) {
      if (dropped.has(variant.name)) continue;
      const file = await storeFile(scope, {
        moduleId: CMS_MODULE_ID,
        bytes: variant.bytes,
        mime: variant.mime,
        name: `${base}-${variant.name}.${variant.mime === "image/webp" ? "webp" : "jpg"}`,
      });
      stored.push(file.id);
      renditions.push({ name: variant.name, fileId: file.id, mime: variant.mime, width: variant.width, height: variant.height, bytes: file.size, sha256: file.sha256 });
    }
    const result = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      // Again under the project lock: of two identical images arriving at
      // once, the second finds the first here.
      const first = await existing(tx);
      if (first) return { asset: await viewOf(tx, scope, first), duplicate: true };
      const row = await tx.cmsAsset.create({
        data: {
          id: assetId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          fileId: original.id,
          mime: prepared.original.mime,
          width: prepared.original.width,
          height: prepared.original.height,
          bytes: original.size,
          sha256: original.sha256,
          alt,
          variants: renditions as unknown as Prisma.InputJsonValue,
          provenanceId,
          createdBy: scope.userId,
        },
      });
      await audit(tx, scope, "cms.asset.created", row.id, {
        mime: row.mime,
        bytes: row.bytes,
        source: options.source,
        renditions: renditions.length,
      });
      return { asset: await viewOf(tx, scope, row), duplicate: false };
    });
    if (result.duplicate) await discard(scope, stored);
    return result;
  } catch (error) {
    await discard(scope, stored);
    throw error;
  }
}

// --- Imports ------------------------------------------------------------------

const importInput = z
  .object({
    source: z.enum(["drive", "orbit_file"]),
    driveFileId: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/).optional(),
    fileId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    alt: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** An image from the project's Google Drive folder or an Orbit file the member may read. */
export async function importAsset(scope: Scope, raw: unknown) {
  const input = importInput.parse(raw);
  if (input.source === "drive") {
    if (!input.driveFileId || input.fileId) throw refused("CMS_MEDIA_SOURCE_INVALID", 422);
    // One Drive read: the type is checked on the metadata, before the download.
    const content = await driveContent(scope, input.driveFileId, undefined, {
      accept: (meta) => {
        if (!IMPORT_TYPES.has(meta.mimeType)) throw new DomainError("CMS_MEDIA_TYPE", 415);
      },
    });
    return ingestAsset(scope, { bytes: content.bytes, mime: content.mime, name: input.name ?? content.name }, { source: "drive", alt: input.alt });
  }
  if (!input.fileId || input.driveFileId) throw refused("CMS_MEDIA_SOURCE_INVALID", 422);
  // A file of the library itself (original or variant) is that asset.
  const own = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await assetByFile(tx, scope, input.fileId!);
    return row && !row.archivedAt ? viewOf(tx, scope, row) : null;
  });
  if (own) return { asset: own, duplicate: true };
  const file = await readMemberFile(scope, input.fileId);
  if (!IMPORT_TYPES.has(file.file.mime)) throw new DomainError("CMS_MEDIA_TYPE", 415);
  return ingestAsset(scope, { bytes: file.bytes, mime: file.file.mime, name: input.name ?? file.file.name ?? undefined }, { source: "orbit_file", alt: input.alt });
}

/** The asset a platform file belongs to, as original or variant. */
export async function assetByFile(tx: DbTx, scope: Scope, fileId: string) {
  const direct = await tx.cmsAsset.findFirst({ where: { projectId: scope.projectId, fileId } });
  if (direct) return direct;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "CmsAsset"
    WHERE "projectId" = ${scope.projectId}::uuid
      AND "variants" @> ${JSON.stringify([{ fileId }])}::jsonb
    LIMIT 1`;
  return rows[0] ? tx.cmsAsset.findFirst({ where: { id: rows[0].id, projectId: scope.projectId } }) : null;
}

// --- Library ------------------------------------------------------------------

const listQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    archived: z.enum(["true", "false"]).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function decodeCursor(raw: string | undefined) {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
  if (!at || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(at))) throw new DomainError("CURSOR_INVALID", 422);
  return { at: new Date(at), id };
}

/** The library, newest first; archived assets only on request. */
export async function listAssets(tx: DbTx, scope: Scope, raw: unknown) {
  const q = listQuery.parse(raw ?? {});
  const after = decodeCursor(q.cursor);
  const named = q.q
    ? (
        await tx.file.findMany({
          where: { projectId: scope.projectId, moduleId: CMS_MODULE_ID, deletedAt: null, name: { contains: q.q, mode: "insensitive" } },
          select: { id: true },
          take: 500,
        })
      ).map((f) => f.id)
    : null;
  const rows = await tx.cmsAsset.findMany({
    where: {
      projectId: scope.projectId,
      ...(q.archived === "true" ? { archivedAt: { not: null } } : { archivedAt: null }),
      ...(named ? { fileId: { in: named } } : {}),
      ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: await viewsOf(tx, scope, page),
    nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") : null,
  };
}

async function findAsset(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound("CMS_ASSET_NOT_FOUND");
  const row = await tx.cmsAsset.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw notFound("CMS_ASSET_NOT_FOUND");
  return row;
}

export async function getAsset(tx: DbTx, scope: Scope, id: string) {
  return viewOf(tx, scope, await findAsset(tx, scope, id));
}

const updateInput = z
  .object({
    version: versionInput,
    alt: altInput.optional(),
    caption: captionInput.optional(),
    credit: z.string().trim().max(200).nullable().optional(),
    license: z.string().trim().max(200).nullable().optional(),
    focalPoint: focalPoint.nullable().optional(),
  })
  .strict();

/** Alt text and caption per locale, credit, license and focal point. */
export async function updateAsset(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const { version, ...input } = updateInput.parse(raw);
  const row = await findAsset(tx, scope, id);
  requireVersion(row.version, version);
  if (row.archivedAt) throw refused("CMS_ASSET_ARCHIVED", 409);
  const result = await tx.cmsAsset.updateMany({
    where: { id: row.id, projectId: scope.projectId, version },
    data: {
      ...(input.alt ? { alt: input.alt } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
      ...(input.credit !== undefined ? { credit: input.credit || null } : {}),
      ...(input.license !== undefined ? { license: input.license || null } : {}),
      ...(input.focalPoint !== undefined ? { focalPoint: input.focalPoint ?? Prisma.DbNull } : {}),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw refused("CMS_VERSION_CONFLICT", 409);
  await audit(tx, scope, "cms.asset.updated", row.id, { fields: Object.keys(input).sort() });
  return getAsset(tx, scope, row.id);
}

/** Archived assets leave the library and cannot be put on drafts; revisions keep them. */
export async function setAssetArchived(tx: DbTx, scope: Scope, id: string, archived: boolean, version: number) {
  const row = await findAsset(tx, scope, id);
  requireVersion(row.version, version);
  if (archived === (row.archivedAt !== null)) return viewOf(tx, scope, row);
  await tx.cmsAsset.update({ where: { id: row.id }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
  await audit(tx, scope, archived ? "cms.asset.archived" : "cms.asset.restored", row.id, {});
  return getAsset(tx, scope, row.id);
}

export const RENDITION_FILE = /^(original|w480|w960|w1600|og)\.(jpg|png|webp)$/;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const extensionOf = (mime: string) => EXT[mime] ?? "bin";

/** The rendition a file name (`w960.webp`) names, if the asset has it in that type. */
export function renditionByFileName(row: AssetRow, file: string): Rendition | null {
  const match = RENDITION_FILE.exec(file);
  if (!match) return null;
  const rendition = renditionsOf(row).find((r) => r.name === match[1]);
  return rendition && extensionOf(rendition.mime) === match[2] ? rendition : null;
}

/** The bytes of one rendition for members (editor preview); archived assets included. */
export async function assetContent(scope: Scope, id: string, file: string) {
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) => findAsset(tx, scope, id));
  const rendition = renditionByFileName(row, file);
  if (!rendition) throw notFound("CMS_ASSET_NOT_FOUND");
  const content = await readFile(scope, rendition.fileId);
  if (content.file.moduleId !== CMS_MODULE_ID) throw notFound("CMS_ASSET_NOT_FOUND");
  return { bytes: content.bytes, mime: rendition.mime, name: content.file.name ?? file };
}

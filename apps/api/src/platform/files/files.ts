import { createHash, randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, constantEqual, DomainError } from "../shared.ts";
import { registeredRegistry } from "../modules/contributions.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import { decryptFile, encryptFile, FILE_ENCRYPTION } from "./crypto.ts";
import { s3Store, type ObjectStore } from "./s3.ts";
import { databaseStore } from "./db-store.ts";

/**
 * Platform files (WP4.6). Binary content is encrypted (crypto.ts) and kept
 * in a separate S3-compatible bucket (s3.ts); the `File` table holds its
 * metadata in the project scope. Modules store and read files through this
 * service; members reach them only through the authorized routes.
 *
 * Off unless ORBIT_FILES is "true" and the bucket is configured. Deleting
 * marks the row first (no reader sees the file again), then removes the
 * object and the row; the hourly cleanup retries what failed. A file with
 * `retainUntil` in the future cannot be deleted (409 FILE_RETAINED); the
 * cleanup only purges rows that were marked deleted, which a retained file
 * never is.
 */

export const FILES_MAX_LIMIT = 50 * 1024 * 1024;

/** Allowed types; the binary ones must also start with their signature. */
const TYPES: Record<string, ((bytes: Uint8Array) => boolean) | null> = {
  "image/png": (b) =>
    starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => starts(b, [0x47, 0x49, 0x46, 0x38]),
  "image/webp": (b) =>
    starts(b, [0x52, 0x49, 0x46, 0x46]) &&
    starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  "application/pdf": (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  "text/plain": null,
  "text/csv": null,
  "message/rfc822": null,
};
/**
 * Types modules may store and members download, but that Support's inbound
 * e-mail attachments do not accept: `allowedFileTypes()` leaves them out.
 */
const STORAGE_ONLY_TYPES: Record<string, (bytes: Uint8Array) => boolean> = {
  "application/xml": (b) =>
    starts(
      b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b,
      [0x3c, 0x3f, 0x78, 0x6d, 0x6c],
    ),
};
const starts = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, i) => bytes[i] === value);

/** The extensions a name of each type may end in; the first is appended otherwise. */
const EXTENSIONS: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/xml": [".xml"],
  "message/rfc822": [".eml"],
};

export const allowedFileTypes = () => Object.keys(TYPES);

const TYPE_CHECKS = { ...TYPES, ...STORAGE_ONLY_TYPES };

type FilesConfig = {
  backend: "database" | "s3";
  maxBytes: number;
  /** What one project may store in all, files marked deleted included. */
  quotaBytes: number;
  keyHex: string;
  /** The project's store: its rows in the database, or the bucket. */
  store: (scope: Scope) => ObjectStore;
};

let override: ObjectStore | null = null;
/** Tests replace the bucket with a double; null restores the configured one. */
export function setObjectStoreForTests(store: ObjectStore | null) {
  override = store;
}

/**
 * The configuration, or null while files are off or incomplete. The
 * database backend needs only the encryption key; S3 also needs its bucket.
 */
export function filesConfig(): FilesConfig | null {
  const c = loadConfig();
  if (c.ORBIT_FILES !== "true" || !c.FILES_ENCRYPTION_KEY) return null;
  const base = {
    backend: c.FILES_BACKEND,
    maxBytes: c.FILES_MAX_BYTES,
    quotaBytes: c.FILES_PROJECT_QUOTA_BYTES,
    keyHex: c.FILES_ENCRYPTION_KEY,
  };
  if (c.FILES_BACKEND === "database")
    return { ...base, store: (scope) => override ?? databaseStore(scope) };
  if (
    !c.FILES_S3_ENDPOINT ||
    !c.FILES_S3_BUCKET ||
    !c.FILES_S3_ACCESS_KEY_ID ||
    !c.FILES_S3_SECRET_ACCESS_KEY
  )
    return null;
  return {
    ...base,
    store: () =>
      override ??
      s3Store({
        endpoint: c.FILES_S3_ENDPOINT!,
        bucket: c.FILES_S3_BUCKET!,
        region: c.FILES_S3_REGION,
        accessKeyId: c.FILES_S3_ACCESS_KEY_ID!,
        secretAccessKey: c.FILES_S3_SECRET_ACCESS_KEY!,
      }),
  };
}

/** The configuration, or 404 FILES_NOT_CONFIGURED. */
export function requireFiles(): FilesConfig {
  const config = filesConfig();
  if (!config) throw new DomainError("FILES_NOT_CONFIGURED", 404);
  return config;
}

type FileRow = {
  id: string;
  moduleId: string;
  key: string;
  name: string | null;
  mime: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: Date;
  retainUntil: Date | null;
};

/** What a client may see of a file: never its object key. */
export const fileView = (row: FileRow) => ({
  id: row.id,
  moduleId: row.moduleId,
  name: row.name,
  mime: row.mime,
  size: row.size,
  sha256: row.sha256,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  retainUntil: row.retainUntil,
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A display name without paths, control or bidi characters, at most 200
 * characters, ending in an extension of its type: a download is saved under
 * this name, so plain text never arrives as "run.bat".
 */
export function cleanFileName(raw: unknown, mime: string): string | null {
  if (typeof raw !== "string") return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(
      /[\u0000-\u001f\u007f-\u009f"\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    )
    .trim();
  if (!clean) return null;
  const extensions = EXTENSIONS[mime] ?? [];
  const lower = clean.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension)))
    return clean.slice(-200);
  return `${clean.slice(0, 200 - extensions[0]!.length)}${extensions[0]}`;
}

/** Bytes the project holds, counting files marked deleted until purged. */
async function projectBytes(tx: DbTx, scope: Scope) {
  const sum = await tx.file.aggregate({
    _sum: { size: true },
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  return sum._sum.size ?? 0;
}

/**
 * Stores one file of a module: checks size, type and the project's quota,
 * encrypts, writes the object, then the row. A failed row removes the
 * object again. The quota bounds the database (and its backup) with the
 * database backend, and the bucket with S3.
 */
export async function storeFile(
  scope: Scope,
  input: {
    moduleId: string;
    bytes: Uint8Array;
    mime: string;
    name?: unknown;
    /** The file cannot be deleted before this time (e.g. legal retention). */
    retainUntil?: Date;
  },
) {
  const config = requireFiles();
  // "platform" holds the platform's own files, such as raw inbound e-mail.
  if (
    input.moduleId !== "platform" &&
    !registeredRegistry().order.includes(input.moduleId)
  )
    throw new DomainError("MODULE_UNKNOWN", 409);
  if (!input.bytes.byteLength) throw new DomainError("FILE_EMPTY", 400);
  if (input.bytes.byteLength > config.maxBytes)
    throw new DomainError("FILE_TOO_LARGE", 413);
  const mime = input.mime.split(";")[0]!.trim().toLowerCase();
  const check = TYPE_CHECKS[mime];
  if (check === undefined || (check && !check(input.bytes)))
    throw new DomainError("FILE_TYPE_NOT_ALLOWED", 415);
  const size = input.bytes.byteLength;
  const overQuota = async (tx: DbTx) =>
    (await projectBytes(tx, scope)) + size > config.quotaBytes;
  // Early, so a full project writes no object at all.
  if (await scoped(scope.workspaceId, scope.projectId, overQuota))
    throw new DomainError("FILES_QUOTA_EXCEEDED", 413);
  const id = randomUUID();
  const key = `projects/${scope.projectId}/${input.moduleId}/${id}`;
  const digest = sha256(input.bytes);
  const store = config.store(scope);
  await store.put(key, encryptFile(input.bytes, id, config.keyHex));
  try {
    const row = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      // Again in the row's transaction: scoped() holds the project's lock,
      // so concurrent uploads cannot overshoot.
      if (await overQuota(tx))
        throw new DomainError("FILES_QUOTA_EXCEEDED", 413);
      const created = await tx.file.create({
        data: {
          id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          moduleId: input.moduleId,
          key,
          name: cleanFileName(input.name, mime),
          mime,
          size: input.bytes.byteLength,
          sha256: digest,
          encryption: FILE_ENCRYPTION,
          createdBy: scope.userId,
          retainUntil: input.retainUntil ?? null,
        },
      });
      await audit(tx, scope, "file.stored", id, {
        moduleId: input.moduleId,
        mime,
        size: input.bytes.byteLength,
      });
      return created;
    });
    return fileView(row);
  } catch (error) {
    await store.delete(key).catch(() => undefined);
    throw error;
  }
}

/** The project's live file, or 404. */
export async function fileRow(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.file.findFirst({
    where: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      deletedAt: null,
    },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

/** A file's metadata and content, checked against its tag and hash. */
export async function readFile(scope: Scope, id: string) {
  const config = requireFiles();
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    fileRow(tx, scope, id),
  );
  const sealed = await config.store(scope).get(row.key);
  if (!sealed) throw new DomainError("FILE_CONTENT_MISSING", 404);
  let bytes: Uint8Array;
  try {
    bytes = decryptFile(sealed, row.id, config.keyHex);
  } catch {
    bytes = new Uint8Array();
  }
  if (!bytes.byteLength || !constantEqual(sha256(bytes), row.sha256)) {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "file.integrity_failed", row.id, {
        moduleId: row.moduleId,
      }),
    );
    throw new DomainError("FILE_INTEGRITY", 500);
  }
  return { file: fileView(row), bytes };
}

/** Removes the object and the row of one marked file; false when that failed. */
async function purge(scope: Scope, store: ObjectStore, row: FileRow) {
  try {
    await store.delete(row.key);
  } catch {
    return false;
  }
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.file.deleteMany({ where: { id: row.id, deletedAt: { not: null } } }),
  );
  return true;
}

/**
 * Deletes a file: unreadable at once, object and row right after. A file
 * under retention (`retainUntil` in the future) is refused with 409.
 */
export async function deleteFile(scope: Scope, id: string) {
  const config = requireFiles();
  const row = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const found = await fileRow(tx, scope, id);
    if (found.retainUntil && found.retainUntil > new Date())
      throw new DomainError("FILE_RETAINED", 409);
    await tx.file.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, scope, "file.deleted", id, { moduleId: found.moduleId });
    return found;
  });
  // A failure here is retried by the cleanup; the file is gone either way.
  await purge(scope, config.store(scope), row);
  return { id, deleted: true };
}

// One cleanup per project at most this often.
const CLEANUP_MS = 3_600_000;
const lastCleanup = new Map<string, number>();

/** Hourly: objects and rows of files marked deleted whose removal failed. */
export const fileCleanup: PeriodicTask = {
  name: "file-cleanup",
  async run(scope) {
    const config = filesConfig();
    if (!config) return;
    const now = Date.now();
    if (now - (lastCleanup.get(scope.projectId) ?? 0) < CLEANUP_MS) return;
    lastCleanup.set(scope.projectId, now);
    const marked = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.file.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          deletedAt: { not: null },
        },
        take: 50,
      }),
    );
    const store = config.store(scope);
    for (const row of marked) await purge(scope, store, row);
  },
};

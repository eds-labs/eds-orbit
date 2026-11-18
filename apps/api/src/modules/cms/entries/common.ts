import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { canonicalJson } from "../../../../../../packages/content-doc/src/index.ts";
import { DomainError } from "../../../shared.ts";

// Shared pieces of the entry service (ADR 0029, CH1.8): ids, locks, the
// optimistic version check, cursors and the check that referenced authors,
// terms and assets exist in the project.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export const slugInput = (max: number) => z.string().trim().min(1).max(max).regex(SLUG_RE, "CMS_SLUG_INVALID");
export const localeInput = z.string().regex(LOCALE_RE, "CMS_LOCALE_INVALID");
export const versionInput = z.int().min(1);

/** A DomainError that carries ids and codes for the client (never content). */
export function refused(code: string, status: number, detail?: Record<string, unknown>) {
  const error = new DomainError(code, status);
  if (detail) Object.assign(error, { detail });
  return error;
}

export const notFound = (code = "CMS_ENTRY_NOT_FOUND") => new DomainError(code, 404);

/** SHA-256 over the canonical JSON of a value. */
export const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The entry, locked for this transaction, or 404. */
export async function lockEntry(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  await tx.$queryRaw`SELECT id FROM "CmsEntry" WHERE id = ${id}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  const entry = await tx.cmsEntry.findFirst({ where: { id, projectId: scope.projectId } });
  if (!entry) throw notFound();
  return entry;
}

export async function findEntry(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const entry = await tx.cmsEntry.findFirst({ where: { id, projectId: scope.projectId } });
  if (!entry) throw notFound();
  return entry;
}

/** Throws 409 CMS_VERSION_CONFLICT unless the caller saw the current version. */
export function requireVersion(current: number, seen: number, code = "CMS_VERSION_CONFLICT") {
  if (current !== seen) throw refused(code, 409, { version: current });
}

/** Keyset cursor over (updatedAt desc, id desc). */
export function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(at))) throw new DomainError("CURSOR_INVALID", 422);
  return { at: new Date(at), id };
}
export const encodeCursor = (row: { updatedAt: Date; id: string }) =>
  Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString("base64url");
export const afterCursor = (after: { at: Date; id: string } | null) =>
  after ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] } : {};

export const listLimit = z.coerce.number().int().min(1).max(100).default(50);

/** References of a draft that must exist (and not be archived) in the project. */
export interface DraftRefs {
  authorIds?: readonly string[];
  termIds?: readonly string[];
  assetIds?: readonly string[];
  /** Terms must be in the entry's locale. */
  locale?: string;
}

/** Throws 422 CMS_REFERENCE_UNKNOWN naming the field and ids that do not resolve. */
export async function requireRefs(tx: DbTx, scope: Scope, refs: DraftRefs) {
  const missing: Record<string, string[]> = {};
  const check = async (field: string, ids: readonly string[] | undefined, found: (ids: string[]) => Promise<string[]>) => {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return;
    const bad = wanted.filter((id) => !UUID_RE.test(id));
    const known = new Set(await found(wanted.filter((id) => UUID_RE.test(id))));
    const absent = [...bad, ...wanted.filter((id) => UUID_RE.test(id) && !known.has(id))];
    if (absent.length) missing[field] = absent.slice(0, 20);
  };
  await check("authorIds", refs.authorIds, async (ids) =>
    (await tx.cmsAuthor.findMany({ where: { projectId: scope.projectId, id: { in: ids }, archivedAt: null }, select: { id: true } })).map((r) => r.id),
  );
  await check("termIds", refs.termIds, async (ids) =>
    (
      await tx.cmsTaxonomyTerm.findMany({
        where: { projectId: scope.projectId, id: { in: ids }, archivedAt: null, ...(refs.locale ? { locale: refs.locale } : {}) },
        select: { id: true },
      })
    ).map((r) => r.id),
  );
  await check("assetIds", refs.assetIds, async (ids) =>
    (await tx.cmsAsset.findMany({ where: { projectId: scope.projectId, id: { in: ids }, archivedAt: null }, select: { id: true } })).map((r) => r.id),
  );
  if (Object.keys(missing).length) throw refused("CMS_REFERENCE_UNKNOWN", 422, { missing });
}

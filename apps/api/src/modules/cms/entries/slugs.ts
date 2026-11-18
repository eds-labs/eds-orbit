import { randomBytes } from "node:crypto";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { slugify } from "../../../../../../packages/content-doc/src/index.ts";
import { refused } from "./common.ts";

// Entry slugs (ADR 0029 §8). A slug is unique per type and locale among the
// entries' working slugs (database key) and among the slugs that are still
// live: a published entry whose draft got a new slug keeps serving the old
// one until the new revision is published, so nobody else may take it.

export const ENTRY_SLUG_MAX = 120;

interface SlugTarget {
  type: string;
  locale: string;
  /** The entry that wants the slug, when it exists already. */
  entryId?: string;
}

/** True when no other entry uses the slug as working or live slug. */
export async function slugFree(tx: DbTx, scope: Scope, target: SlugTarget, slug: string) {
  const other = { projectId: scope.projectId, type: target.type, locale: target.locale, ...(target.entryId ? { id: { not: target.entryId } } : {}) };
  if (await tx.cmsEntry.findFirst({ where: { ...other, slug }, select: { id: true } })) return false;
  const live = await tx.cmsEntry.findMany({
    where: { ...other, publishedRevisionId: { not: null } },
    select: { publishedRevisionId: true },
  });
  if (!live.length) return true;
  const taken = await tx.cmsRevision.findFirst({
    where: { projectId: scope.projectId, id: { in: live.map((e) => e.publishedRevisionId!) }, slug },
    select: { id: true },
  });
  return !taken;
}

/** Throws 409 CMS_SLUG_TAKEN unless the slug is free. */
export async function requireSlugFree(tx: DbTx, scope: Scope, target: SlugTarget, slug: string) {
  if (!(await slugFree(tx, scope, target, slug))) throw refused("CMS_SLUG_TAKEN", 409, { slug });
}

/**
 * A free slug derived from a title: the plain slug, then `-2` … `-20`, then a
 * random suffix. An empty title gives `untitled-…`.
 */
export async function freeSlugFrom(tx: DbTx, scope: Scope, target: SlugTarget, title: string) {
  const base = slugify(title, ENTRY_SLUG_MAX - 7) || `untitled-${randomBytes(3).toString("hex")}`;
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (await slugFree(tx, scope, target, candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { slugify } from "../../../../../../packages/content-doc/src/index.ts";
import { audit } from "../../../shared.ts";
import { localeInput, notFound, refused, requireVersion, slugInput, UUID_RE, versionInput } from "./common.ts";

// Categories and tags (ADR 0029 §3.2). A term lives in one locale; its
// translations share a translation group. Only categories nest, within one
// locale and without cycles. Terms are archived, never deleted, so old
// revisions keep resolving them.

const KINDS = ["category", "tag"] as const;
const MAX_DEPTH = 5;

type TermRow = Awaited<ReturnType<DbTx["cmsTaxonomyTerm"]["findFirstOrThrow"]>>;

export const termView = (row: TermRow) => ({
  id: row.id,
  kind: row.kind,
  locale: row.locale,
  translationGroupId: row.translationGroupId,
  slug: row.slug,
  name: row.name,
  description: row.description,
  parentId: row.parentId,
  archived: row.archivedAt !== null,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const listQuery = z
  .object({ kind: z.enum(KINDS).optional(), locale: localeInput.optional(), archived: z.enum(["true", "false"]).optional() })
  .strict();

export async function listTerms(tx: DbTx, scope: Scope, raw: unknown) {
  const q = listQuery.parse(raw ?? {});
  const rows = await tx.cmsTaxonomyTerm.findMany({
    where: {
      projectId: scope.projectId,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.locale ? { locale: q.locale } : {}),
      ...(q.archived === "true" ? {} : { archivedAt: null }),
    },
    orderBy: [{ kind: "asc" }, { locale: "asc" }, { name: "asc" }],
    take: 1000,
  });
  return { items: rows.map(termView) };
}

const text = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable(),
};

const createInput = z
  .object({
    kind: z.enum(KINDS),
    locale: localeInput,
    name: text.name,
    slug: slugInput(80).optional(),
    description: text.description.optional(),
    parentId: z.uuid().nullable().optional(),
    /** Another term this one translates; it joins that term's group. */
    translationOf: z.uuid().optional(),
  })
  .strict();

const updateInput = z
  .object({
    version: versionInput,
    name: text.name.optional(),
    slug: slugInput(80).optional(),
    description: text.description.optional(),
    parentId: z.uuid().nullable().optional(),
  })
  .strict();

async function findTerm(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound("CMS_TERM_NOT_FOUND");
  const row = await tx.cmsTaxonomyTerm.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw notFound("CMS_TERM_NOT_FOUND");
  return row;
}

async function requireSlugFree(tx: DbTx, scope: Scope, kind: string, locale: string, slug: string, self?: string) {
  const other = await tx.cmsTaxonomyTerm.findFirst({
    where: { projectId: scope.projectId, kind, locale, slug, ...(self ? { id: { not: self } } : {}) },
    select: { id: true },
  });
  if (other) throw refused("CMS_SLUG_TAKEN", 409, { slug });
}

/** A parent must be an active category of the same locale, and no descendant of the term. */
async function requireParent(tx: DbTx, scope: Scope, term: { id?: string; kind: string; locale: string }, parentId: string) {
  if (term.kind !== "category") throw refused("CMS_TERM_PARENT_INVALID", 422);
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (current === term.id || depth >= MAX_DEPTH) throw refused("CMS_TERM_PARENT_INVALID", 422);
    const parent: TermRow | null = await tx.cmsTaxonomyTerm.findFirst({ where: { id: current, projectId: scope.projectId } });
    if (!parent || parent.kind !== "category" || parent.locale !== term.locale || (depth === 0 && parent.archivedAt))
      throw refused("CMS_TERM_PARENT_INVALID", 422);
    current = parent.parentId;
  }
}

export async function createTerm(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  let translationGroupId: string = randomUUID();
  if (input.translationOf) {
    const source = await findTerm(tx, scope, input.translationOf);
    if (source.kind !== input.kind) throw refused("CMS_TERM_KIND_MISMATCH", 422);
    if (await tx.cmsTaxonomyTerm.findFirst({ where: { projectId: scope.projectId, translationGroupId: source.translationGroupId, locale: input.locale } }))
      throw refused("CMS_TRANSLATION_EXISTS", 409, { locale: input.locale });
    translationGroupId = source.translationGroupId;
  }
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw refused("CMS_SLUG_INVALID", 422);
  await requireSlugFree(tx, scope, input.kind, input.locale, slug);
  if (input.parentId) await requireParent(tx, scope, input, input.parentId);
  const row = await tx.cmsTaxonomyTerm.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: input.kind,
      locale: input.locale,
      translationGroupId,
      slug,
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "cms.term.created", row.id, { kind: row.kind, locale: row.locale });
  return termView(row);
}

export async function updateTerm(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const { version, ...input } = updateInput.parse(raw);
  const term = await findTerm(tx, scope, id);
  requireVersion(term.version, version);
  if (term.archivedAt) throw refused("CMS_TERM_ARCHIVED", 409);
  if (input.slug && input.slug !== term.slug) await requireSlugFree(tx, scope, term.kind, term.locale, input.slug, term.id);
  if (input.parentId) await requireParent(tx, scope, term, input.parentId);
  const result = await tx.cmsTaxonomyTerm.updateMany({
    where: { id: term.id, projectId: scope.projectId, version },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw refused("CMS_VERSION_CONFLICT", 409);
  await audit(tx, scope, "cms.term.updated", term.id, { fields: Object.keys(input).sort() });
  return termView(await tx.cmsTaxonomyTerm.findFirstOrThrow({ where: { id: term.id } }));
}

/** Archives or restores a term; an archived category's children move up a level. */
export async function setTermArchived(tx: DbTx, scope: Scope, id: string, archived: boolean, version: number) {
  const term = await findTerm(tx, scope, id);
  requireVersion(term.version, version);
  if (archived === (term.archivedAt !== null)) return termView(term);
  if (archived)
    await tx.cmsTaxonomyTerm.updateMany({
      where: { projectId: scope.projectId, parentId: term.id },
      data: { parentId: term.parentId, version: { increment: 1 } },
    });
  else if (term.parentId) {
    const parent = await tx.cmsTaxonomyTerm.findFirst({ where: { id: term.parentId, projectId: scope.projectId } });
    if (parent?.archivedAt) throw refused("CMS_TERM_PARENT_INVALID", 422);
  }
  await tx.cmsTaxonomyTerm.update({
    where: { id: term.id },
    data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
  });
  await audit(tx, scope, archived ? "cms.term.archived" : "cms.term.restored", term.id, {});
  return termView(await tx.cmsTaxonomyTerm.findFirstOrThrow({ where: { id: term.id } }));
}

/** The same terms in another locale, through their translation groups (missing ones dropped). */
export async function termsInLocale(tx: DbTx, scope: Scope, termIds: readonly string[], locale: string) {
  if (!termIds.length) return [];
  const source = await tx.cmsTaxonomyTerm.findMany({
    where: { projectId: scope.projectId, id: { in: [...termIds] } },
    select: { id: true, translationGroupId: true },
  });
  const translated = await tx.cmsTaxonomyTerm.findMany({
    where: { projectId: scope.projectId, locale, archivedAt: null, translationGroupId: { in: source.map((t) => t.translationGroupId) } },
    select: { id: true, translationGroupId: true },
  });
  const byGroup = new Map(translated.map((t) => [t.translationGroupId, t.id]));
  const order = new Map(source.map((t) => [t.id, t.translationGroupId]));
  return termIds.flatMap((id) => {
    const found = byGroup.get(order.get(id) ?? "");
    return found ? [found] : [];
  });
}

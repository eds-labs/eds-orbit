import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { slugify } from "../../../../../../packages/content-doc/src/index.ts";
import { audit } from "../../../shared.ts";
import { httpsUrl } from "../types/seo.ts";
import { notFound, refused, requireRefs, requireVersion, slugInput, UUID_RE, versionInput } from "./common.ts";

// Authors (ADR 0029 §3.2): the bylines a website shows and the Person of the
// structured data. An author is a byline, not an account; archived authors
// stay resolvable for old revisions.

type AuthorRow = Awaited<ReturnType<DbTx["cmsAuthor"]["findFirstOrThrow"]>>;

export const authorView = (row: AuthorRow) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  bio: row.bio as Record<string, string>,
  avatarAssetId: row.avatarAssetId,
  sameAs: row.sameAs,
  archived: row.archivedAt !== null,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const bio = z.record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), z.string().trim().max(1000)).refine((v) => Object.keys(v).length <= 20);
const fields = {
  name: z.string().trim().min(1).max(120),
  slug: slugInput(80),
  bio,
  avatarAssetId: z.uuid().nullable(),
  sameAs: z.array(httpsUrl).max(10),
};

const createInput = z
  .object({
    name: fields.name,
    slug: fields.slug.optional(),
    bio: fields.bio.optional(),
    avatarAssetId: fields.avatarAssetId.optional(),
    sameAs: fields.sameAs.optional(),
  })
  .strict();
const updateInput = createInput.partial().extend({ version: versionInput }).strict();

export async function listAuthors(tx: DbTx, scope: Scope, raw: unknown) {
  const q = z.object({ archived: z.enum(["true", "false"]).optional() }).strict().parse(raw ?? {});
  const rows = await tx.cmsAuthor.findMany({
    where: { projectId: scope.projectId, ...(q.archived === "true" ? {} : { archivedAt: null }) },
    orderBy: { name: "asc" },
    take: 500,
  });
  return { items: rows.map(authorView) };
}

async function findAuthor(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound("CMS_AUTHOR_NOT_FOUND");
  const row = await tx.cmsAuthor.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw notFound("CMS_AUTHOR_NOT_FOUND");
  return row;
}

async function requireSlugFree(tx: DbTx, scope: Scope, slug: string, self?: string) {
  const other = await tx.cmsAuthor.findFirst({
    where: { projectId: scope.projectId, slug, ...(self ? { id: { not: self } } : {}) },
    select: { id: true },
  });
  if (other) throw refused("CMS_SLUG_TAKEN", 409, { slug });
}

export async function createAuthor(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw refused("CMS_SLUG_INVALID", 422);
  await requireSlugFree(tx, scope, slug);
  if (input.avatarAssetId) await requireRefs(tx, scope, { assetIds: [input.avatarAssetId] });
  const row = await tx.cmsAuthor.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: input.name,
      slug,
      bio: input.bio ?? {},
      avatarAssetId: input.avatarAssetId ?? null,
      sameAs: input.sameAs ?? [],
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "cms.author.created", row.id, {});
  return authorView(row);
}

export async function updateAuthor(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const { version, ...input } = updateInput.parse(raw);
  const author = await findAuthor(tx, scope, id);
  requireVersion(author.version, version);
  if (author.archivedAt) throw refused("CMS_AUTHOR_ARCHIVED", 409);
  if (input.slug && input.slug !== author.slug) await requireSlugFree(tx, scope, input.slug, author.id);
  if (input.avatarAssetId) await requireRefs(tx, scope, { assetIds: [input.avatarAssetId] });
  const result = await tx.cmsAuthor.updateMany({
    where: { id: author.id, projectId: scope.projectId, version },
    data: { ...input, version: { increment: 1 } },
  });
  if (result.count !== 1) throw refused("CMS_VERSION_CONFLICT", 409);
  await audit(tx, scope, "cms.author.updated", author.id, { fields: Object.keys(input).sort() });
  return authorView(await tx.cmsAuthor.findFirstOrThrow({ where: { id: author.id } }));
}

export async function setAuthorArchived(tx: DbTx, scope: Scope, id: string, archived: boolean, version: number) {
  const author = await findAuthor(tx, scope, id);
  requireVersion(author.version, version);
  if (archived === (author.archivedAt !== null)) return authorView(author);
  await tx.cmsAuthor.update({ where: { id: author.id }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
  await audit(tx, scope, archived ? "cms.author.archived" : "cms.author.restored", author.id, {});
  return authorView(await tx.cmsAuthor.findFirstOrThrow({ where: { id: author.id } }));
}

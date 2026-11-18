import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  canonicalJson,
  plainText,
  wordCount,
  type Block,
  type OrbitDoc,
} from "../../../../../../packages/content-doc/src/index.ts";
import { audit } from "../../../shared.ts";
import { findEntry, lockEntry, notFound, refused, sha256, UUID_RE, versionInput } from "./common.ts";
import { requireSlugFree } from "./slugs.ts";

// Revisions (ADR 0029 §3.2): immutable snapshots of an entry's draft. An
// approval and a publication bind a revision by its content hash, so the hash
// covers everything a website shows. Saving a revision of an unchanged draft
// returns the latest one instead of a copy.

type EntryRow = Awaited<ReturnType<DbTx["cmsEntry"]["findFirstOrThrow"]>>;
type DraftRow = Awaited<ReturnType<DbTx["cmsDraft"]["findFirstOrThrow"]>>;
type RevisionRow = Awaited<ReturnType<DbTx["cmsRevision"]["findFirstOrThrow"]>>;

/** What a revision captures of an entry and its draft. */
export function snapshotOf(entry: Pick<EntryRow, "type" | "locale" | "slug">, draft: DraftRow) {
  return {
    type: entry.type,
    locale: entry.locale,
    slug: entry.slug,
    title: draft.title,
    excerpt: draft.excerpt,
    body: draft.body,
    fields: draft.fields,
    seo: draft.seo,
    heroAssetId: draft.heroAssetId,
    authorIds: draft.authorIds,
    termIds: draft.termIds,
  };
}

export const contentHashOf = (snapshot: ReturnType<typeof snapshotOf>) => sha256(snapshot);

const summaryView = (row: RevisionRow, entry: Pick<EntryRow, "publishedRevisionId" | "scheduledRevisionId">) => ({
  id: row.id,
  number: row.number,
  slug: row.slug,
  title: row.title,
  contentHash: row.contentHash,
  wordCount: row.wordCount,
  changeNote: row.changeNote,
  basedOnRevisionId: row.basedOnRevisionId,
  live: row.id === entry.publishedRevisionId,
  scheduled: row.id === entry.scheduledRevisionId,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

export const revisionView = (row: RevisionRow, entry: Pick<EntryRow, "publishedRevisionId" | "scheduledRevisionId">) => ({
  ...summaryView(row, entry),
  excerpt: row.excerpt,
  body: row.body as unknown as OrbitDoc,
  fields: row.fields as Record<string, unknown>,
  seo: row.seo as Record<string, unknown>,
  heroAssetId: row.heroAssetId,
  authorIds: row.authorIds,
  termIds: row.termIds,
  bodyHash: row.bodyHash,
});

export async function latestRevision(tx: DbTx, scope: Scope, entryId: string) {
  return tx.cmsRevision.findFirst({ where: { projectId: scope.projectId, entryId }, orderBy: { number: "desc" } });
}

export interface RevisionOptions {
  changeNote?: string | null;
  /** The draft version the caller saw; a newer draft is refused (CMS_DRAFT_STALE). */
  draftVersion?: number;
}

/**
 * A revision of the entry's current draft. Used by "save version", by asking
 * for publication (CH1.10) and by the management API (CH1.13).
 */
export async function createRevision(tx: DbTx, scope: Scope, entryId: string, options: RevisionOptions = {}) {
  const entry = await lockEntry(tx, scope, entryId);
  if (entry.archivedAt) throw refused("CMS_ENTRY_ARCHIVED", 409);
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
  if (options.draftVersion !== undefined && options.draftVersion !== draft.version)
    throw refused("CMS_DRAFT_STALE", 409, { version: draft.version });
  const snapshot = snapshotOf(entry, draft);
  const contentHash = contentHashOf(snapshot);
  const latest = await latestRevision(tx, scope, entry.id);
  if (latest?.contentHash === contentHash) return { revision: revisionView(latest, entry), created: false };
  const row = await tx.cmsRevision.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      entryId: entry.id,
      number: (latest?.number ?? 0) + 1,
      slug: snapshot.slug,
      title: snapshot.title,
      excerpt: snapshot.excerpt,
      body: draft.body as Prisma.InputJsonValue,
      fields: draft.fields as Prisma.InputJsonValue,
      seo: draft.seo as Prisma.InputJsonValue,
      heroAssetId: draft.heroAssetId,
      authorIds: draft.authorIds,
      termIds: draft.termIds,
      contentHash,
      bodyHash: sha256(draft.body),
      wordCount: wordCount(draft.body as unknown as OrbitDoc),
      changeNote: options.changeNote?.trim() || null,
      basedOnRevisionId: latest?.id ?? null,
      createdBy: scope.userId,
    },
  });
  await tx.cmsEntry.update({ where: { id: entry.id }, data: { updatedAt: new Date() } });
  await audit(tx, scope, "cms.revision.created", row.id, { entryId: entry.id, number: row.number });
  return { revision: revisionView(row, entry), created: true };
}

const listQuery = z
  .object({ before: z.coerce.number().int().min(2).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

/** Revisions of an entry, newest first, without their content. */
export async function listRevisions(tx: DbTx, scope: Scope, entryId: string, raw: unknown) {
  const entry = await findEntry(tx, scope, entryId);
  const q = listQuery.parse(raw ?? {});
  const rows = await tx.cmsRevision.findMany({
    where: { projectId: scope.projectId, entryId: entry.id, ...(q.before ? { number: { lt: q.before } } : {}) },
    orderBy: { number: "desc" },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((row) => summaryView(row, entry)),
    nextBefore: rows.length > q.limit ? page[page.length - 1]!.number : null,
  };
}

async function findRevision(tx: DbTx, scope: Scope, entryId: string, revisionId: string) {
  if (!UUID_RE.test(revisionId)) throw notFound("CMS_REVISION_NOT_FOUND");
  const row = await tx.cmsRevision.findFirst({ where: { id: revisionId, entryId, projectId: scope.projectId } });
  if (!row) throw notFound("CMS_REVISION_NOT_FOUND");
  return row;
}

export async function getRevision(tx: DbTx, scope: Scope, entryId: string, revisionId: string) {
  const entry = await findEntry(tx, scope, entryId);
  return revisionView(await findRevision(tx, scope, entry.id, revisionId), entry);
}

// --- Diff -------------------------------------------------------------------

const FIELD_NAMES = ["slug", "title", "excerpt", "heroAssetId", "authorIds", "termIds", "fields", "seo"] as const;
/** Above this many block comparisons the body is reported as replaced. */
const MAX_DIFF_CELLS = 1_000_000;
const PREVIEW = 300;

type Side = Omit<ReturnType<typeof snapshotOf>, "type" | "locale">;

const blockText = (block: Block) =>
  [...plainText({ schema: "orbit-doc", version: 1, blocks: [block] })].slice(0, PREVIEW).join("");

export type BodyOp =
  | { op: "equal"; count: number }
  | { op: "added" | "removed"; type: Block["type"]; text: string };

/** Block-level difference of two documents (longest common subsequence). */
export function diffBlocks(from: readonly Block[], to: readonly Block[]): BodyOp[] {
  const a = from.map((b) => canonicalJson(b));
  const b = to.map((x) => canonicalJson(x));
  const ops: BodyOp[] = [];
  const push = (op: BodyOp) => {
    const last = ops[ops.length - 1];
    if (op.op === "equal" && last?.op === "equal") last.count += op.count;
    else ops.push(op);
  };
  if (a.length * b.length > MAX_DIFF_CELLS) {
    from.forEach((block) => push({ op: "removed", type: block.type, text: blockText(block) }));
    to.forEach((block) => push({ op: "added", type: block.type, text: blockText(block) }));
    return ops;
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push({ op: "equal", count: 1 });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      push({ op: "removed", type: from[i]!.type, text: blockText(from[i]!) });
      i++;
    } else {
      push({ op: "added", type: to[j]!.type, text: blockText(to[j]!) });
      j++;
    }
  }
  for (; i < a.length; i++) push({ op: "removed", type: from[i]!.type, text: blockText(from[i]!) });
  for (; j < b.length; j++) push({ op: "added", type: to[j]!.type, text: blockText(to[j]!) });
  return ops;
}

function diffSides(from: Side, to: Side) {
  const fields = FIELD_NAMES.filter((name) => canonicalJson(from[name]) !== canonicalJson(to[name])).map((name) => ({
    name,
    from: from[name],
    to: to[name],
  }));
  const fromBody = (from.body as unknown as OrbitDoc).blocks;
  const toBody = (to.body as unknown as OrbitDoc).blocks;
  const body = canonicalJson(fromBody) === canonicalJson(toBody) ? [] : diffBlocks(fromBody, toBody);
  return { fields, body, changed: fields.length > 0 || body.length > 0 };
}

const diffQuery = z.object({ from: z.uuid(), to: z.union([z.uuid(), z.literal("draft")]).default("draft") }).strict();

/** The difference between a revision and another revision or the current draft. */
export async function diffRevisions(tx: DbTx, scope: Scope, entryId: string, raw: unknown) {
  const entry = await findEntry(tx, scope, entryId);
  const q = diffQuery.parse(raw ?? {});
  const from = await findRevision(tx, scope, entry.id, q.from);
  let to: Side;
  if (q.to === "draft") {
    const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
    to = snapshotOf(entry, draft);
  } else to = await findRevision(tx, scope, entry.id, q.to);
  return { from: { id: from.id, number: from.number }, to: q.to === "draft" ? "draft" : { id: q.to, number: (to as RevisionRow).number }, ...diffSides(from, to) };
}

const restoreInput = z.object({ draftVersion: versionInput }).strict();

/** Copies a revision back into the draft; the revision itself stays as it is. */
export async function restoreRevision(tx: DbTx, scope: Scope, entryId: string, revisionId: string, raw: unknown) {
  const { draftVersion } = restoreInput.parse(raw);
  const entry = await lockEntry(tx, scope, entryId);
  if (entry.archivedAt) throw refused("CMS_ENTRY_ARCHIVED", 409);
  const revision = await findRevision(tx, scope, entry.id, revisionId);
  if (revision.slug !== entry.slug) {
    await requireSlugFree(tx, scope, { type: entry.type, locale: entry.locale, entryId: entry.id }, revision.slug);
    await tx.cmsEntry.update({ where: { id: entry.id }, data: { slug: revision.slug } });
  } else await tx.cmsEntry.update({ where: { id: entry.id }, data: { updatedAt: new Date() } });
  const result = await tx.cmsDraft.updateMany({
    where: { entryId: entry.id, projectId: scope.projectId, version: draftVersion },
    data: {
      title: revision.title,
      excerpt: revision.excerpt,
      body: revision.body as Prisma.InputJsonValue,
      fields: revision.fields as Prisma.InputJsonValue,
      seo: revision.seo as Prisma.InputJsonValue,
      heroAssetId: revision.heroAssetId,
      authorIds: revision.authorIds,
      termIds: revision.termIds,
      updatedBy: scope.userId,
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) {
    const current = await tx.cmsDraft.findFirst({ where: { entryId: entry.id }, select: { version: true } });
    throw refused("CMS_DRAFT_STALE", 409, { version: current?.version ?? null });
  }
  await audit(tx, scope, "cms.revision.restored", revision.id, { entryId: entry.id, number: revision.number });
  return { entryId: entry.id, restoredRevisionId: revision.id };
}

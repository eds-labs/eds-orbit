import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { Actor } from "../../../../../../packages/module-contracts/src/index.ts";
import { publishEvent } from "../../../platform/events/events.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { audit } from "../../../shared.ts";
import { notFound, refused, sha256, UUID_RE } from "../entries/common.ts";
import { clearRedirectsAt, entryPaths, redirectSlugChange, redirectWithdrawn } from "../entries/redirects.ts";
import { scheduleLiveChecks } from "../sites/live-check.ts";
import { entryPath, siteRoutes } from "../types/routes.ts";
import { notifySites } from "../sites/notify.ts";
import { preflight, type PreflightIssue } from "./preflight.ts";

// Publications (ADR 0029 §2.3, §3.2, CH1.10). Publishing switches the
// entry's live pointer (`publishedRevisionId`) in Orbit; websites read the
// live revision through the delivery API and learn about the change from a
// signed webhook. No external write carries the content, so a publication has
// no ambiguous outcome. One publication row per site records the step; the
// rows of one approval form a batch that goes live in one transaction.
// Immediate publications run in the approving transaction; scheduled ones on
// the worker (queue `cms_publish`) at their time.

export const CMS_PUBLISH_QUEUE = "cms_publish";

type EntryRow = Awaited<ReturnType<DbTx["cmsEntry"]["findFirstOrThrow"]>>;
type PublicationRow = Awaited<ReturnType<DbTx["cmsPublication"]["findFirstOrThrow"]>>;
type Action = "publish" | "update" | "unpublish";

/** The status an entry's pointers imply (ADR 0029 §3.2). */
export function liveStatus(entry: Pick<EntryRow, "archivedAt" | "scheduledRevisionId" | "publishedRevisionId">) {
  if (entry.archivedAt) return "archived";
  if (entry.scheduledRevisionId) return "scheduled";
  return entry.publishedRevisionId ? "published" : "draft";
}

const actorOf = (scope: Scope): Actor =>
  scope.userId === "worker" ? { kind: "system", id: null } : { kind: "user", id: scope.userId };

const event = (tx: DbTx, scope: Scope, type: string, entryId: string, data: Record<string, unknown>) =>
  publishEvent(tx, scope, { type, subject: { type: "cms.entry", id: entryId }, actor: actorOf(scope), origin: "cms", data });

const tagsOf = (entry: Pick<EntryRow, "id" | "type" | "locale">, siteId: string) => [
  `orbit:entry:${entry.id}`,
  `orbit:list:${siteId}:${entry.type}:${entry.locale}`,
  `orbit:sitemap:${siteId}`,
];

async function attempt(
  tx: DbTx,
  scope: Scope,
  publicationId: string,
  step: string,
  outcome: "ok" | "failed" | "skipped",
  extra: { errorCode?: string; durationMs?: number; detail?: Record<string, unknown> } = {},
) {
  await tx.cmsPublicationAttempt.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      publicationId,
      step,
      outcome,
      errorCode: extra.errorCode ?? null,
      durationMs: extra.durationMs ?? null,
      detail: (extra.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** Removes the entry's schedule; returns the entry as it is now. */
async function clearSchedule(tx: DbTx, entry: EntryRow) {
  const cleared = { ...entry, scheduledRevisionId: null, scheduledAt: null };
  return tx.cmsEntry.update({
    where: { id: entry.id },
    data: { scheduledRevisionId: null, scheduledAt: null, status: liveStatus(cleared), version: { increment: 1 } },
  });
}

// --- Queueing ---------------------------------------------------------------

export interface Batch {
  kind: "publish" | "unpublish";
  revisionId: string | null;
  siteIds: readonly string[];
  /** Null: now. */
  scheduledAt: Date | null;
  approvalRequestId: string | null;
  requesterId: string;
  /** Unpublish only: the entry a 301 points to instead of a 410. */
  replacementEntryId?: string | null;
}

/** Ends queued publications of the entry that a newer approval replaces. */
async function cancelQueued(tx: DbTx, scope: Scope, entryId: string, code: string) {
  const queued = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, entryId, status: "queued" },
    select: { id: true },
  });
  if (!queued.length) return 0;
  await tx.cmsPublication.updateMany({
    where: { id: { in: queued.map((q) => q.id) }, status: "queued" },
    data: { status: "cancelled", errorCode: code, version: { increment: 1 } },
  });
  for (const q of queued) await attempt(tx, scope, q.id, "cancel", "skipped", { errorCode: code });
  return queued.length;
}

/**
 * Records an approved batch: immediate content goes live now, in this
 * transaction (throws CMS_PREFLIGHT_FAILED if it may not); scheduled content
 * waits for the worker. Returns the batch's publication ids.
 */
export async function queueBatch(tx: DbTx, scope: Scope, locked: EntryRow, batch: Batch) {
  // A newer approval replaces what was waiting, schedule included.
  await cancelQueued(tx, scope, locked.id, "CMS_SUPERSEDED");
  const entry = locked.scheduledRevisionId ? await clearSchedule(tx, locked) : locked;
  const now = new Date();
  const due = !batch.scheduledAt || batch.scheduledAt <= now;
  const action: Action = batch.kind === "unpublish" ? "unpublish" : entry.publishedRevisionId ? "update" : "publish";
  const nonce = batch.approvalRequestId ?? randomUUID();
  const ids: string[] = [];
  for (const siteId of batch.siteIds) {
    const id = randomUUID();
    ids.push(id);
    await tx.cmsPublication.create({
      data: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        entryId: entry.id,
        revisionId: batch.revisionId,
        siteId,
        action,
        status: "queued",
        idempotencyKey: sha256({ entryId: entry.id, revisionId: batch.revisionId, siteId, action, nonce }),
        approvalRequestId: batch.approvalRequestId,
        scheduledAt: due ? now : batch.scheduledAt!,
        createdBy: batch.requesterId,
      },
    });
  }
  if (due) {
    const issues = await goLive(tx, scope, entry, ids, { replacementEntryId: batch.replacementEntryId ?? null });
    if (issues.length) throw refused("CMS_PREFLIGHT_FAILED", 422, { issues });
    return ids;
  }
  // Scheduled: the entry shows the schedule; the worker picks it up at its time.
  await tx.cmsEntry.update({
    where: { id: entry.id },
    data: {
      scheduledRevisionId: batch.revisionId,
      scheduledAt: batch.scheduledAt,
      status: "scheduled",
      version: { increment: 1 },
    },
  });
  await enqueue(tx, scope, CMS_PUBLISH_QUEUE, entry.id, `cms-publish:${entry.id}:${nonce}`, batch.scheduledAt!);
  const revision = await tx.cmsRevision.findFirstOrThrow({ where: { id: batch.revisionId!, projectId: scope.projectId } });
  await event(tx, scope, "cms.entry.scheduled", entry.id, { revision: revision.number, sites: batch.siteIds.length, at: batch.scheduledAt!.toISOString() });
  const paths = new Map((await entryPaths(tx, scope, entry, revision.slug)).map((p) => [p.siteId, p.path]));
  await notifySites(
    tx,
    scope,
    "cms.entry.scheduled",
    batch.siteIds.map((siteId) => ({
      siteId,
      payload: {
        siteId,
        entry: { id: entry.id, type: entry.type, locale: entry.locale, slug: revision.slug, path: paths.get(siteId) ?? null, revision: revision.number },
        scheduledAt: batch.scheduledAt!.toISOString(),
        previousPath: null,
        tags: tagsOf(entry, siteId),
      },
    })),
  );
  return ids;
}

// --- Going live -------------------------------------------------------------

/** Marks a batch as stopped for a person to look at; nothing changed on the sites. */
async function needsAttention(
  tx: DbTx,
  scope: Scope,
  entry: EntryRow,
  pubs: PublicationRow[],
  code: string,
  issues: PreflightIssue[] = [],
  step = "preflight",
) {
  await tx.cmsPublication.updateMany({
    where: { id: { in: pubs.map((p) => p.id) } },
    data: { status: "needs_attention", errorCode: code, fence: null, version: { increment: 1 } },
  });
  for (const pub of pubs)
    await attempt(tx, scope, pub.id, step, "failed", { errorCode: code, detail: issues.length ? { issues: issues.slice(0, 10) } : {} });
  if (entry.scheduledRevisionId) await clearSchedule(tx, entry);
  await event(tx, scope, "cms.publication.needs_attention", entry.id, { code, publications: pubs.length });
  await audit(tx, scope, "cms.publication.needs_attention", entry.id, { code, publications: pubs.length });
}

/**
 * Switches the live pointer for queued publications of one batch, records
 * redirects for a changed or withdrawn path, and tells sites through the
 * signed webhook. `entry` must be locked by the caller. Returns the issues
 * that stopped it (the batch then needs attention), empty on success.
 */
export async function goLive(
  tx: DbTx,
  scope: Scope,
  entry: EntryRow,
  publicationIds: readonly string[],
  options: { replacementEntryId?: string | null } = {},
): Promise<PreflightIssue[]> {
  const started = Date.now();
  const pubs = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, entryId: entry.id, id: { in: [...publicationIds] }, status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  if (!pubs.length) return [];
  const [first] = pubs;
  const action = first!.action as Action;
  const siteIds = pubs.map((p) => p.siteId).sort();

  // Claim: one runner per batch (the entry row is locked; the fence marks it).
  const fence = randomUUID();
  const claimed = await tx.cmsPublication.updateMany({
    where: { id: { in: pubs.map((p) => p.id) }, status: "queued" },
    data: { status: "claimed", fence, claimedAt: new Date(), attempts: { increment: 1 }, version: { increment: 1 } },
  });
  if (claimed.count !== pubs.length) return [];

  // The batch reaches the sites it was approved for, or none.
  const linked = (
    await tx.cmsEntrySite.findMany({ where: { projectId: scope.projectId, entryId: entry.id }, select: { siteId: true } })
  )
    .map((l) => l.siteId)
    .sort();
  if (linked.join() !== siteIds.join()) {
    const issues = [{ code: "CMS_SITES_CHANGED" }];
    await needsAttention(tx, scope, entry, pubs, "CMS_SITES_CHANGED", issues);
    return issues;
  }

  const previous = entry.publishedRevisionId
    ? await tx.cmsRevision.findFirst({ where: { id: entry.publishedRevisionId, projectId: scope.projectId }, select: { slug: true, number: true } })
    : null;
  const previousPaths = new Map(previous ? (await entryPaths(tx, scope, entry, previous.slug)).map((p) => [p.siteId, p.path]) : []);
  const now = new Date();
  const ref = { id: entry.id, type: entry.type, locale: entry.locale };
  const redirects: Array<{ siteId: string; fromPath: string; toPath: string | null; code: 301 | 410 }> = [];
  const dropped: Array<{ siteId: string; path: string }> = [];
  let liveSlug: string | null = null;
  let liveNumber: number | null = null;

  if (action === "unpublish") {
    if (!previous) {
      const issues = [{ code: "CMS_ENTRY_NOT_LIVE" }];
      await needsAttention(tx, scope, entry, pubs, "CMS_ENTRY_NOT_LIVE", issues);
      return issues;
    }
    const replacement = options.replacementEntryId
      ? await tx.cmsEntry.findFirst({ where: { id: options.replacementEntryId, projectId: scope.projectId } })
      : null;
    const replacementSlug = replacement?.publishedRevisionId
      ? (await tx.cmsRevision.findFirst({ where: { id: replacement.publishedRevisionId }, select: { slug: true } }))?.slug
      : undefined;
    const replacementPaths = new Map(
      replacement && replacementSlug ? (await entryPaths(tx, scope, replacement, replacementSlug)).map((p) => [p.siteId, p.path]) : [],
    );
    await tx.cmsEntry.update({
      where: { id: entry.id },
      data: { publishedRevisionId: null, scheduledRevisionId: null, scheduledAt: null, status: "archived", archivedAt: now, version: { increment: 1 } },
    });
    await redirectWithdrawn(tx, scope, ref, previous.slug, replacementSlug ? replacement!.id : null);
    for (const [siteId, fromPath] of previousPaths) {
      const toPath = replacementSlug ? (replacementPaths.get(siteId) ?? null) : null;
      redirects.push({ siteId, fromPath, toPath, code: replacementSlug ? 301 : 410 });
    }
  } else {
    const revision = await tx.cmsRevision.findFirst({ where: { id: first!.revisionId!, projectId: scope.projectId, entryId: entry.id } });
    if (!revision) throw notFound("CMS_REVISION_NOT_FOUND");
    const issues = await preflight(tx, scope, entry, revision, siteIds);
    if (issues.length) {
      await needsAttention(tx, scope, entry, pubs, issues[0]!.code, issues);
      return issues;
    }
    await tx.cmsEntry.update({
      where: { id: entry.id },
      data: {
        publishedRevisionId: revision.id,
        scheduledRevisionId: null,
        scheduledAt: null,
        status: "published",
        archivedAt: null,
        firstPublishedAt: entry.firstPublishedAt ?? now,
        lastPublishedAt: now,
        version: { increment: 1 },
      },
    });
    if (previous && previous.slug !== revision.slug) {
      await redirectSlugChange(tx, scope, ref, previous.slug, revision.slug);
      const next = new Map((await entryPaths(tx, scope, entry, revision.slug)).map((p) => [p.siteId, p.path]));
      for (const [siteId, fromPath] of previousPaths) {
        const toPath = next.get(siteId);
        if (toPath && toPath !== fromPath) redirects.push({ siteId, fromPath, toPath, code: 301 });
      }
    } else await clearRedirectsAt(tx, scope, ref, revision.slug);
    liveSlug = revision.slug;
    liveNumber = revision.number;
    // Sites that showed the previous revision but are not part of this one
    // stop showing the entry: their old address answers 410 (CH1.12).
    if (previous) dropped.push(...(await withdrawFromDroppedSites(tx, scope, entry, previous.slug, siteIds)));
    for (const d of dropped) redirects.push({ siteId: d.siteId, fromPath: d.path, toPath: null, code: 410 });
  }

  await tx.cmsPublication.updateMany({
    where: { id: { in: pubs.map((p) => p.id) }, fence },
    data: { status: "visible", visibleAt: now, fence: null, errorCode: null, version: { increment: 1 } },
  });
  const durationMs = Date.now() - started;
  for (const pub of pubs) await attempt(tx, scope, pub.id, "switch", "ok", { durationMs });

  const type = action === "unpublish" ? "cms.entry.unpublished" : action === "update" ? "cms.entry.updated" : "cms.entry.published";
  await event(tx, scope, type, entry.id, { revision: liveNumber, previousRevision: previous?.number ?? null, sites: siteIds.length });
  await audit(tx, scope, type, entry.id, { revision: liveNumber, previousRevision: previous?.number ?? null, sites: siteIds.length });
  const paths = new Map(liveSlug ? (await entryPaths(tx, scope, entry, liveSlug)).map((p) => [p.siteId, p.path]) : []);
  // Sites hear about it through their notifiers (CH1.11).
  const notified = await notifySites(
    tx,
    scope,
    type,
    siteIds.map((siteId) => {
      const path = paths.get(siteId) ?? null;
      const before = previousPaths.get(siteId) ?? null;
      return {
        siteId,
        payload: {
          siteId,
          entry: { id: entry.id, type: entry.type, locale: entry.locale, slug: liveSlug, path, revision: liveNumber },
          previousPath: before && before !== path ? before : null,
          tags: tagsOf(entry, siteId),
        },
      };
    }),
  );
  await notifySites(
    tx,
    scope,
    "cms.entry.unpublished",
    dropped.map((d) => ({
      siteId: d.siteId,
      payload: {
        siteId: d.siteId,
        entry: { id: entry.id, type: entry.type, locale: entry.locale, slug: null, path: null, revision: null },
        previousPath: d.path,
        tags: tagsOf(entry, d.siteId),
      },
    })),
  );
  await notifySites(
    tx,
    scope,
    "cms.redirect.created",
    redirects.map((r) => ({
      siteId: r.siteId,
      payload: { siteId: r.siteId, fromPath: r.fromPath, toPath: r.toPath, code: r.code, tags: [`orbit:redirects:${r.siteId}`] },
    })),
  );
  // "notified": the site's notifications are queued; delivery has its own log.
  const toldPubs = pubs.filter((p) => notified.has(p.siteId));
  if (toldPubs.length)
    await tx.cmsPublication.updateMany({
      where: { id: { in: toldPubs.map((p) => p.id) }, status: "visible" },
      data: { status: "notified", notifiedAt: new Date(), version: { increment: 1 } },
    });
  for (const pub of pubs)
    await attempt(tx, scope, pub.id, "notify", notified.has(pub.siteId) ? "ok" : "skipped", notified.has(pub.siteId) ? {} : { errorCode: "CMS_NO_NOTIFIER" });
  await scheduleLiveChecks(tx, scope, pubs.map((p) => p.id));
  return [];
}

/**
 * The sites that showed the entry's live revision and are not in the new
 * batch: a 410 at the entry's old path there. Returns them with that path.
 */
async function withdrawFromDroppedSites(tx: DbTx, scope: Scope, entry: EntryRow, previousSlug: string, siteIds: readonly string[]) {
  const before = await tx.cmsPublication.findMany({
    where: {
      projectId: scope.projectId,
      entryId: entry.id,
      revisionId: entry.publishedRevisionId,
      status: { in: ["visible", "notified", "live_verified"] },
      siteId: { notIn: [...siteIds] },
    },
    select: { siteId: true },
    distinct: ["siteId"],
  });
  if (!before.length) return [];
  const sites = await tx.cmsSite.findMany({ where: { projectId: scope.projectId, id: { in: before.map((b) => b.siteId) }, archivedAt: null } });
  const out: Array<{ siteId: string; path: string }> = [];
  for (const site of sites) {
    let path: string;
    try {
      path = entryPath(siteRoutes.parse(site.routes), entry.type, entry.locale, previousSlug, site.trailingSlash);
    } catch {
      continue;
    }
    await tx.cmsRedirect.updateMany({
      where: { projectId: scope.projectId, siteId: site.id, fromPath: path, removedAt: null },
      data: { removedAt: new Date() },
    });
    await tx.cmsRedirect.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        siteId: site.id,
        fromPath: path,
        code: 410,
        reason: "archived",
        createdBy: scope.userId,
      },
    });
    out.push({ siteId: site.id, path });
  }
  return out;
}

/** A scheduled batch past the late window waits for a person (nothing goes live). */
export async function markLate(tx: DbTx, scope: Scope, entry: EntryRow, publicationIds: readonly string[]) {
  const pubs = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, entryId: entry.id, id: { in: [...publicationIds] }, status: "queued" },
  });
  if (pubs.length) await needsAttention(tx, scope, entry, pubs, "CMS_PUBLICATION_LATE", [], "schedule");
}

// --- Cancel -----------------------------------------------------------------

/** Ends the entry's schedule and queued publications (nothing goes live). */
export async function cancelSchedule(tx: DbTx, scope: Scope, entry: EntryRow) {
  const cancelled = await cancelQueued(tx, scope, entry.id, "CMS_CANCELLED");
  if (entry.scheduledRevisionId) await clearSchedule(tx, entry);
  return cancelled;
}

// --- Reading ----------------------------------------------------------------

const publicationView = (row: PublicationRow) => ({
  id: row.id,
  entryId: row.entryId,
  revisionId: row.revisionId,
  siteId: row.siteId,
  action: row.action,
  status: row.status,
  approvalRequestId: row.approvalRequestId,
  scheduledAt: row.scheduledAt.toISOString(),
  visibleAt: row.visibleAt?.toISOString() ?? null,
  notifiedAt: row.notifiedAt?.toISOString() ?? null,
  liveVerifiedAt: row.liveVerifiedAt?.toISOString() ?? null,
  errorCode: row.errorCode,
  attempts: row.attempts,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const listInput = z
  .object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

/** The entry's publications, newest first. */
export async function listPublications(tx: DbTx, scope: Scope, entryId: string, raw: unknown) {
  const input = listInput.parse(raw ?? {});
  if (!UUID_RE.test(entryId)) throw notFound();
  const rows = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, entryId, ...(input.before ? { createdAt: { lt: new Date(input.before) } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  return { items: page.map(publicationView), nextBefore: rows.length > input.limit ? page[page.length - 1]!.createdAt.toISOString() : null };
}

/** One publication with its step log. */
export async function getPublication(tx: DbTx, scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw notFound("CMS_PUBLICATION_NOT_FOUND");
  const row = await tx.cmsPublication.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw notFound("CMS_PUBLICATION_NOT_FOUND");
  const steps = await tx.cmsPublicationAttempt.findMany({
    where: { projectId: scope.projectId, publicationId: id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return {
    ...publicationView(row),
    steps: steps.map((s) => ({
      step: s.step,
      outcome: s.outcome,
      httpStatus: s.httpStatus,
      errorCode: s.errorCode,
      durationMs: s.durationMs,
      detail: s.detail as Record<string, unknown>,
      at: s.createdAt.toISOString(),
    })),
  };
}

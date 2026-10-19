import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type {
  ImpactHandler,
  Scope,
} from "../../../../../../packages/knowledge/src/index.ts";

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const where = (s: Scope) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
});
// Publication states whose remote outcome must be reconciled.
const REMOTE = [
  "sending",
  "outcome_unknown",
  "scheduled_remote",
  "published",
  "reconciliation_required",
  "cancellation_required",
];
// Execution receipts that keep their status.
const TERMINAL = [
  "published_test",
  "published",
  "cancelled",
  "canceled",
  "deleted",
];
// Fields a purge empties on content and insights.
const PURGED = {
  text: "",
  body: "",
  title: "Removed source dependency",
  claims: [],
  sources: [],
  outline: [],
  description: "",
  altText: "",
  subject: "",
  previewText: "",
  summary: "",
  rationale: "",
};

/** Same history as the knowledge engine's revisions: the old version is kept. */
async function revise(tx: DbTx, s: Scope, id: string, data: unknown) {
  const old = await tx.entity.findFirstOrThrow({ where: { ...where(s), id } });
  await tx.entityVersion.createMany({
    data: [
      {
        ...where(s),
        entityId: id,
        version: old.version,
        data: old.data as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return tx.entity.update({
    where: { id },
    data: { version: { increment: 1 }, data: json(data) },
  });
}

/**
 * Marketing's part of a knowledge invalidation (WP3.1, plans 05 §4): content
 * built on invalidated evidence needs review, its approvals are invalidated,
 * insights retracted, publications blocked or sent to reconciliation, and
 * dependent jobs fenced. Registered by the marketing module; it runs even
 * when marketing is disabled for the project, so content that was dormant
 * meanwhile can never be published on revoked evidence.
 */
export const invalidateMarketingForKnowledge: ImpactHandler = async (
  tx,
  s,
  { sourceId, reason, purge, evidenceIds: evidence },
) => {
  const evidenceIds = new Set(evidence);
  const all = await tx.entity.findMany({
    where: {
      ...where(s),
      kind: {
        in: ["content", "approvals", "publications", "insights", "jobs"],
      },
    },
  });
  const contentIds = new Set(
    all
      .filter(
        (e) =>
          e.kind === "content" &&
          evidenceIds.has(
            String((e.data as Record<string, unknown>).evidenceId),
          ),
      )
      .map((e) => e.id),
  );
  for (const e of all) {
    const d = e.data as Record<string, unknown>;
    const related =
      d.sourceId === sourceId ||
      d.resourceId === sourceId ||
      contentIds.has(String(d.resourceId)) ||
      evidenceIds.has(String(d.resourceId)) ||
      evidenceIds.has(String(d.evidenceId)) ||
      contentIds.has(e.id) ||
      contentIds.has(String(d.contentId)) ||
      (Array.isArray(d.sourceIds) && d.sourceIds.includes(sourceId));
    if (!related) continue;
    const purged = purge && ["content", "insights"].includes(e.kind);
    let status =
      e.kind === "content"
        ? "needs_review"
        : e.kind === "approvals"
          ? "invalidated"
          : e.kind === "insights"
            ? "retracted"
            : "blocked_dependency";
    // Archived content stays archived: an invalidation marks it but never
    // puts it back on the approvals page. Purged content is archived as
    // well, since with its text removed there is nothing left to review.
    const archiveContent =
      e.kind === "content" && (String(d.status) === "archived" || purged);
    if (archiveContent) status = "archived";
    const needsRemoteReconcile =
      e.kind === "publications" && REMOTE.includes(String(d.status));
    if (needsRemoteReconcile) status = "reconciliation_required";
    if (e.kind === "publications" && TERMINAL.includes(String(d.status)))
      status = String(d.status);
    // A local publication of purged content can never go out: canceled, not
    // blocked, so it holds no slot and keeps no draft.
    else if (e.kind === "publications" && purge && !needsRemoteReconcile)
      status = "canceled";
    if (
      e.kind === "jobs" &&
      ["completed", "cancelled", "canceled"].includes(String(d.status))
    )
      status = String(d.status);
    await revise(tx, s, e.id, {
      ...d,
      status,
      invalidationReason: reason,
      dependencyInvalidated: true,
      ...(needsRemoteReconcile ? { reconciliationStatus: "required" } : {}),
      ...(purged ? PURGED : {}),
      ...(archiveContent && String(d.status) !== "archived"
        ? {
            statusBeforeArchive: String(d.status),
            archivedAt: new Date().toISOString(),
            archiveReason: "SOURCE_REMOVED",
          }
        : {}),
    });
    if (purged)
      await tx.entityVersion.deleteMany({
        where: { ...where(s), entityId: e.id },
      });
    if (needsRemoteReconcile) {
      const idempotencyKey =
        "knowledge-reconcile:" + e.id + ":" + (e.version + 1);
      const existing = await tx.entity.findFirst({
        where: {
          ...where(s),
          kind: "jobs",
          data: { path: ["idempotencyKey"], equals: idempotencyKey },
        },
      });
      if (!existing) {
        const job = await tx.entity.create({
          data: {
            ...where(s),
            kind: "jobs",
            data: {
              topic: "reconciliation",
              resourceId: e.id,
              status: "queued",
              attempts: 0,
              maxAttempts: 3,
              idempotencyKey,
              reason,
            },
          },
        });
        await tx.outbox.create({
          data: {
            ...where(s),
            topic: "reconciliation",
            entityId: job.id,
            payload: { jobId: job.id },
          },
        });
      }
    }
  }
  return { contentIds: [...contentIds] };
};

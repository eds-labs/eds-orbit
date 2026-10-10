import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, list, update } from "../shared.ts";
import { markMissionArchived } from "./mission-archive.ts";

/** The content statuses the approvals page lists; these are the old drafts. */
export const DRAFT_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
] as const;
// A publication in any other status (intent_created, scheduled_remote,
// sending, outcome_unknown, blocked_dependency, ...) may still go out.
const FINAL_PUBLICATION = ["published", "published_test", "canceled", "failed"];
const OPEN_POSTIZ_DRAFT = ["sending", "outcome_unknown"];
const ENDED_RUN = ["done", "canceled"];
const ACTIVE_JOB = ["queued", "running", "retry_scheduled"];
// A mission is done with its content once every row is in one of these.
const SETTLED_CONTENT = [
  "archived",
  "exported",
  "published",
  "published_test",
  "rejected",
  "canceled",
  "failed",
];
const REASON = "OWNER_CLEANUP";
const ARCHIVE_FIELDS = [
  "statusBeforeArchive",
  "archivedAt",
  "archivedBy",
  "archiveReason",
  "cleanupId",
] as const;

export const KEEP_REASONS = [
  "HAS_OPEN_PUBLICATION",
  "HAS_OPEN_POSTIZ_DRAFT",
  "ACTIVE_ASSIGNMENT_RUN",
] as const;
type KeepReason = (typeof KEEP_REASONS)[number];
type MissionKind = "autopilot" | "package" | "other";
type Row = Awaited<ReturnType<typeof list>>[number];

export const draftCleanupInput = z
  .object({
    preview: z.boolean().default(false),
    confirm: z.literal(true).optional(),
  })
  .strict();
export const draftCleanupRestoreInput = z
  .object({ cleanupId: z.uuid() })
  .strict();

const missionKind = (mission: Record<string, any> | undefined): MissionKind =>
  mission?.autopilot === true
    ? "autopilot"
    : typeof mission?.packageId === "string"
      ? "package"
      : "other";

const tally = <K extends string>(keys: readonly K[], values: K[]) =>
  Object.fromEntries(
    keys.map((key) => [key, values.filter((v) => v === key).length]),
  ) as Record<K, number>;

/** Works out what one cleanup archives and keeps; it changes nothing. */
async function plan(tx: DbTx, scope: Scope) {
  // One query at a time: the interactive transaction runs them in order anyway.
  const read: Row[][] = [];
  for (const kind of [
    "content",
    "missions",
    "publications",
    "postiz_drafts",
    "assignment_runs",
    "jobs",
  ])
    read.push(await list(tx, scope, kind));
  const [content, missions, publications, postizDrafts, runs, jobs] = read;
  const contentIds = (rows: Row[], open: (status: string) => boolean) =>
    new Set(
      rows
        .filter((row) => open(String(data(row).status)))
        .map((row) => String(data(row).contentId)),
    );
  const openPublication = contentIds(
    publications!,
    (status) => !FINAL_PUBLICATION.includes(status),
  );
  const openPostizDraft = contentIds(postizDrafts!, (status) =>
    OPEN_POSTIZ_DRAFT.includes(status),
  );
  const activeRuns = new Set(
    runs!
      .filter((run) => !ENDED_RUN.includes(String(data(run).status)))
      .map((run) => run.id),
  );
  const keepReason = (row: Row): KeepReason | null => {
    if (openPublication.has(row.id)) return "HAS_OPEN_PUBLICATION";
    if (openPostizDraft.has(row.id)) return "HAS_OPEN_POSTIZ_DRAFT";
    if (activeRuns.has(String(data(row).assignmentRunId)))
      return "ACTIVE_ASSIGNMENT_RUN";
    return null;
  };
  const missionById = new Map(missions!.map((m) => [m.id, data(m)]));
  const drafts = content!.filter((row) =>
    (DRAFT_STATUSES as readonly string[]).includes(String(data(row).status)),
  );
  const archive: Row[] = [];
  const kept: { row: Row; reason: KeepReason }[] = [];
  for (const row of drafts) {
    const reason = keepReason(row);
    if (reason) kept.push({ row, reason });
    else archive.push(row);
  }
  const archiving = new Set(archive.map((row) => row.id));
  const busy = new Set(
    jobs!
      .filter((job) => ACTIVE_JOB.includes(String(data(job).status)))
      .map((job) => String(data(job).resourceId)),
  );
  // Missions whose content would all be archived or settled afterwards.
  const missionArchive = missions!.filter((m) => {
    const v = data(m);
    if (v.status !== "ready" || busy.has(m.id)) return false;
    if (activeRuns.has(String(v.assignmentRunId))) return false;
    return content!.every(
      (row) =>
        data(row).missionId !== m.id ||
        archiving.has(row.id) ||
        SETTLED_CONTENT.includes(String(data(row).status)),
    );
  });
  const contentKind = (row: Row) =>
    missionKind(missionById.get(String(data(row).missionId)));
  const kinds = ["autopilot", "package", "other"] as const;
  return {
    archive,
    missionArchive,
    summary: {
      content: {
        total: archive.length,
        byStatus: tally(
          DRAFT_STATUSES,
          archive.map((row) => data(row).status),
        ),
        byMissionKind: tally(kinds, archive.map(contentKind)),
      },
      missions: {
        total: missionArchive.length,
        byMissionKind: tally(
          kinds,
          missionArchive.map((m) => missionKind(data(m))),
        ),
      },
      kept: {
        total: kept.length,
        byReason: tally(
          KEEP_REASONS,
          kept.map((k) => k.reason),
        ),
      },
    },
  };
}

/**
 * The owner's clean start: archives every old draft the approvals page lists
 * and the ready missions left without work, in one transaction. Archiving is
 * reversible (`restoreDraftCleanup`) and deletes nothing; publications,
 * Postiz drafts, jobs, costs and audits stay untouched. Drafts tied to a
 * publication that may still go out, a Postiz draft whose outcome is open or
 * an active assignment run are kept. `preview` only counts.
 */
export async function archiveOldDrafts(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = draftCleanupInput.parse(raw);
  const planned = await plan(tx, scope);
  if (input.preview)
    return {
      preview: true,
      cleanupId: null as string | null,
      ...planned.summary,
    };
  if (input.confirm !== true)
    throw new DomainError("CLEANUP_CONFIRMATION_REQUIRED", 409);
  if (!planned.archive.length && !planned.missionArchive.length)
    return {
      preview: false,
      cleanupId: null as string | null,
      ...planned.summary,
    };
  const cleanupId = randomUUID();
  const archivedAt = new Date().toISOString();
  for (const row of planned.archive) {
    const v = data(row);
    await update(tx, scope, row, {
      ...v,
      status: "archived",
      statusBeforeArchive: v.status,
      archivedAt,
      archivedBy: scope.userId,
      archiveReason: REASON,
      cleanupId,
    });
  }
  for (const mission of planned.missionArchive)
    await markMissionArchived(tx, scope, mission, {
      archiveReason: REASON,
      cleanupId,
    });
  await audit(tx, scope, "drafts.cleaned_up", cleanupId, {
    cleanupId,
    ...planned.summary,
  });
  return { preview: false, cleanupId, ...planned.summary };
}

const withoutArchive = (value: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !(ARCHIVE_FIELDS as readonly string[]).includes(key),
    ),
  );

/**
 * Returns exactly the content and missions of one cleanup to the status they
 * had. Rows changed since (restored, or no longer archived) are left alone,
 * so a second call restores nothing.
 */
export async function restoreDraftCleanup(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const { cleanupId } = draftCleanupRestoreInput.parse(raw);
  const restored = { content: 0, missions: 0 };
  for (const kind of ["content", "missions"] as const)
    for (const row of await list(tx, scope, kind)) {
      const v = data(row);
      if (
        v.status !== "archived" ||
        v.cleanupId !== cleanupId ||
        typeof v.statusBeforeArchive !== "string"
      )
        continue;
      await update(tx, scope, row, {
        ...withoutArchive(v),
        status: v.statusBeforeArchive,
      });
      restored[kind] += 1;
    }
  if (restored.content || restored.missions)
    await audit(tx, scope, "drafts.cleanup_restored", cleanupId, {
      cleanupId,
      ...restored,
    });
  return { cleanupId, restored };
}

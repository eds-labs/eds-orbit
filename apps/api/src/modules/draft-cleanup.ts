import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, list, update } from "../shared.ts";
import { TERMINAL_RUN } from "./agents/assignment-runs.ts";
import { awaitsScheduling } from "./agents/veto.ts";
import { DRAFT_STATUSES } from "./draft-statuses.ts";
import { markMissionArchived } from "./mission-archive.ts";

export { DRAFT_STATUSES };
// A publication in any other status (intent_created, scheduled_remote,
// sending, outcome_unknown, blocked_dependency, ...) may still go out.
const FINAL_PUBLICATION = ["published", "published_test", "canceled", "failed"];
const OPEN_POSTIZ_DRAFT = ["sending", "outcome_unknown"];
// An approved request may still be executed; a pending one decided.
const OPEN_REQUEST = ["pending", "approved"];
// Jobs that may still run for a mission; a blocked one can be retried.
const ACTIVE_JOB = [
  "queued",
  "running",
  "retry_scheduled",
  "blocked_dependency",
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
  "PENDING_DECISION",
  "ACTIVE_ASSIGNMENT_RUN",
] as const;
type KeepReason = (typeof KEEP_REASONS)[number];
type MissionKind = "autopilot" | "package" | "other";
type Row = Awaited<ReturnType<typeof list>>[number];

const count = z.number().int().min(0);
export const draftCleanupInput = z
  .object({
    preview: z.boolean().default(false),
    confirm: z.literal(true).optional(),
    // The counts the owner confirmed; a fresh plan must match them.
    expected: z
      .object({ content: count, missions: count, kept: count })
      .strict()
      .optional(),
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
async function plan(tx: DbTx, scope: Scope, at = Date.now()) {
  // One query at a time: the interactive transaction runs them in order anyway.
  const read: Row[][] = [];
  for (const kind of [
    "content",
    "missions",
    "publications",
    "postiz_drafts",
    "action_requests",
    "assignment_runs",
    "jobs",
  ])
    read.push(await list(tx, scope, kind));
  const [content, missions, publications, postizDrafts, requests, runs, jobs] =
    read as [Row[], Row[], Row[], Row[], Row[], Row[], Row[]];
  const contentIds = (rows: Row[], open: (v: Record<string, any>) => boolean) =>
    new Set(
      rows
        .filter((row) => open(data(row)))
        .map((row) => String(data(row).contentId)),
    );
  const openPublication = contentIds(
    publications,
    (v) => !FINAL_PUBLICATION.includes(v.status),
  );
  const openPostizDraft = contentIds(postizDrafts, (v) =>
    OPEN_POSTIZ_DRAFT.includes(v.status),
  );
  const inPostiz = contentIds(postizDrafts, (v) => v.status === "accepted");
  const pendingDecision = new Set(
    requests
      .filter((row) => {
        const v = data(row);
        return (
          OPEN_REQUEST.includes(v.status) &&
          !(Date.parse(v.expiresAt) <= at) &&
          typeof v.payload?.contentId === "string"
        );
      })
      .map((row) => String(data(row).payload.contentId)),
  );
  // Runs still working, and finished runs the sweep is about to schedule.
  const activeRuns = new Set(
    runs
      .filter(
        (run) =>
          !TERMINAL_RUN.includes(data(run).status) ||
          awaitsScheduling(data(run)),
      )
      .map((run) => run.id),
  );
  // Why a row must stay, by what references it; asked of any content row.
  const keepReason = (row: Row): KeepReason | null => {
    if (openPublication.has(row.id)) return "HAS_OPEN_PUBLICATION";
    if (openPostizDraft.has(row.id)) return "HAS_OPEN_POSTIZ_DRAFT";
    if (pendingDecision.has(row.id)) return "PENDING_DECISION";
    if (activeRuns.has(String(data(row).assignmentRunId)))
      return "ACTIVE_ASSIGNMENT_RUN";
    return null;
  };
  const missionById = new Map(missions.map((m) => [m.id, data(m)]));
  const archive: Row[] = [];
  const kept: { row: Row; reason: KeepReason }[] = [];
  for (const row of content) {
    if (!(DRAFT_STATUSES as readonly string[]).includes(data(row).status))
      continue;
    const reason = keepReason(row);
    if (reason) kept.push({ row, reason });
    else archive.push(row);
  }
  const busy = new Set(
    jobs
      .filter((job) => ACTIVE_JOB.includes(data(job).status))
      .map((job) => String(data(job).resourceId)),
  );
  const own = new Map<string, Row[]>();
  for (const row of content) {
    const id = String(data(row).missionId);
    if (missionById.has(id)) own.set(id, [...(own.get(id) ?? []), row]);
  }
  // A ready mission goes once it has content and none of it must stay: a
  // draft without a reason is archived now, any other row is settled.
  const missionArchive = missions.filter((m) => {
    const v = data(m);
    const rows = own.get(m.id) ?? [];
    return (
      v.status === "ready" &&
      v.batch?.status !== "running" &&
      !busy.has(m.id) &&
      !activeRuns.has(String(v.assignmentRunId)) &&
      rows.length > 0 &&
      rows.every((row) => keepReason(row) === null)
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
        // Already handed to Postiz as a draft; it stays there unchanged.
        alreadyInPostiz: archive.filter((row) => inPostiz.has(row.id)).length,
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
 * Postiz drafts, action requests, jobs, costs and audits stay untouched.
 * Drafts tied to a publication that may still go out, a Postiz draft whose
 * outcome is open, an open decision or an active assignment run are kept.
 * `preview` only counts; the real run needs `confirm` and the counts the
 * owner saw, and refuses with CLEANUP_CHANGED when a fresh plan differs.
 */
export async function archiveOldDrafts(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = draftCleanupInput.parse(raw);
  const planned = await plan(tx, scope);
  const answer = (cleanupId: string | null) => ({
    preview: input.preview,
    cleanupId,
    ...planned.summary,
  });
  if (input.preview) return answer(null);
  if (input.confirm !== true || !input.expected)
    throw new DomainError("CLEANUP_CONFIRMATION_REQUIRED", 409);
  const { summary } = planned;
  if (
    input.expected.content !== summary.content.total ||
    input.expected.missions !== summary.missions.total ||
    input.expected.kept !== summary.kept.total
  )
    throw new DomainError("CLEANUP_CHANGED", 409);
  if (!planned.archive.length && !planned.missionArchive.length)
    return answer(null);
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
    ...summary,
  });
  return answer(cleanupId);
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

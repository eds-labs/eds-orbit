import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  preference,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  update,
} from "../../shared.ts";
import { activePolicy } from "../policy.ts";
import { errorCode } from "../telemetry.ts";
import { enqueue, publishIntent } from "../workflow.ts";
import { agentReviewAccepted } from "./agent-review.ts";
import { SLOT_STEP_MS, SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import { agentsEnabled } from "./assignments.ts";
import {
  withdrawPublication,
  type WithdrawReason,
} from "./package-schedule.ts";
import { notify } from "./notifications.ts";
import { localDate, slotContext, slotStatus } from "./scheduling.ts";

/**
 * Scheduling with the veto window (Orbit Agents, spec §9). When a run's
 * review has approved drafts, each approved social draft gets a publication
 * on the existing publisher path with `vetoDeadline = slot − vetoMinutes`,
 * and a preview is queued for the owner's Telegram bot. A draft that is
 * reviewed too late for the full window moves to the next free slot of its
 * day (quota, spacing, quiet hours, calendar and the slots of every other
 * assignment); without one it is dropped with a recorded reason. Until the
 * deadline the owner may stop the post (`vetoPublication`); claimPublication
 * hands it over only after the deadline without a stop (R4), and preflight
 * accepts the window in place of a package approval only then (R52). Blog and
 * newsletter drafts are never published: the review saves them to Drive.
 */
const RUNS = "assignment_runs";
const PUBLICATIONS = "publications";
// The publication is out of Orbit's hands from the claim on.
const INACTIVE = ["canceled", "failed", "blocked_dependency"];

/**
 * A publication Orbit still holds (R56 allow-list): not claimed for Postiz.
 * A blocked one counts only if it was never claimed (`handoffAt`), since a
 * changed content can block a post in the middle of its send.
 */
export const withdrawable = (pub: Record<string, any>) =>
  pub.status === "intent_created" ||
  (pub.status === "blocked_dependency" &&
    !pub.handoffAt &&
    !pub.remoteId &&
    !pub.handoffCompletedAt);
// Drafts that still wait for a decision keep their slot.
const PENDING_DRAFT = ["draft", "needs_review", "reviewed"];
// Same tolerance after the slot as the mission the copywriter creates.
const SLOT_WINDOW_MS = 2 * 3600000;
// A stop's reason stays a proposed preference this long.
const PREFERENCE_DAYS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RunSlot = {
  channel: string;
  at: string;
  // The slot the run was given, when the post moved for its veto window.
  requestedAt?: string;
  publicationId?: string;
  releasedAt?: string;
  releaseReason?: string;
};
type Dropped = {
  contentId: string;
  briefKey: string | null;
  channel: string;
  requestedAt: string;
  code: string;
  at: string;
};

const slotKey = (channel: string, at: string) =>
  `${channel}@${new Date(at).toISOString()}`;

/** Rows of a kind whose JSON field equals a value, oldest first. */
const rowsWhere = (
  tx: DbTx,
  scope: Scope,
  kind: string,
  field: string,
  value: string,
) =>
  tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      data: { path: [field], equals: value },
    },
    orderBy: { createdAt: "asc" },
  });

/**
 * The time a deliverable can go out with its full veto window: its own slot,
 * or the next free half hour after it on the same local day, under the same
 * rules as every other post. Of its own run only the slots still held in
 * this pass count (`held`, keys `channel@at`), never the deliverable's own.
 */
async function vetoSlot(
  tx: DbTx,
  scope: Scope,
  runId: string,
  channel: string,
  slot: Date,
  vetoMs: number,
  now: Date,
  held: Set<string>,
) {
  const ctx = await slotContext(tx, scope, now);
  const own = {
    ...ctx,
    runs: ctx.runs.filter(
      (other) =>
        other.id !== runId ||
        (held.has(slotKey(other.channel, other.at.toISOString())) &&
          !(
            other.channel === channel && other.at.valueOf() === slot.valueOf()
          )),
    ),
  };
  const date = localDate(slot, ctx.timezone);
  for (
    let candidate = slot;
    localDate(candidate, ctx.timezone) === date;
    candidate = new Date(candidate.valueOf() + SLOT_STEP_MS)
  ) {
    if (candidate.valueOf() - vetoMs < now.valueOf()) continue;
    const status = await slotStatus(own, channel, candidate);
    // The veto window is this post's lead time, not the package slots' two hours.
    if (status.reasons.every((reason) => reason === "TOO_SOON"))
      return candidate;
  }
  return null;
}

/** Moves the draft and its draft-only mission to `target`, so preflight checks the post at its new slot. */
async function moveDraft(
  tx: DbTx,
  scope: Scope,
  content: Awaited<ReturnType<typeof entity>>,
  mission: Awaited<ReturnType<typeof entity>>,
  target: Date,
) {
  const iso = target.toISOString();
  const m = data(mission);
  if (m.plannedSlotAt !== iso) {
    const policy = await activePolicy(tx, scope);
    const policyEnd = Date.parse(policy ? data(policy).endAt : "");
    const endAt = Math.max(
      Date.parse(m.endAt),
      Math.min(
        target.valueOf() + SLOT_WINDOW_MS,
        Number.isFinite(policyEnd) ? policyEnd : Infinity,
      ),
    );
    await update(tx, scope, mission, {
      ...m,
      plannedSlotAt: iso,
      endAt: new Date(endAt).toISOString(),
    });
  }
  if (data(content).scheduledAt === iso) return content;
  return update(tx, scope, content, { ...data(content), scheduledAt: iso });
}

/**
 * Creates one publication per approved social draft of a run, with the veto
 * window, and queues its preview (`telegram_notification`,
 * `notify:preview:<publicationId>`, sent by the bot in Task 13). Approved
 * means: reviewed, and the agent review is accepted (spec §6); drafts left
 * for the owner or rejected are not scheduled. The run's slots record the
 * publication, the move or the release, and the run keeps the result in
 * `scheduling` and the success marker `scheduledAt` (R54), which is written
 * with the rest or not at all. Calling it again creates nothing new and
 * returns the run's publications that are still active.
 */
export async function scheduleApproved(tx: DbTx, scope: Scope, runId: string) {
  if (!agentsEnabled()) return [];
  // One booking at a time per project: two runs, or the sweep and a task
  // completion, never take the same slot (same lock as scoped()).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId},0))`;
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${runId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const run = await entity(tx, scope, RUNS, runId);
  const r = data(run);
  const assignmentRow = await entity(tx, scope, "assignments", r.assignmentId);
  const assignment = data(assignmentRow);
  // Blog and newsletter drafts were saved to Drive by the review; they are never published.
  if (assignment.contentType !== "social") {
    if (!r.scheduledAt)
      await update(tx, scope, run, {
        ...r,
        scheduledAt: new Date().toISOString(),
      });
    return [];
  }
  const vetoMs = Number(assignment.vetoMinutes ?? 180) * 60000;
  const existing = await rowsWhere(
    tx,
    scope,
    PUBLICATIONS,
    "assignmentRunId",
    runId,
  );
  const drafts = (
    await rowsWhere(tx, scope, "content", "assignmentRunId", runId)
  ).sort((a, b) =>
    String(data(a).scheduledAt ?? "").localeCompare(
      String(data(b).scheduledAt ?? ""),
    ),
  );
  const slots: RunSlot[] = ((r.slots ?? []) as RunSlot[]).map((slot) => ({
    ...slot,
  }));
  const dropped: Dropped[] = [...(r.scheduling?.dropped ?? [])];
  const scheduled: Array<Awaited<ReturnType<typeof entity>>> = [];
  for (const draft of drafts) {
    const own = existing.find((pub) => data(pub).contentId === draft.id);
    if (own) {
      if (!INACTIVE.includes(data(own).status)) scheduled.push(own);
      continue;
    }
    const c = data(draft);
    if (
      dropped.some((entry) => entry.contentId === draft.id) ||
      c.type !== "social" ||
      c.status !== "reviewed" ||
      c.supersededBy ||
      !(await agentReviewAccepted(tx, scope, c))
    )
      continue;
    const mission = await entity(tx, scope, "missions", c.missionId);
    const planned = new Date(data(mission).plannedSlotAt);
    const index = slots.findIndex(
      (slot) =>
        slot.channel === c.channel &&
        Date.parse(slot.at) === planned.valueOf() &&
        !slot.publicationId,
    );
    let failure: string | null = null;
    let publication: Awaited<ReturnType<typeof entity>> | null = null;
    let target: Date | null = null;
    // Read per draft: a long pass must not leave a late draft with a deadline already gone.
    const now = new Date();
    try {
      target = await vetoSlot(
        tx,
        scope,
        runId,
        c.channel,
        planned,
        vetoMs,
        now,
        // Slots of this run that got a publication or were released in this pass no longer hold.
        new Set(
          slots
            .filter((slot) => !slot.publicationId && !slot.releasedAt)
            .map((slot) => slotKey(slot.channel, slot.at)),
        ),
      );
      if (!target) failure = SLOT_UNAVAILABLE;
      else {
        const content = await moveDraft(tx, scope, draft, mission, target);
        publication = await publishIntent(tx, scope, {
          contentId: content.id,
          version: content.version,
          scheduledAt: target.toISOString(),
          vetoDeadline: new Date(target.valueOf() - vetoMs).toISOString(),
        });
      }
    } catch (error) {
      // A blocker drops this deliverable only; the others go on.
      if (!(error instanceof DomainError)) throw error;
      failure = error.message.slice(0, 200);
    }
    if (!publication || !target) {
      dropped.push({
        contentId: draft.id,
        briefKey: c.briefKey ?? null,
        channel: c.channel,
        requestedAt: planned.toISOString(),
        code: failure ?? SLOT_UNAVAILABLE,
        at: now.toISOString(),
      });
      if (index >= 0)
        slots[index] = {
          ...slots[index]!,
          releasedAt: now.toISOString(),
          releaseReason: failure ?? SLOT_UNAVAILABLE,
        };
      await audit(tx, scope, "assignment.deliverable_dropped", draft.id, {
        runId,
        assignmentId: r.assignmentId,
        channel: c.channel,
        requestedAt: planned.toISOString(),
        code: failure ?? SLOT_UNAVAILABLE,
      });
      await notify(tx, scope, "dropped", draft.id);
      continue;
    }
    const p = data(publication);
    if (index >= 0)
      slots[index] = {
        ...slots[index]!,
        at: p.scheduledAt,
        ...(p.scheduledAt !== slots[index]!.at
          ? { requestedAt: slots[index]!.at }
          : {}),
        publicationId: publication.id,
      };
    await enqueue(
      tx,
      scope,
      "telegram_notification",
      publication.id,
      `notify:preview:${publication.id}`,
    );
    // Every automatic approval is audited (spec §11).
    await audit(tx, scope, "publication.agent_scheduled", publication.id, {
      contentId: draft.id,
      runId,
      assignmentId: r.assignmentId,
      assignmentVersion: assignmentRow.version,
      assignmentHash: c.agentReview?.assignmentHash ?? null,
      reviewTaskId: c.agentReview?.taskId ?? null,
      deterministicProblems: c.agentReview?.deterministicProblems ?? null,
      scheduledAt: p.scheduledAt,
      requestedAt: planned.toISOString(),
      vetoDeadline: p.vetoDeadline,
    });
    scheduled.push(publication);
  }
  const now = new Date();
  // A slot without a publication and without a draft still waiting for a decision is free again.
  const waiting = new Set(
    drafts
      .filter(
        (draft) =>
          PENDING_DRAFT.includes(data(draft).status) &&
          !data(draft).supersededBy &&
          !existing.some((pub) => data(pub).contentId === draft.id) &&
          !dropped.some((entry) => entry.contentId === draft.id),
      )
      .map((draft) => String(data(draft).briefKey)),
  );
  for (const [index, slot] of slots.entries())
    if (
      !slot.publicationId &&
      !slot.releasedAt &&
      !waiting.has(slotKey(slot.channel, slot.at))
    )
      slots[index] = {
        ...slot,
        releasedAt: now.toISOString(),
        releaseReason: "NO_APPROVED_DRAFT",
      };
  const scheduling = {
    at: r.scheduling?.at ?? now.toISOString(),
    publicationIds: scheduled.map((pub) => pub.id),
    dropped,
  };
  if (
    !r.scheduledAt ||
    JSON.stringify(slots) !== JSON.stringify(r.slots ?? []) ||
    JSON.stringify(scheduling) !== JSON.stringify(r.scheduling ?? null)
  ) {
    // publishIntent does not touch the run; read it again all the same.
    const current = await entity(tx, scope, RUNS, runId);
    await update(tx, scope, current, {
      ...data(current),
      slots,
      scheduling,
      scheduledAt: r.scheduledAt ?? now.toISOString(),
    });
  }
  return scheduled;
}

/** A run that ended with its review done and has not been scheduled yet. */
function awaitsScheduling(run: Record<string, any>) {
  return (
    ["done", "partial"].includes(run.status) &&
    !run.scheduledAt &&
    ((run.steps ?? []) as Array<Record<string, any>>).some(
      (step) => step.role === "review" && step.status === "done",
    )
  );
}

/**
 * Schedules a run whose review just finished. Called in its own transaction
 * after the review task's result is saved (R54), so a failure here never
 * undoes the task; the sweep retries runs without the marker.
 */
export async function scheduleFinishedRun(
  tx: DbTx,
  scope: Scope,
  runId: string,
) {
  if (!agentsEnabled()) return [];
  const run = await entity(tx, scope, RUNS, runId);
  return awaitsScheduling(data(run)) ? scheduleApproved(tx, scope, runId) : [];
}

/**
 * Sweep retry (R54): schedules the recent runs that ended with their review
 * done but have no `scheduledAt` marker, e.g. because scheduling failed
 * after the review task was saved. A run that fails again is rolled back to
 * its savepoint, logged and left for the next sweep; the others go on.
 */
export async function scheduleUnscheduledRuns(tx: DbTx, scope: Scope) {
  if (!agentsEnabled()) return { scheduled: 0 };
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  // Runs of the last days only: older slots are gone anyway.
  const since = localDate(
    new Date(Date.now() - 2 * 86400000),
    project.timezone,
  );
  const runs = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: RUNS,
      data: { path: ["date"], gte: since },
    },
    orderBy: { createdAt: "asc" },
  });
  let scheduled = 0;
  for (const run of runs) {
    if (!awaitsScheduling(data(run))) continue;
    // Each run in its own savepoint (R58): a failure, also a database error
    // that would abort the sweep's transaction, undoes only this run's
    // bookings and leaves the rest of the sweep intact.
    await tx.$executeRaw`SAVEPOINT schedule_run`;
    try {
      await scheduleApproved(tx, scope, run.id);
      await tx.$executeRaw`RELEASE SAVEPOINT schedule_run`;
      scheduled++;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT schedule_run`;
      console.error(
        "Orbit assignment scheduling retry failed",
        errorCode(error),
      );
    }
  }
  return { scheduled };
}

/**
 * Stops one assignment post before its handoff (Telegram Stop or Orbit):
 * the publication is withdrawn with reason `VETOED` on the existing withdraw
 * path. Repeating the stop answers `vetoed` again and changes nothing; after
 * the handoff it answers `already_handed_over` and changes nothing. The
 * version binds the stop to the post the owner saw. A reason is kept as a
 * proposed preference for the owner to confirm.
 */
export async function vetoPublication(
  tx: DbTx,
  scope: Scope,
  publicationId: string,
  version: number,
  source: "telegram" | "orbit",
  reason?: string,
): Promise<{ result: "vetoed" | "already_handed_over" | "not_found" }> {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!UUID.test(publicationId)) return { result: "not_found" };
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${publicationId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const row = await tx.entity.findFirst({
    where: {
      id: publicationId,
      kind: PUBLICATIONS,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  // Only assignment posts have a veto window.
  if (!row || !data(row).vetoDeadline) return { result: "not_found" };
  const p = data(row);
  if (p.vetoedAt) return { result: "vetoed" };
  // Withdrawn before (assignment paused or ended): it will not go out either.
  if (p.status === "canceled" && !p.remoteId && !p.handoffCompletedAt)
    return { result: "vetoed" };
  // Only a post Orbit still holds can be stopped (R56); every other status
  // (sending, scheduled_remote, reconciliation_required, ...) is with Postiz.
  if (!withdrawable(p)) return { result: "already_handed_over" };
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  await withdrawPublication(tx, scope, row, "VETOED", {
    vetoedAt: new Date().toISOString(),
    vetoedBy: scope.userId,
    vetoSource: source,
  });
  await audit(tx, scope, "publication.vetoed", row.id, {
    source,
    contentId: p.contentId,
    assignmentId: p.assignmentId ?? null,
    vetoDeadline: p.vetoDeadline,
    reasonGiven: Boolean(reason?.trim()),
  });
  const rule = reason?.trim().slice(0, 2000);
  if (rule)
    await create(tx, scope, "preferences", {
      ...preference.parse({
        name: `Stopped post on ${p.channel}`.slice(0, 200),
        rule,
        validUntil: new Date(
          Date.now() + PREFERENCE_DAYS * 86400000,
        ).toISOString(),
        status: "proposed",
      }),
      source: "veto",
      vetoSource: source,
      publicationId: row.id,
      contentId: p.contentId,
      assignmentId: p.assignmentId ?? null,
    });
  return { result: "vetoed" };
}

/**
 * Withdraws an assignment's scheduled posts that are not handed over yet,
 * when it is paused, ends or runs out of budget (R20/R23), when its
 * confirmed content changes, or when the owner moves its times (their agent
 * review no longer matches the confirmation, R70): such posts publish
 * nothing more. Handed-over posts stay as they are. `extra` is recorded on
 * each withdrawn publication.
 */
export async function withdrawAssignmentPublications(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  reason: Extract<
    WithdrawReason,
    | "ASSIGNMENT_PAUSED"
    | "ASSIGNMENT_ENDED"
    | "ASSIGNMENT_CHANGED"
    | "ASSIGNMENT_RETIMED"
  >,
  extra: Record<string, unknown> = {},
) {
  let withdrawn = 0;
  for (const row of await rowsWhere(
    tx,
    scope,
    PUBLICATIONS,
    "assignmentId",
    assignmentId,
  ))
    if (data(row).vetoDeadline && withdrawable(data(row))) {
      await withdrawPublication(tx, scope, row, reason, extra);
      withdrawn++;
    }
  return { withdrawn };
}

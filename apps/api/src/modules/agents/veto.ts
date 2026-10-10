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
import { postizDraftsEnabled } from "../postiz-draft.ts";
import { agentReviewAccepted } from "./agent-review.ts";
import { SLOT_STEP_MS, SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import {
  agentsEnabled,
  confirmedDelivery,
  deliveryOf,
  type Delivery,
} from "./assignments.ts";
import {
  bookPostizDraft,
  cancelAssignmentPostizDrafts,
} from "./draft-delivery.ts";
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
 * An assignment with the delivery "Postiz draft" (R73) publishes nothing:
 * its approved drafts are booked as Postiz drafts at their slot instead
 * (draft-delivery.ts), with no veto window and no preview.
 */
const RUNS = "assignment_runs";
const PUBLICATIONS = "publications";
const POSTIZ_DRAFTS = "postiz_drafts";
// The publication is out of Orbit's hands from the claim on.
const INACTIVE = ["canceled", "failed", "blocked_dependency"];
// A Postiz draft handoff that no longer delivers (R73).
const INACTIVE_HANDOFF = ["canceled", "failed"];

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
/**
 * An assignment post: one with a veto window (scheduled by its run), or one
 * the owner released without a window (owner-release.ts).
 */
export const assignmentPost = (pub: Record<string, any>) =>
  Boolean(pub.vetoDeadline || pub.ownerReleasedAt);
// Drafts that still wait for a decision keep their slot.
const PENDING_DRAFT = ["draft", "needs_review", "reviewed"];
// Same tolerance after the slot as the mission the copywriter creates.
const SLOT_WINDOW_MS = 2 * 3600000;
// A stop's reason stays a proposed preference this long.
const PREFERENCE_DAYS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunSlot = {
  channel: string;
  at: string;
  // The slot the run was given, when the post moved for its veto window.
  requestedAt?: string;
  publicationId?: string;
  // The Postiz draft handoff that holds the slot (delivery "Postiz draft", R73).
  postizDraftId?: string;
  releasedAt?: string;
  releaseReason?: string;
};
export type Dropped = {
  contentId: string;
  briefKey: string | null;
  channel: string;
  requestedAt: string;
  code: string;
  at: string;
};

export const slotKey = (channel: string, at: string) =>
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
 * The owner's release (owner-release.ts) uses it with no veto window.
 */
export async function vetoSlot(
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
export async function moveDraft(
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
 * The delivery of one assignment draft: the one stamped on it when it was
 * written (I1), else the assignment's confirmed one. An unconfirmed change
 * of the assignment never changes it.
 */
export function draftDelivery(
  content: Record<string, any>,
  assignmentDelivery: Delivery,
): Delivery {
  return content.delivery === "postiz_draft" || content.delivery === "publish"
    ? content.delivery
    : assignmentDelivery;
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
 *
 * With the delivery "Postiz draft" (R73) each approved draft is booked as a
 * Postiz draft handoff at its slot instead (`bookPostizDraft`): no
 * publication, no veto window (nothing goes public) and no preview; the
 * slot records `postizDraftId` and keeps holding. It then returns the run's
 * handoffs that are still active.
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
  // The confirmed delivery; each draft carries the one it was written under (I1).
  const assignmentDelivery =
    confirmedDelivery(assignment) ?? deliveryOf(assignment);
  const existing = await rowsWhere(
    tx,
    scope,
    PUBLICATIONS,
    "assignmentRunId",
    runId,
  );
  const handoffs = await rowsWhere(
    tx,
    scope,
    POSTIZ_DRAFTS,
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
    const booked = handoffs.find((row) => data(row).contentId === draft.id);
    if (booked) {
      if (!INACTIVE_HANDOFF.includes(data(booked).status))
        scheduled.push(booked);
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
    const drafting = draftDelivery(c, assignmentDelivery) === "postiz_draft";
    // Nothing goes public with draft delivery, so it needs no veto window.
    const vetoMs = drafting ? 0 : Number(assignment.vetoMinutes ?? 180) * 60000;
    const mission = await entity(tx, scope, "missions", c.missionId);
    const planned = new Date(data(mission).plannedSlotAt);
    const index = slots.findIndex(
      (slot) =>
        slot.channel === c.channel &&
        Date.parse(slot.at) === planned.valueOf() &&
        !slot.publicationId &&
        !slot.postizDraftId,
    );
    let failure: string | null = null;
    let publication: Awaited<ReturnType<typeof entity>> | null = null;
    let handoff: Awaited<ReturnType<typeof entity>> | null = null;
    let target: Date | null = null;
    // Read per draft: a long pass must not leave a late draft with a deadline already gone.
    const now = new Date();
    try {
      // Switched off: the deliverable is dropped with a notice (R73).
      if (drafting && !postizDraftsEnabled())
        failure = "POSTIZ_DRAFTS_DISABLED";
      else
        target = await vetoSlot(
          tx,
          scope,
          runId,
          c.channel,
          planned,
          vetoMs,
          now,
          // Slots of this run that got a publication or were released in this
          // pass no longer hold; booked Postiz drafts still do (slotContext).
          new Set(
            slots
              .filter((slot) => !slot.publicationId && !slot.releasedAt)
              .map((slot) => slotKey(slot.channel, slot.at)),
          ),
        );
      if (failure) target = null;
      else if (!target) failure = SLOT_UNAVAILABLE;
      else {
        const content = await moveDraft(tx, scope, draft, mission, target);
        if (drafting)
          handoff = await bookPostizDraft(tx, scope, {
            content,
            slotAt: target,
            runId,
            assignmentId: r.assignmentId,
            approvedBy: "agent",
            reviewTaskId: c.agentReview?.taskId ?? null,
          });
        else
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
    if ((!publication && !handoff) || !target) {
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
    if (handoff) {
      if (index >= 0)
        slots[index] = {
          ...slots[index]!,
          at: target.toISOString(),
          ...(target.valueOf() !== planned.valueOf()
            ? { requestedAt: slots[index]!.at }
            : {}),
          postizDraftId: handoff.id,
        };
      // Every automatic approval is audited (spec §11), here without a veto deadline.
      await audit(tx, scope, "assignment.postiz_draft_booked", handoff.id, {
        contentId: draft.id,
        runId,
        assignmentId: r.assignmentId,
        assignmentVersion: assignmentRow.version,
        assignmentHash: c.agentReview?.assignmentHash ?? null,
        reviewTaskId: c.agentReview?.taskId ?? null,
        deterministicProblems: c.agentReview?.deterministicProblems ?? null,
        slotAt: target.toISOString(),
        requestedAt: planned.toISOString(),
        approvedBy: "agent",
      });
      scheduled.push(handoff);
      continue;
    }
    if (!publication) continue;
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
          !handoffs.some((row) => data(row).contentId === draft.id) &&
          !dropped.some((entry) => entry.contentId === draft.id),
      )
      .map((draft) => String(data(draft).briefKey)),
  );
  for (const [index, slot] of slots.entries())
    if (
      !slot.publicationId &&
      !slot.postizDraftId &&
      !slot.releasedAt &&
      !waiting.has(slotKey(slot.channel, slot.at))
    )
      slots[index] = {
        ...slot,
        releasedAt: now.toISOString(),
        releaseReason: "NO_APPROVED_DRAFT",
      };
  const draftIds = [
    ...new Set([
      ...((r.scheduling?.postizDraftIds ?? []) as string[]),
      ...scheduled
        .filter((row) => row.kind === POSTIZ_DRAFTS)
        .map((row) => row.id),
    ]),
  ];
  const scheduling = {
    at: r.scheduling?.at ?? now.toISOString(),
    publicationIds: scheduled
      .filter((row) => row.kind !== POSTIZ_DRAFTS)
      .map((pub) => pub.id),
    ...(draftIds.length ? { postizDraftIds: draftIds } : {}),
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
export function awaitsScheduling(run: Record<string, any>) {
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
  // Only assignment posts can be stopped here: those with a veto window and those the owner released.
  if (!row || !assignmentPost(data(row))) return { result: "not_found" };
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
  await revokeReleasedRight(tx, scope, row);
  await audit(tx, scope, "publication.vetoed", row.id, {
    source,
    contentId: p.contentId,
    assignmentId: p.assignmentId ?? null,
    vetoDeadline: p.vetoDeadline ?? null,
    ownerReleased: Boolean(p.ownerReleasedAt),
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
 * Takes back the publish right the owner's release gave the post's
 * draft-only mission, as the package cancel path does (package-schedule.ts):
 * once the released post is withdrawn, an editor's later publish of the same
 * text needs a new decision. Only a post the owner released is touched, never
 * one with a veto window or a package post, and only a right that was given
 * for this very content.
 */
async function revokeReleasedRight(
  tx: DbTx,
  scope: Scope,
  publication: Awaited<ReturnType<typeof entity>>,
) {
  const p = data(publication);
  if (!p.ownerReleasedAt || p.vetoDeadline || !p.assignmentRunId) return;
  const content = data(await entity(tx, scope, "content", p.contentId));
  if (typeof content.missionId !== "string") return;
  const mission = await entity(tx, scope, "missions", content.missionId);
  const m = data(mission);
  // Assignment missions only; the right must point to this post's content.
  if (
    m.assignmentRunId !== p.assignmentRunId ||
    m.publishAuthorizedBy?.contentId !== p.contentId
  )
    return;
  const { publishAuthorizedBy: _released, ...rest } = m;
  await update(tx, scope, mission, {
    ...rest,
    allowedActions: ((m.allowedActions ?? []) as string[]).filter(
      (action) => !action.startsWith("publish_"),
    ),
  });
  await audit(tx, scope, "mission.publish_revoked", mission.id, {
    publicationId: publication.id,
    contentId: p.contentId,
    ownerRelease: true,
  });
}

/**
 * Withdraws an assignment's scheduled posts that are not handed over yet,
 * when it is paused, ends or runs out of budget (R20/R23), when its
 * confirmed content changes, or when the owner moves its times (their agent
 * review no longer matches the confirmation, R70): such posts publish
 * nothing more. Posts the owner released (owner-release.ts) do not rest on
 * an agent review, so only a pause or end withdraws them: a stopped
 * assignment publishes nothing more. Handed-over posts stay as they are.
 * `extra` is recorded on each withdrawn publication.
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
    if (
      (data(row).vetoDeadline ||
        (data(row).ownerReleasedAt &&
          (reason === "ASSIGNMENT_PAUSED" || reason === "ASSIGNMENT_ENDED"))) &&
      withdrawable(data(row))
    ) {
      await withdrawPublication(tx, scope, row, reason, extra);
      await revokeReleasedRight(tx, scope, row);
      withdrawn++;
    }
  // Booked Postiz drafts not sent yet go the same way (R73); sent ones stay in Postiz.
  const { canceled } = await cancelAssignmentPostizDrafts(
    tx,
    scope,
    assignmentId,
    reason,
    extra,
  );
  return { withdrawn, canceledDrafts: canceled };
}

/**
 * A confirmed delivery change (R73, I1) is treated like a pause for what
 * the owner released under the other delivery: with "postiz_draft" the
 * assignment's posts Orbit still holds are withdrawn, with "publish" its
 * booked drafts not sent yet are canceled (`ASSIGNMENT_DELIVERY_CHANGED`,
 * `deliveryChangedVersion`), with one notice. Posts the agent approved were
 * already withdrawn by the content change that preceded the confirmation.
 */
export async function applyConfirmedDelivery(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  delivery: Delivery,
  version: number,
) {
  const extra = { deliveryChangedVersion: version };
  let withdrawn = 0;
  if (delivery === "postiz_draft") {
    for (const row of await rowsWhere(
      tx,
      scope,
      PUBLICATIONS,
      "assignmentId",
      assignmentId,
    ))
      if (assignmentPost(data(row)) && withdrawable(data(row))) {
        await withdrawPublication(
          tx,
          scope,
          row,
          "ASSIGNMENT_DELIVERY_CHANGED",
          extra,
        );
        await revokeReleasedRight(tx, scope, row);
        withdrawn++;
      }
  } else
    withdrawn = (
      await cancelAssignmentPostizDrafts(
        tx,
        scope,
        assignmentId,
        "ASSIGNMENT_DELIVERY_CHANGED",
        extra,
      )
    ).canceled;
  if (withdrawn)
    await notify(tx, scope, "delivery_changed", `${assignmentId}:${version}`);
  return { withdrawn };
}

// Publication statuses after which Postiz has the post, or had it.
const PUBLISHED = ["published", "published_test"];
const DELIVERABLES = 20;
type Outcome =
  | "scheduled"
  | "handed_over"
  | "published"
  | "stopped"
  | "withdrawn"
  | "blocked"
  | "failed"
  | "dropped"
  | "awaiting_owner"
  // Delivery "Postiz draft" (R73): booked or being sent, in Postiz, or unclear.
  | "postiz_draft_pending"
  | "postiz_draft"
  | "postiz_draft_unknown"
  | "postiz_draft_failed";

function publicationOutcome(p: Record<string, any>): {
  outcome: Outcome;
  reason: string | null;
} {
  if (p.vetoedAt) return { outcome: "stopped", reason: "VETOED" };
  if (p.status === "intent_created")
    return { outcome: "scheduled", reason: null };
  if (PUBLISHED.includes(p.status))
    return { outcome: "published", reason: null };
  if (p.status === "canceled")
    return { outcome: "withdrawn", reason: p.reason ?? null };
  if (p.status === "failed")
    return { outcome: "failed", reason: p.error ?? p.reason ?? null };
  if (p.status === "blocked_dependency")
    return {
      outcome: "blocked",
      reason: ((p.blockers ?? []) as string[]).join(",") || (p.reason ?? null),
    };
  // sending, scheduled_remote, outcome_unknown, reconciliation_required, …
  return { outcome: "handed_over", reason: null };
}

/**
 * What one run delivered, for `run_status` (R70, I5): its posts from its
 * publications (scheduled with a veto window or released by the owner; with
 * status, slot, deadline and whether Postiz has them), the deliverables
 * scheduling dropped (`scheduling.dropped`, with the code), the drafts that
 * wait for the owner's release, and the stops (`vetoedAt`, source).
 */
export async function runDeliverables(
  tx: DbTx,
  scope: Scope,
  run: { id: string; data: unknown },
) {
  const r = data(run);
  const linked = await rowsWhere(
    tx,
    scope,
    PUBLICATIONS,
    "assignmentRunId",
    run.id,
  );
  const known = new Set(linked.map((row) => row.id));
  const missing = ((r.scheduling?.publicationIds ?? []) as unknown[]).filter(
    (id): id is string =>
      typeof id === "string" && UUID.test(id) && !known.has(id),
  );
  const publications = [
    ...linked,
    ...(missing.length
      ? await tx.entity.findMany({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: PUBLICATIONS,
            id: { in: missing },
          },
        })
      : []),
  ];
  const deliverables: Array<Record<string, unknown>> = [];
  const vetoes: Array<Record<string, unknown>> = [];
  const covered = new Set<string>();
  for (const row of publications) {
    const p = data(row);
    covered.add(String(p.contentId));
    const handedOver = Boolean(
      p.handoffAt || p.remoteId || p.handoffCompletedAt,
    );
    const { outcome, reason } = publicationOutcome(p);
    deliverables.push({
      contentId: p.contentId,
      channel: p.channel,
      outcome,
      reason,
      publicationId: row.id,
      publicationStatus: p.status,
      scheduledAt: p.scheduledAt ?? null,
      requestedAt: p.requestedSlotAt ?? null,
      vetoDeadline: p.vetoDeadline ?? null,
      releasedBy: p.ownerReleasedAt ? "owner" : "agent",
      handedOver: handedOver || outcome === "handed_over",
    });
    if (p.vetoedAt)
      vetoes.push({
        publicationId: row.id,
        contentId: p.contentId,
        channel: p.channel,
        scheduledAt: p.scheduledAt ?? null,
        vetoedAt: p.vetoedAt,
        source: p.vetoSource ?? null,
      });
  }
  // Drafts delivered to Postiz (R73); a failed one is listed as dropped below.
  for (const row of await rowsWhere(
    tx,
    scope,
    POSTIZ_DRAFTS,
    "assignmentRunId",
    run.id,
  )) {
    const h = data(row);
    const outcome: Outcome | null =
      h.status === "accepted"
        ? "postiz_draft"
        : h.status === "outcome_unknown"
          ? "postiz_draft_unknown"
          : ["queued", "sending"].includes(h.status)
            ? "postiz_draft_pending"
            : h.status === "canceled"
              ? "withdrawn"
              : h.status === "failed"
                ? "postiz_draft_failed"
                : null;
    if (!outcome || covered.has(String(h.contentId))) continue;
    covered.add(String(h.contentId));
    deliverables.push({
      contentId: h.contentId,
      channel: h.integrationId,
      outcome,
      reason: h.alreadyInPostiz
        ? "POSTIZ_DRAFT_EXISTS"
        : h.resolution === "not_created"
          ? "POSTIZ_DRAFT_NOT_CREATED"
          : (h.reason ?? h.error ?? null),
      publicationId: null,
      postizDraftId: row.id,
      publicationStatus: null,
      scheduledAt: h.slotAt ?? null,
      requestedAt: null,
      vetoDeadline: null,
      releasedBy: h.approvedBy === "owner" ? "owner" : "agent",
      // A draft in Postiz is Postiz's; Orbit never publishes it.
      handedOver: ["accepted", "sending", "outcome_unknown"].includes(h.status),
    });
  }
  for (const entry of (r.scheduling?.dropped ?? []) as Dropped[]) {
    if (covered.has(entry.contentId)) continue;
    covered.add(entry.contentId);
    deliverables.push({
      contentId: entry.contentId,
      channel: entry.channel,
      outcome: "dropped",
      reason: entry.code,
      publicationId: null,
      publicationStatus: null,
      scheduledAt: null,
      requestedAt: entry.requestedAt,
      vetoDeadline: null,
      releasedBy: null,
      handedOver: false,
    });
  }
  for (const draft of await rowsWhere(
    tx,
    scope,
    "content",
    "assignmentRunId",
    run.id,
  )) {
    const c = data(draft);
    if (
      covered.has(draft.id) ||
      c.status !== "needs_review" ||
      c.supersededBy ||
      c.type !== "social"
    )
      continue;
    deliverables.push({
      contentId: draft.id,
      channel: c.channel,
      outcome: "awaiting_owner",
      reason:
        ((c.agentReviewDecision?.deterministicProblems ?? []) as string[]).join(
          ",",
        ) || null,
      publicationId: null,
      publicationStatus: null,
      scheduledAt: null,
      requestedAt: c.scheduledAt ?? null,
      vetoDeadline: null,
      releasedBy: null,
      handedOver: false,
    });
  }
  return {
    deliverables: deliverables.slice(0, DELIVERABLES),
    vetoes: vetoes.slice(0, DELIVERABLES),
  };
}

import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  exception,
  update,
} from "../../shared.ts";
import { preflight } from "../policy.ts";
import {
  draftSend,
  draftTarget,
  postizDraftsEnabled,
  recordDraftHandoff,
  sendDraftHandoff,
  type DraftDeps,
} from "../postiz-draft.ts";
import { errorCode } from "../telemetry.ts";
import { enqueue } from "../workflow.ts";
import { confirmedHash } from "./agent-review.ts";
import { SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import {
  agentsEnabled,
  ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS,
  deliveryOf,
} from "./assignments.ts";
import { notify } from "./notifications.ts";

/**
 * Delivery "Postiz draft" of assignment posts (ruling R73). An assignment
 * whose confirmed `delivery` is `postiz_draft` never publishes: each social
 * draft that is approved, by an accepted agent review (scheduleApproved,
 * veto.ts) or by the owner's release (owner-release.ts), is booked here as a
 * `postiz_drafts` handoff and sent to Postiz as a draft dated at its slot by
 * the worker (`postiz_draft` queue). The owner publishes it in Postiz.
 *
 * - Slot: a booked draft holds its run slot (`postizDraftId` on the run's
 *   slot, never released while the handoff is queued, sending, accepted or
 *   unclear), so the slot rules (quota, spacing, quiet hours, calendar and
 *   the other assignments) count it like a planned post. A handoff that
 *   failed clearly or was withdrawn before sending gives its slot back.
 * - Booking runs in the scheduling transaction (R54: its own transaction
 *   after the review, retried by the sweep with a per-run savepoint). It
 *   checks the same deterministic blockers as a publication at the slot,
 *   except the publication step's own codes, and the shared handoff checks
 *   of postiz-draft.ts.
 * - Sending runs in the worker job, outside a transaction, with the shared
 *   HTTP step. Postiz has no idempotency: the handoff is `sending` before
 *   the call; a job that finds it `sending` again (crash, retry) marks it
 *   `outcome_unknown` and never sends again; the owner resolves it with the
 *   existing resolve action after checking Postiz.
 * - A failed image is left out (nothing was posted yet) and recorded.
 * - Gated by ENABLE_POSTIZ_DRAFTS: switched off, a booking or send drops the
 *   deliverable with POSTIZ_DRAFTS_DISABLED and notifies the owner.
 */
export const POSTIZ_DRAFT_TOPIC = "postiz_draft";
const KIND = "postiz_drafts";
const RUNS = "assignment_runs";
// Preflight codes of the publication step: a draft delivery publishes nothing.
// Read when used: the constant comes through an import cycle (assignments.ts).
const publicationStep = () =>
  new Set([
    "MISSION_TEST_WRITE_NOT_AUTHORIZED",
    ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS,
  ]);
const PENDING_JOB = ["queued", "running", "retry_scheduled"];
// Handoffs older than this are no longer sent again by the sweep.
const REQUEUE_DAYS = 3;

type Row = Awaited<ReturnType<typeof entity>>;

/** The project lock every booking takes (same as scoped() and scheduleApproved). */
const lockProject = (tx: DbTx, scope: Scope) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId},0))`;

/** Deterministic blockers of a draft at its slot, without the publication step's own. */
async function draftBlockers(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  at: Date,
) {
  const checked = await preflight(tx, scope, contentId, {
    test: true,
    at,
    ignoreApproval: true,
  });
  const step = publicationStep();
  return checked.blockers.filter((code) => !step.has(code));
}

/**
 * Books one approved draft for delivery as a Postiz draft at `slotAt`: the
 * handoff record (`queued`) and its worker job. Throws a DomainError for a
 * blocker, which drops the deliverable (scheduleApproved) or refuses the
 * release (owner-release.ts); the caller records the slot.
 */
export async function bookPostizDraft(
  tx: DbTx,
  scope: Scope,
  input: {
    content: Row;
    slotAt: Date;
    runId: string;
    assignmentId: string;
    approvedBy: "agent" | "owner";
    reviewTaskId: string | null;
  },
) {
  if (!postizDraftsEnabled())
    throw new DomainError("POSTIZ_DRAFTS_DISABLED", 409);
  const blockers = await draftBlockers(
    tx,
    scope,
    input.content.id,
    input.slotAt,
  );
  if (blockers.length) throw new DomainError(blockers.join(","), 409);
  const target = await draftTarget(
    tx,
    scope,
    input.content.id,
    input.content.version,
  );
  // This exact version is in Postiz already (the owner handed it over himself).
  if ("done" in target) throw new DomainError("POSTIZ_DRAFT_EXISTS", 409);
  const handoff = await recordDraftHandoff(tx, scope, target, {
    status: "queued",
    source: "assignment",
    assignmentId: input.assignmentId,
    assignmentRunId: input.runId,
    slotAt: input.slotAt.toISOString(),
    approvedBy: input.approvedBy,
    reviewTaskId: input.reviewTaskId,
    requestedBy:
      input.approvedBy === "owner"
        ? scope.userId
        : `agent:${input.reviewTaskId}`,
  });
  await enqueue(
    tx,
    scope,
    POSTIZ_DRAFT_TOPIC,
    handoff.id,
    `postiz_draft:${handoff.id}`,
  );
  return handoff;
}

/**
 * Gives the run slot of a handoff back (`releasedAt`), and with `dropped`
 * records the deliverable as dropped with that code, audits it and notifies
 * the owner (the existing `dropped` notice).
 */
async function releaseDraftSlot(
  tx: DbTx,
  scope: Scope,
  handoff: Row,
  code: string,
  dropped: boolean,
) {
  const h = data(handoff);
  if (typeof h.assignmentRunId !== "string") return;
  await lockProject(tx, scope);
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${h.assignmentRunId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const run = await tx.entity.findFirst({
    where: {
      id: h.assignmentRunId,
      kind: RUNS,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  if (!run) return;
  const r = data(run);
  const now = new Date().toISOString();
  const slots = ((r.slots ?? []) as Array<Record<string, any>>).map((slot) =>
    slot.postizDraftId === handoff.id && !slot.releasedAt
      ? { ...slot, releasedAt: now, releaseReason: code }
      : slot,
  );
  const content = dropped
    ? await tx.entity.findFirst({
        where: {
          id: h.contentId,
          kind: "content",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      })
    : null;
  const already = (
    (r.scheduling?.dropped ?? []) as Array<{ contentId: string }>
  )
    .map((entry) => entry.contentId)
    .includes(h.contentId);
  const drop = dropped && !already;
  await update(tx, scope, run, {
    ...r,
    slots,
    ...(drop
      ? {
          scheduling: {
            ...(r.scheduling ?? { at: now, publicationIds: [] }),
            dropped: [
              ...((r.scheduling?.dropped ?? []) as unknown[]),
              {
                contentId: h.contentId,
                briefKey: data(content).briefKey ?? null,
                channel: h.integrationId,
                requestedAt: h.slotAt,
                code,
                at: now,
              },
            ],
          },
        }
      : {}),
  });
  if (!drop) return;
  await audit(tx, scope, "assignment.deliverable_dropped", h.contentId, {
    runId: h.assignmentRunId,
    assignmentId: h.assignmentId,
    channel: h.integrationId,
    requestedAt: h.slotAt,
    code,
    postizDraftId: handoff.id,
  });
  await notify(tx, scope, "dropped", h.contentId);
}

/** Ends a booked handoff before anything was sent: failed (dropped, notified) or canceled (slot back, no notice). */
async function endBooked(
  tx: DbTx,
  scope: Scope,
  row: Row,
  status: "failed" | "canceled",
  code: string,
) {
  const saved = await update(tx, scope, row, {
    ...data(row),
    status,
    ...(status === "failed"
      ? { error: code, failedStep: "prepare" }
      : { reason: code, canceledAt: new Date().toISOString() }),
    finishedAt: new Date().toISOString(),
  });
  await audit(tx, scope, `postiz_draft.${status}`, row.id, { code });
  await releaseDraftSlot(tx, scope, saved, code, status === "failed");
  return saved;
}

/** A handoff whose send may have reached Postiz: unclear, with an exception and a notice; never sent again. */
async function markUnknown(tx: DbTx, scope: Scope, row: Row) {
  await update(tx, scope, row, {
    ...data(row),
    status: "outcome_unknown",
    error: "POSTIZ_DRAFT_OUTCOME_UNKNOWN",
    failedStep: "create_post",
    finishedAt: new Date().toISOString(),
  });
  await exception(tx, scope, "POSTIZ_DRAFT_OUTCOME_UNKNOWN", row.id);
  await notify(tx, scope, "postiz_error", row.id);
}

/**
 * Worker crash recovery: a `postiz_draft` job whose lease ran out while its
 * handoff was `sending` may have created the draft; it becomes unclear.
 */
export async function markPostizDraftOutcomeUnknown(
  tx: DbTx,
  scope: Scope,
  handoffId: string,
) {
  const row = await tx.entity.findFirst({
    where: {
      id: handoffId,
      kind: KIND,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  if (row && data(row).status === "sending") await markUnknown(tx, scope, row);
}

/** What the owner hears once the send's outcome is recorded. */
async function afterSend(tx: DbTx, scope: Scope, row: Row) {
  const status = data(row).status;
  if (status === "accepted") await notify(tx, scope, "postiz_draft", row.id);
  else if (status === "outcome_unknown")
    await notify(tx, scope, "postiz_error", row.id);
  else if (status === "failed")
    await releaseDraftSlot(
      tx,
      scope,
      row,
      String(data(row).error ?? "POSTIZ_DRAFT_FAILED"),
      true,
    );
}

/**
 * The `postiz_draft` job: sends one booked handoff to Postiz as a draft
 * dated at its slot. Idempotent: only a `queued` handoff is sent, once. It
 * checks again first: switched off or past its slot, the deliverable is
 * dropped with a notice; Orbit Agents off, an assignment no longer
 * confirmed for draft delivery or a canceled run withdraws it (slot back); a
 * project pause leaves it queued for the sweep after the resume.
 */
export async function deliverPostizDraft(
  scope: Scope,
  handoffId: string,
  deps?: DraftDeps,
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${handoffId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
      const row = await tx.entity.findFirst({
        where: {
          id: handoffId,
          kind: KIND,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      if (!row || data(row).source !== "assignment") return null;
      const h = data(row);
      // A send that was started before and never recorded may have reached Postiz.
      if (h.status === "sending") {
        await markUnknown(tx, scope, row);
        return null;
      }
      if (h.status !== "queued") return null;
      // Orbit Agents switched off (rollback): nothing more goes out; the slot is given back.
      if (!agentsEnabled()) {
        await endBooked(tx, scope, row, "canceled", "AGENTS_DISABLED");
        return null;
      }
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) return null;
      if (!postizDraftsEnabled()) {
        await endBooked(tx, scope, row, "failed", "POSTIZ_DRAFTS_DISABLED");
        return null;
      }
      const assignment = await tx.entity.findFirst({
        where: {
          id: h.assignmentId,
          kind: "assignments",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      const run = await tx.entity.findFirst({
        where: {
          id: h.assignmentRunId,
          kind: RUNS,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      if (
        !assignment ||
        !confirmedHash(data(assignment)) ||
        deliveryOf(data(assignment)) !== "postiz_draft"
      ) {
        await endBooked(tx, scope, row, "canceled", "ASSIGNMENT_NOT_CONFIRMED");
        return null;
      }
      if (!run || data(run).status === "canceled") {
        await endBooked(tx, scope, row, "canceled", "RUN_CANCELED");
        return null;
      }
      const slotAt = new Date(String(h.slotAt));
      if (!(slotAt.valueOf() > Date.now())) {
        await endBooked(tx, scope, row, "failed", SLOT_UNAVAILABLE);
        return null;
      }
      let target: Awaited<ReturnType<typeof draftTarget>>;
      try {
        const blockers = await draftBlockers(tx, scope, h.contentId, slotAt);
        if (blockers.length) throw new DomainError(blockers.join(","), 409);
        target = await draftTarget(
          tx,
          scope,
          h.contentId,
          h.contentVersion,
          row.id,
        );
        if ("done" in target) throw new DomainError("POSTIZ_DRAFT_EXISTS", 409);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await endBooked(tx, scope, row, "failed", error.message.slice(0, 200));
        return null;
      }
      const sending = await update(tx, scope, row, {
        ...h,
        status: "sending",
        sendingAt: new Date().toISOString(),
      });
      return {
        id: sending.id,
        send: await draftSend(tx, scope, target, slotAt.toISOString()),
      };
    },
  );
  if (!prepared) return null;
  return sendDraftHandoff(scope, prepared.id, prepared.send, deps, {
    imageFallback: true,
    after: (tx, row) => afterSend(tx, scope, row),
  });
}

/**
 * Withdraws an assignment's booked drafts that were not sent yet, as
 * withdrawAssignmentPublications does for its posts: on pause, end, budget
 * exhaustion, content or time change. Drafts the owner released are
 * withdrawn only on pause or end (R71). A draft already in Postiz stays:
 * withdrawing it is done in Postiz.
 */
export async function cancelAssignmentPostizDrafts(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  reason: string,
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      AND: [
        { data: { path: ["assignmentId"], equals: assignmentId } },
        { data: { path: ["status"], equals: "queued" } },
      ],
    },
  });
  let canceled = 0;
  for (const row of rows) {
    if (
      data(row).approvedBy === "owner" &&
      !["ASSIGNMENT_PAUSED", "ASSIGNMENT_ENDED"].includes(reason)
    )
      continue;
    await endBooked(tx, scope, row, "canceled", reason);
    canceled++;
  }
  return { canceled };
}

/**
 * Sweep retry of the send (with R54's sweep): a booked draft whose job ended
 * without sending it, because the worker held it back during a project pause
 * or the job failed on the database, is queued again, at most once per
 * project generation. Each handoff in its own savepoint.
 */
export async function requeuePostizDrafts(tx: DbTx, scope: Scope) {
  if (!agentsEnabled()) return { requeued: 0 };
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return { requeued: 0 };
  const since = new Date(Date.now() - REQUEUE_DAYS * 86400000);
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      createdAt: { gte: since },
      data: { path: ["status"], equals: "queued" },
    },
    orderBy: { createdAt: "asc" },
  });
  let requeued = 0;
  for (const row of rows) {
    if (data(row).source !== "assignment") continue;
    await tx.$executeRaw`SAVEPOINT requeue_postiz_draft`;
    try {
      const jobs = await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "jobs",
          AND: [
            { data: { path: ["topic"], equals: POSTIZ_DRAFT_TOPIC } },
            { data: { path: ["resourceId"], equals: row.id } },
          ],
        },
      });
      if (!jobs.some((job) => PENDING_JOB.includes(data(job).status))) {
        const job = await enqueue(
          tx,
          scope,
          POSTIZ_DRAFT_TOPIC,
          row.id,
          `postiz_draft:${row.id}:retry:${project.generation}`,
        );
        if (data(job).status === "queued" && !data(job).attempts) requeued++;
      }
      await tx.$executeRaw`RELEASE SAVEPOINT requeue_postiz_draft`;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT requeue_postiz_draft`;
      console.error("Orbit Postiz draft requeue failed", errorCode(error));
    }
  }
  return { requeued };
}

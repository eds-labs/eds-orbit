import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
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
  type DraftSend,
} from "../postiz-draft.ts";
import { errorCode } from "../telemetry.ts";
import { enqueue } from "../workflow.ts";
import { agentReviewAccepted, confirmedHash } from "./agent-review.ts";
import { SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import {
  agentsEnabled,
  ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS,
  confirmedDelivery,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const fields = {
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
  };
  // This exact version is in Postiz already (the owner handed it over
  // himself, M8): delivered, nothing is sent, the slot stays held.
  if ("done" in target) return recordExisting(tx, scope, target.done, fields);
  const handoff = await recordDraftHandoff(tx, scope, target, {
    status: "queued",
    ...fields,
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
 * An assignment delivery whose content version the owner already handed to
 * Postiz himself (M8): recorded as delivered (`accepted`, `alreadyInPostiz`,
 * the existing remote draft), without a send or a notice; it keeps its slot.
 */
async function recordExisting(
  tx: DbTx,
  scope: Scope,
  done: Row,
  fields: Record<string, unknown>,
) {
  const e = data(done);
  const row = await create(tx, scope, KIND, {
    contentId: e.contentId,
    contentVersion: e.contentVersion,
    body: e.body,
    targetUrl: e.targetUrl ?? null,
    assetId: e.assetId ?? null,
    integrationId: e.integrationId,
    integrationName: e.integrationName ?? null,
    integrationIdentifier: e.integrationIdentifier ?? null,
    ...fields,
    status: "accepted",
    ...existingFields(done),
  });
  await audit(tx, scope, "postiz_draft.existing", row.id, {
    existingHandoffId: done.id,
  });
  return row;
}
const existingFields = (done: Row) => ({
  alreadyInPostiz: true,
  existingHandoffId: done.id,
  remoteId: data(done).remoteId ?? null,
  remoteType: "draft",
  remoteDate: data(done).remoteDate ?? null,
  finishedAt: new Date().toISOString(),
});

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
  options: { notice?: boolean } = {},
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
  if (options.notice !== false) await notify(tx, scope, "dropped", h.contentId);
}

/**
 * Ends a booked handoff before anything was sent: failed (dropped, notified)
 * or canceled (slot back; with `notice` also recorded as dropped and
 * notified). `extra` is recorded on the handoff (e.g. the version of the
 * change that canceled it, counted by its notice).
 */
async function endBooked(
  tx: DbTx,
  scope: Scope,
  row: Row,
  status: "failed" | "canceled",
  code: string,
  options: { notice?: boolean; extra?: Record<string, unknown> } = {},
) {
  const saved = await update(tx, scope, row, {
    ...data(row),
    ...options.extra,
    status,
    ...(status === "failed"
      ? { error: code, failedStep: "prepare" }
      : { reason: code, canceledAt: new Date().toISOString() }),
    finishedAt: new Date().toISOString(),
  });
  await audit(tx, scope, `postiz_draft.${status}`, row.id, { code });
  await releaseDraftSlot(
    tx,
    scope,
    saved,
    code,
    status === "failed" || options.notice === true,
  );
  return saved;
}

/**
 * The owner resolved an unclear assignment handoff after checking Postiz
 * (resolvePostizDraft, M5): "not_created" gives the slot back and records
 * the deliverable as dropped (no notice; the owner decided it himself).
 */
export async function afterDraftResolved(
  tx: DbTx,
  scope: Scope,
  row: Row,
  resolution: "not_created" | "exists",
) {
  if (data(row).source !== "assignment" || resolution !== "not_created") return;
  await releaseDraftSlot(tx, scope, row, "POSTIZ_DRAFT_NOT_CREATED", true, {
    notice: false,
  });
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
 * confirmed for draft delivery or a canceled run withdraws it (slot back);
 * an agent approval that no longer counts (authority, bot, M2) withdraws it
 * with a notice; a blocker or a send that cannot be prepared fails it (I2c);
 * the same version already in Postiz is recorded as delivered (M8); a
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
      const find = (kind: string, id: unknown) =>
        typeof id === "string" && UUID.test(id)
          ? tx.entity.findFirst({
              where: {
                id,
                kind,
                workspaceId: scope.workspaceId,
                projectId: scope.projectId,
              },
            })
          : Promise.resolve(null);
      const assignment = await find("assignments", h.assignmentId);
      const run = await find(RUNS, h.assignmentRunId);
      if (
        !assignment ||
        !confirmedHash(data(assignment)) ||
        confirmedDelivery(data(assignment)) !== "postiz_draft"
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
      // The agent's approval must still stand in for the owner's (M2).
      const content = await find("content", h.contentId);
      if (
        h.approvedBy === "agent" &&
        (!content || !(await agentReviewAccepted(tx, scope, data(content))))
      ) {
        await endBooked(
          tx,
          scope,
          row,
          "canceled",
          "AGENT_REVIEW_NOT_ACCEPTED",
          { notice: true },
        );
        return null;
      }
      // Everything up to the send is prepared in a savepoint: any failure,
      // also a database error, ends the handoff failed instead of leaving it
      // queued by a rollback (I2c).
      await tx.$executeRaw`SAVEPOINT prepare_postiz_draft`;
      let send: DraftSend;
      try {
        const blockers = await draftBlockers(tx, scope, h.contentId, slotAt);
        if (blockers.length) throw new DomainError(blockers.join(","), 409);
        const target = await draftTarget(
          tx,
          scope,
          h.contentId,
          h.contentVersion,
          row.id,
        );
        if ("done" in target) {
          await tx.$executeRaw`RELEASE SAVEPOINT prepare_postiz_draft`;
          // The owner handed this version over himself: delivered (M8).
          await update(tx, scope, row, {
            ...h,
            status: "accepted",
            ...existingFields(target.done),
          });
          await audit(tx, scope, "postiz_draft.existing", row.id, {
            existingHandoffId: target.done.id,
          });
          return null;
        }
        send = await draftSend(tx, scope, target, slotAt.toISOString());
        await tx.$executeRaw`RELEASE SAVEPOINT prepare_postiz_draft`;
      } catch (error) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT prepare_postiz_draft`;
        const code =
          error instanceof DomainError
            ? error.message.slice(0, 200)
            : "POSTIZ_DRAFT_PREPARE_FAILED";
        if (!(error instanceof DomainError))
          console.error(
            "Orbit Postiz draft preparation failed",
            errorCode(error),
          );
        // Read again: the savepoint undid nothing of the handoff itself.
        const current = await entity(tx, scope, KIND, row.id);
        await endBooked(tx, scope, current, "failed", code);
        return null;
      }
      const sending = await update(tx, scope, row, {
        ...h,
        status: "sending",
        sendingAt: new Date().toISOString(),
      });
      return { id: sending.id, send };
    },
  );
  if (!prepared) return null;
  return sendDraftHandoff(scope, prepared.id, prepared.send, deps, {
    imageFallback: true,
    after: (tx, row) => afterSend(tx, scope, row),
  });
}

// Reasons that withdraw also the drafts the owner released (R71, R73).
const OWNER_RELEASE_REASONS = [
  "ASSIGNMENT_PAUSED",
  "ASSIGNMENT_ENDED",
  "ASSIGNMENT_DELIVERY_CHANGED",
];

/**
 * Withdraws an assignment's booked drafts that were not sent yet, as
 * withdrawAssignmentPublications does for its posts: on pause, end, budget
 * exhaustion, content or time change. Drafts the owner released are
 * withdrawn only on pause, end or a confirmed delivery change (R71). A
 * draft already in Postiz stays: withdrawing it is done in Postiz. `extra`
 * is recorded on each canceled handoff, so the change's notice counts it.
 */
export async function cancelAssignmentPostizDrafts(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  reason: string,
  extra: Record<string, unknown> = {},
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
      !OWNER_RELEASE_REASONS.includes(reason)
    )
      continue;
    await endBooked(tx, scope, row, "canceled", reason, { extra });
    canceled++;
  }
  return { canceled };
}

/**
 * Sweep pass over the assignment handoffs of the last days (with R54's
 * sweep), each in its own savepoint:
 * - `sending` without a pending or running job: the send may have reached
 *   Postiz, so it becomes `outcome_unknown` with the exception and a notice,
 *   never sent again (I2a);
 * - `queued` whose slot has passed: failed with `SLOT_UNAVAILABLE`, the
 *   deliverable dropped with a notice (I2b);
 * - `queued` whose job ended without sending it (a project pause held it
 *   back, or the job failed on the database): queued again, at most once
 *   per project generation.
 */
export async function requeuePostizDrafts(tx: DbTx, scope: Scope) {
  const result = { requeued: 0, unknown: 0, expired: 0 };
  if (!agentsEnabled()) return result;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return result;
  const since = new Date(Date.now() - REQUEUE_DAYS * 86400000);
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      createdAt: { gte: since },
      OR: ["queued", "sending"].map((status) => ({
        data: { path: ["status"], equals: status },
      })),
    },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const h = data(row);
    if (h.source !== "assignment") continue;
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
      const pending = jobs.some((job) =>
        PENDING_JOB.includes(data(job).status),
      );
      if (h.status === "sending") {
        if (!pending) {
          await markUnknown(tx, scope, row);
          result.unknown++;
        }
      } else if (!(Date.parse(String(h.slotAt)) > Date.now())) {
        await endBooked(tx, scope, row, "failed", SLOT_UNAVAILABLE);
        result.expired++;
      } else if (!pending) {
        const job = await enqueue(
          tx,
          scope,
          POSTIZ_DRAFT_TOPIC,
          row.id,
          `postiz_draft:${row.id}:retry:${project.generation}`,
        );
        if (data(job).status === "queued" && !data(job).attempts)
          result.requeued++;
      }
      await tx.$executeRaw`RELEASE SAVEPOINT requeue_postiz_draft`;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT requeue_postiz_draft`;
      console.error("Orbit Postiz draft sweep failed", errorCode(error));
    }
  }
  return result;
}

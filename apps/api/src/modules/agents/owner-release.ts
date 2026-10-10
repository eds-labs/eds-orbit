import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, update } from "../../shared.ts";
import { activePolicy, approve, packageFor } from "../policy.ts";
import { publishIntent, reviewContent } from "../workflow.ts";
import { confirmedHash, withinConfirmation } from "./agent-review.ts";
import { SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import { agentsEnabled, deliveryOf } from "./assignments.ts";
import { bookPostizDraft } from "./draft-delivery.ts";
import { postizDraftsEnabled } from "../postiz-draft.ts";
import { moveDraft, slotKey, vetoSlot, type RunSlot } from "./veto.ts";

/**
 * The owner's release of one assignment draft that was left for them (spec
 * §6 "posts wait for owner approval", R70 I1): the review left it
 * `needs_review` (R47/R49), no bot is linked, or agent review authority is
 * off (`ORBIT_AGENT_REVIEW_AUTHORITY`). The owner saw the exact text, so:
 *
 * - their decision is the human content review (`humanReviewedBodyHash`,
 *   `reviewedBy` = the owner), as with a package schedule;
 * - the draft-only mission may publish exactly this post
 *   (`publishAuthorizedBy.contentId`; preflight binds an assignment
 *   mission's publish right to that content, so no other draft of the
 *   mission or the run gains it);
 * - in assisted mode the owner's package approval is recorded too;
 * - the post is scheduled through `publishIntent` without a veto window,
 *   because the owner approved it.
 *
 * Slot: the draft's run slot (`plannedSlotAt`). If that slot is taken or has
 * passed, the post moves to the next free half hour of the same local day by
 * the rules `scheduleApproved` uses (`vetoSlot` with no window); without one
 * the release is refused with `SLOT_UNAVAILABLE` and nothing changes. The
 * assignment is checked through its confirmation (`confirmedHash`), so a
 * one-off that completed its run still works. Every deterministic blocker
 * stays absolute: preflight runs in `publishIntent` again at handoff, and any
 * failure rolls the whole release back. Releasing again returns the same
 * publication.
 *
 * With the delivery "Postiz draft" (R73) the release publishes nothing: the
 * owner's review is recorded the same way, but instead of a publication and
 * a publish right the draft is booked as a Postiz draft at the same slot
 * (`bookPostizDraft`, which checks the deterministic blockers at the slot);
 * the worker sends it. Releasing again returns the same handoff.
 */
export const releaseInput = z
  .object({ version: z.number().int().positive() })
  .strict();

const RUNS = "assignment_runs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INACTIVE = ["canceled", "failed", "blocked_dependency"];
// Same tolerance after the slot as the mission the copywriter creates.
const SLOT_WINDOW_MS = 2 * 3600000;

export type ReleaseResult = {
  result: "released" | "already_released";
  delivery: "publish" | "postiz_draft";
  // The publication (delivery "publish") or the Postiz draft handoff (R73).
  publicationId: string | null;
  postizDraftId: string | null;
  scheduledAt: string;
  // The run slot the draft was planned for; differs when the post moved.
  requestedAt: string;
};

/** The owner-released publication of a content that is still active, if any. */
async function releasedPublication(tx: DbTx, scope: Scope, contentId: string) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      data: { path: ["contentId"], equals: contentId },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.find((row) => !INACTIVE.includes(data(row).status)) ?? null;
}

/** The assignment's Postiz draft handoff of a content that still delivers (R73), if any. */
async function bookedDraft(tx: DbTx, scope: Scope, contentId: string) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "postiz_drafts",
      data: { path: ["contentId"], equals: contentId },
    },
    orderBy: { createdAt: "asc" },
  });
  return (
    rows.find(
      (row) =>
        data(row).source === "assignment" &&
        !["failed", "canceled"].includes(data(row).status),
    ) ?? null
  );
}

export async function releaseAssignmentDraft(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  version: number,
): Promise<ReleaseResult> {
  if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  if (!UUID.test(contentId)) throw new DomainError("NOT_FOUND", 404);
  // One booking at a time per project, as scheduleApproved does: two
  // releases, or a release and a run's scheduling, never take the same slot.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId},0))`;
  const content = await entity(tx, scope, "content", contentId);
  const c = data(content);
  if (
    typeof c.assignmentRunId !== "string" ||
    typeof c.assignmentId !== "string"
  )
    throw new DomainError("NOT_FOUND", 404);
  // A second click: the post was released already.
  const existing = await releasedPublication(tx, scope, content.id);
  if (existing) {
    const p = data(existing);
    if (!p.ownerReleasedAt)
      throw new DomainError("DRAFT_NOT_AWAITING_OWNER", 409);
    return {
      result: "already_released",
      delivery: "publish",
      publicationId: existing.id,
      postizDraftId: null,
      scheduledAt: p.scheduledAt,
      requestedAt: p.requestedSlotAt ?? p.scheduledAt,
    };
  }
  const booked = await bookedDraft(tx, scope, content.id);
  if (booked) {
    const h = data(booked);
    if (h.approvedBy !== "owner")
      throw new DomainError("DRAFT_NOT_AWAITING_OWNER", 409);
    return {
      result: "already_released",
      delivery: "postiz_draft",
      publicationId: null,
      postizDraftId: booked.id,
      scheduledAt: h.slotAt,
      requestedAt: h.requestedSlotAt ?? h.slotAt,
    };
  }
  // Blog and newsletter drafts are saved to Drive, never published.
  if (c.type !== "social") throw new DomainError("DRAFT_NOT_PUBLISHABLE", 409);
  if (c.status !== "needs_review" || c.supersededBy)
    throw new DomainError("DRAFT_NOT_AWAITING_OWNER", 409);
  if (content.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const assignment = data(
    await entity(tx, scope, "assignments", c.assignmentId),
  );
  if (!confirmedHash(assignment) || !withinConfirmation(assignment, c))
    throw new DomainError("ASSIGNMENT_NOT_CONFIRMED", 409);
  const drafting = deliveryOf(assignment) === "postiz_draft";
  if (drafting && !postizDraftsEnabled())
    throw new DomainError("POSTIZ_DRAFTS_DISABLED", 409);
  const run = await entity(tx, scope, RUNS, c.assignmentRunId);
  const r = data(run);
  // A canceled run (paused, changed or ended assignment) publishes nothing more.
  if (r.assignmentId !== c.assignmentId || r.status === "canceled")
    throw new DomainError("RUN_CANCELED", 409);
  if (
    ((r.scheduling?.dropped ?? []) as Array<{ contentId: string }>).some(
      (entry) => entry.contentId === content.id,
    )
  )
    throw new DomainError("DRAFT_NOT_AWAITING_OWNER", 409);
  const mission = await entity(tx, scope, "missions", c.missionId);
  if (data(mission).assignmentRunId !== c.assignmentRunId)
    throw new DomainError("MISSION_SCOPE_NOT_ALLOWED", 409);
  if (data(mission).status === "ready")
    throw new DomainError("MISSION_STILL_DRAFTING", 409);
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);

  const planned = new Date(data(mission).plannedSlotAt);
  const slots: RunSlot[] = ((r.slots ?? []) as RunSlot[]).map((slot) => ({
    ...slot,
  }));
  const now = new Date();
  const target = await vetoSlot(
    tx,
    scope,
    run.id,
    c.channel,
    planned,
    0,
    now,
    // The run's other slots that still wait for a decision keep holding theirs.
    new Set(
      slots
        .filter((slot) => !slot.publicationId && !slot.releasedAt)
        .map((slot) => slotKey(slot.channel, slot.at)),
    ),
  );
  if (!target) throw new DomainError(SLOT_UNAVAILABLE, 409);
  const moved = await moveDraft(tx, scope, content, mission, target);
  if (drafting)
    return releaseAsPostizDraft(tx, scope, {
      moved,
      run,
      slots,
      planned,
      target,
      now,
    });

  // The draft-only mission may publish exactly this post, until its slot.
  const action =
    process.env.EXECUTION_MODE === "live" ? "publish_live" : "publish_test";
  const slotEnd = target.valueOf() + SLOT_WINDOW_MS;
  const current = await entity(tx, scope, "missions", mission.id);
  const m = data(current);
  await update(tx, scope, current, {
    ...m,
    allowedActions: [...new Set([...(m.allowedActions ?? []), action])],
    endAt: new Date(
      Math.max(
        Date.parse(m.endAt),
        Math.min(slotEnd, Date.parse(data(policyRow).endAt)),
      ),
    ).toISOString(),
    publishAuthorizedBy: {
      contentId: content.id,
      releasedBy: scope.userId,
      releasedAt: now.toISOString(),
    },
  });
  await audit(tx, scope, "mission.publish_authorized", mission.id, {
    contentId: content.id,
    action,
    ownerRelease: true,
  });
  // The owner saw the exact text: their decision is the human content review.
  const reviewed = await reviewContent(
    tx,
    scope,
    content.id,
    moved.version,
    true,
  );
  if (data(reviewed).status !== "reviewed")
    throw new DomainError(
      ((data(reviewed).review?.problems ?? []) as string[]).join(",") ||
        "CONTENT_REVIEW_REQUIRED",
      409,
    );
  if (data(policyRow).mode === "assisted") {
    const post = await packageFor(tx, scope, reviewed.id);
    await approve(
      tx,
      scope,
      {
        contentId: reviewed.id,
        version: reviewed.version,
        packageHash: post.packageHash,
      },
      new Date(Math.max(Date.now() + 86400000, slotEnd)),
    );
  }
  const created = await publishIntent(tx, scope, {
    contentId: reviewed.id,
    version: reviewed.version,
    scheduledAt: target.toISOString(),
  });
  // Linked to its run like the run's other posts, marked as the owner's.
  const publication = await update(tx, scope, created, {
    ...data(created),
    assignmentId: c.assignmentId,
    assignmentRunId: c.assignmentRunId,
    ownerReleasedAt: now.toISOString(),
    ownerReleasedBy: scope.userId,
    requestedSlotAt: planned.toISOString(),
  });
  const scheduledAt = data(publication).scheduledAt as string;
  const index = slots.findIndex(
    (slot) =>
      slot.channel === c.channel &&
      Date.parse(slot.at) === planned.valueOf() &&
      !slot.publicationId,
  );
  if (index >= 0) {
    const {
      releasedAt: _released,
      releaseReason: _reason,
      ...slot
    } = slots[index]!;
    slots[index] = {
      ...slot,
      at: scheduledAt,
      ...(scheduledAt !== slot.at ? { requestedAt: slot.at } : {}),
      publicationId: publication.id,
    };
  }
  const latest = await entity(tx, scope, RUNS, run.id);
  await update(tx, scope, latest, {
    ...data(latest),
    slots,
    scheduling: {
      at: r.scheduling?.at ?? now.toISOString(),
      publicationIds: [
        ...new Set([
          ...((r.scheduling?.publicationIds ?? []) as string[]),
          publication.id,
        ]),
      ],
      dropped: r.scheduling?.dropped ?? [],
    },
  });
  await audit(tx, scope, "assignment.draft_released", content.id, {
    publicationId: publication.id,
    runId: run.id,
    assignmentId: c.assignmentId,
    scheduledAt,
    requestedAt: planned.toISOString(),
    test: data(publication).test,
  });
  return {
    result: "released",
    delivery: "publish",
    publicationId: publication.id,
    postizDraftId: null,
    scheduledAt,
    requestedAt: planned.toISOString(),
  };
}

/**
 * The release of a draft-delivery assignment's draft (R73): the owner's
 * review of exactly this text, then the booking of the Postiz draft at the
 * slot, recorded on the run like a release. No publish right, no package
 * approval and no publication: nothing is published by Orbit.
 */
async function releaseAsPostizDraft(
  tx: DbTx,
  scope: Scope,
  input: {
    moved: Awaited<ReturnType<typeof entity>>;
    run: Awaited<ReturnType<typeof entity>>;
    slots: RunSlot[];
    planned: Date;
    target: Date;
    now: Date;
  },
): Promise<ReleaseResult> {
  const { moved, run, slots, planned, target, now } = input;
  const c = data(moved);
  const r = data(run);
  // The owner saw the exact text: their decision is the human content review.
  const reviewed = await reviewContent(
    tx,
    scope,
    moved.id,
    moved.version,
    true,
  );
  if (data(reviewed).status !== "reviewed")
    throw new DomainError(
      ((data(reviewed).review?.problems ?? []) as string[]).join(",") ||
        "CONTENT_REVIEW_REQUIRED",
      409,
    );
  const handoff = await bookPostizDraft(tx, scope, {
    content: reviewed,
    slotAt: target,
    runId: run.id,
    assignmentId: c.assignmentId,
    approvedBy: "owner",
    reviewTaskId: null,
  });
  const booked = await update(tx, scope, handoff, {
    ...data(handoff),
    requestedSlotAt: planned.toISOString(),
  });
  const slotAt = target.toISOString();
  const index = slots.findIndex(
    (slot) =>
      slot.channel === c.channel &&
      Date.parse(slot.at) === planned.valueOf() &&
      !slot.publicationId &&
      !slot.postizDraftId,
  );
  if (index >= 0) {
    const {
      releasedAt: _released,
      releaseReason: _reason,
      ...slot
    } = slots[index]!;
    slots[index] = {
      ...slot,
      at: slotAt,
      ...(slotAt !== slot.at ? { requestedAt: slot.at } : {}),
      postizDraftId: booked.id,
    };
  }
  const latest = await entity(tx, scope, RUNS, run.id);
  await update(tx, scope, latest, {
    ...data(latest),
    slots,
    scheduling: {
      at: r.scheduling?.at ?? now.toISOString(),
      publicationIds: (r.scheduling?.publicationIds ?? []) as string[],
      postizDraftIds: [
        ...new Set([
          ...((r.scheduling?.postizDraftIds ?? []) as string[]),
          booked.id,
        ]),
      ],
      dropped: r.scheduling?.dropped ?? [],
    },
  });
  await audit(tx, scope, "assignment.draft_released", moved.id, {
    postizDraftId: booked.id,
    runId: run.id,
    assignmentId: c.assignmentId,
    scheduledAt: slotAt,
    requestedAt: planned.toISOString(),
    delivery: "postiz_draft",
  });
  return {
    result: "released",
    delivery: "postiz_draft",
    publicationId: null,
    postizDraftId: booked.id,
    scheduledAt: slotAt,
    requestedAt: planned.toISOString(),
  };
}

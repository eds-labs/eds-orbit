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
import { enqueue, publishIntent } from "../workflow.ts";
import { agentReviewAccepted } from "./agent-review.ts";
import { SLOT_STEP_MS, SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import { agentsEnabled } from "./assignments.ts";
import {
  withdrawPublication,
  type WithdrawReason,
} from "./package-schedule.ts";
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
const HANDED_OVER = [
  "sending",
  "published",
  "published_test",
  "outcome_unknown",
  "failed",
];
const INACTIVE = ["canceled", "failed", "blocked_dependency"];
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
 * `scheduling`. Calling it again creates nothing new and returns the run's
 * publications that are still active.
 */
export async function scheduleApproved(
  tx: DbTx,
  scope: Scope,
  runId: string,
  now = new Date(),
) {
  if (!agentsEnabled()) return [];
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${runId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const run = await entity(tx, scope, RUNS, runId);
  const r = data(run);
  const assignmentRow = await entity(tx, scope, "assignments", r.assignmentId);
  const assignment = data(assignmentRow);
  // Blog and newsletter drafts were saved to Drive by the review; they are never published.
  if (assignment.contentType !== "social") return [];
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
    JSON.stringify(slots) !== JSON.stringify(r.slots ?? []) ||
    JSON.stringify(scheduling) !== JSON.stringify(r.scheduling ?? null)
  ) {
    // publishIntent does not touch the run; read it again all the same.
    const current = await entity(tx, scope, RUNS, runId);
    await update(tx, scope, current, { ...data(current), slots, scheduling });
  }
  return scheduled;
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
  if (HANDED_OVER.includes(p.status)) return { result: "already_handed_over" };
  // Withdrawn before (assignment paused or ended): it will not go out either.
  if (p.status === "canceled") return { result: "vetoed" };
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
 * when it is paused, ends or runs out of budget (R20/R23): a stopped
 * assignment publishes nothing more. Handed-over posts stay as they are.
 */
export async function withdrawAssignmentPublications(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  reason: Extract<WithdrawReason, "ASSIGNMENT_PAUSED" | "ASSIGNMENT_ENDED">,
) {
  let withdrawn = 0;
  for (const row of await rowsWhere(
    tx,
    scope,
    PUBLICATIONS,
    "assignmentId",
    assignmentId,
  ))
    if (data(row).vetoDeadline && data(row).status === "intent_created") {
      await withdrawPublication(tx, scope, row, reason);
      withdrawn++;
    }
  return { withdrawn };
}

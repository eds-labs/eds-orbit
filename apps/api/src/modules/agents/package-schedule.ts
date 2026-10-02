import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, update } from "../../shared.ts";
import { chatScoped } from "../chat.ts";
import {
  consumeActionRequest,
  createActionRequest,
  type RequestedBy,
} from "../action-requests.ts";
import { activePolicy, approve, packageFor } from "../policy.ts";
import { publishIntent, reviewContent } from "../workflow.ts";
import { invalidateContent } from "../content-invalidation.ts";
import {
  contentPackagesEnabled,
  currentDraft,
  startedDeliverable,
} from "./content-packages.ts";
import { channelSlots } from "./scheduling.ts";

/**
 * Scheduling a package post by owner decision (Orbit Core J3.1). A proposal
 * binds one exact post (text, asset, channel, slot, policy and publisher) by
 * hash; only an owner's approval schedules it through the existing publisher,
 * whose preflight runs again immediately before the handoff.
 */
// Same tolerance as a package mission's planned slot.
const SLOT_WINDOW_MS = 2 * 3600000;

export const scheduleProposal = z
  .object({
    deliverableKey: z.string().trim().min(1).max(80),
    // Project-local day; the next free slot when omitted.
    date: z.iso.date().optional(),
  })
  .strict();

export const scheduleRequestPayload = z
  .object({
    packageId: z.string().min(1),
    deliverableKey: z.string().min(1),
    contentId: z.string().min(1),
    contentVersion: z.number().int().positive(),
    missionId: z.string().min(1),
    channel: z.string().min(1),
    scheduledAt: z.iso.datetime(),
    body: z.string(),
    assetId: z.string().nullable(),
    executionMode: z.enum(["test", "live"]),
    // packageFor() hash of the post as proposed.
    postHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type SchedulePayload = z.infer<typeof scheduleRequestPayload>;

const executionMode = () =>
  process.env.EXECUTION_MODE === "live" ? "live" : "test";
const ACTIVE_REQUEST = ["pending", "approved"];
const DONE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

/** Proposes the next free (or the named day's) slot for one package draft; schedules nothing. */
export async function proposeSchedule(
  scope: Scope,
  conversationId: string,
  raw: unknown,
  requestedBy: RequestedBy = { kind: "user", userId: scope.userId },
) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const input = scheduleProposal.parse(raw);
  return chatScoped(scope, async (tx) => {
    const { pkg, steps, step } = await startedDeliverable(
      tx,
      scope,
      conversationId,
      input.deliverableKey,
    );
    const current = await currentDraft(tx, scope, step);
    if (current.pending) throw new DomainError("REVISION_IN_PROGRESS", 409);
    if (!current.draft) throw new DomainError("DRAFT_REQUIRED", 409);
    const draft = current.draft;
    if (data(draft).supersededBy)
      throw new DomainError("DRAFT_SUPERSEDED", 409);
    const mission = await entity(tx, scope, "missions", data(draft).missionId);
    if (data(mission).packageId !== pkg.id)
      throw new DomainError("SCHEDULE_DRAFT_NOT_IN_PACKAGE", 409);
    await assertNoOpenSchedule(tx, scope, step.schedule);
    const channel = String(data(draft).channel);
    const overview = (await channelSlots(tx, scope, { channels: [channel] }))
      .channels[0]!;
    const slot = input.date
      ? overview.slots.find((candidate) => candidate.date === input.date)
      : overview.slots.find((candidate) => candidate.free);
    if (input.date && !slot)
      throw new DomainError("SCHEDULE_DATE_OUT_OF_RANGE", 409);
    if (!slot || !slot.free)
      return {
        status: slot ? ("slot_taken" as const) : ("no_free_slot" as const),
        deliverableKey: step.key as string,
        channel,
        date: slot?.date ?? null,
        reasons: slot?.reasons ?? [],
        nextFree: overview.nextFree,
      };
    // The slot belongs to the post: it is part of the hash the owner approves.
    let content = draft;
    if (data(draft).scheduledAt !== slot.at) {
      content = await update(tx, scope, draft, {
        ...data(draft),
        scheduledAt: slot.at,
      });
      await invalidateContent(tx, scope, draft.id);
    }
    const post = await packageFor(tx, scope, content.id);
    const payload: SchedulePayload = {
      packageId: pkg.id,
      deliverableKey: step.key,
      contentId: content.id,
      contentVersion: content.version,
      missionId: mission.id,
      channel,
      scheduledAt: slot.at,
      body: String(data(content).body),
      assetId: data(content).assetId ?? null,
      executionMode: executionMode(),
      postHash: post.packageHash,
    };
    const request = await createActionRequest(tx, scope, {
      actionType: "content.schedule",
      payload,
      requestedBy,
    });
    await update(tx, scope, pkg, {
      ...data(pkg),
      steps: steps.map((candidate) =>
        candidate === step
          ? {
              ...step,
              schedule: {
                actionRequestId: request.id,
                contentId: content.id,
                scheduledAt: slot.at,
                requestedAt: new Date().toISOString(),
              },
            }
          : candidate,
      ),
    });
    await audit(tx, scope, "content_package.schedule_proposed", request.id, {
      packageId: pkg.id,
      contentId: content.id,
      scheduledAt: slot.at,
    });
    return {
      status: "proposed" as const,
      actionRequestId: request.id,
      deliverableKey: step.key as string,
      channel,
      scheduledAt: slot.at,
      executionMode: payload.executionMode,
    };
  });
}

/** One open decision or active publication per package post. */
async function assertNoOpenSchedule(
  tx: DbTx,
  scope: Scope,
  schedule: Record<string, any> | undefined,
) {
  if (!schedule) return;
  if (schedule.publicationId) {
    const publication = await entity(
      tx,
      scope,
      "publications",
      schedule.publicationId,
    );
    if (!DONE_PUBLICATION.includes(data(publication).status))
      throw new DomainError("ALREADY_SCHEDULED", 409);
    return;
  }
  const request = await entity(
    tx,
    scope,
    "action_requests",
    schedule.actionRequestId,
  );
  if (
    ACTIVE_REQUEST.includes(data(request).status) &&
    Date.parse(data(request).expiresAt) > Date.now()
  )
    throw new DomainError("SCHEDULE_ALREADY_PROPOSED", 409);
}

/** Decision check: the exact post, mode and slot the owner saw must still hold. */
export async function revalidateSchedule(
  tx: DbTx,
  scope: Scope,
  payload: SchedulePayload,
) {
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const pkg = await entity(tx, scope, "content_packages", payload.packageId);
  if (data(pkg).status !== "started")
    throw new DomainError("PACKAGE_NOT_STARTED", 409);
  const content = await entity(tx, scope, "content", payload.contentId);
  if (
    content.version !== payload.contentVersion ||
    data(content).supersededBy ||
    payload.executionMode !== executionMode() ||
    (await packageFor(tx, scope, content.id)).packageHash !== payload.postHash
  )
    throw new DomainError("SCHEDULE_STALE", 409);
  const slot = (
    await channelSlots(tx, scope, { channels: [payload.channel] })
  ).channels[0]!.slots.find(
    (candidate) => candidate.at === payload.scheduledAt,
  );
  if (!slot?.free) throw new DomainError("SCHEDULE_SLOT_TAKEN", 409);
}

/**
 * Runs in the owner's decision transaction: any failure, including a live
 * preflight blocker, rolls the decision back and leaves the draft unchanged.
 */
export async function executeSchedule(
  tx: DbTx,
  scope: Scope,
  request: { id: string; data: unknown },
) {
  const payload = scheduleRequestPayload.parse(data(request).payload);
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const slotEnd = Date.parse(payload.scheduledAt) + SLOT_WINDOW_MS;
  // The draft-only mission may publish exactly this post, until its slot.
  const mission = await entity(tx, scope, "missions", payload.missionId);
  const m = data(mission);
  if (m.status === "ready")
    throw new DomainError("MISSION_STILL_DRAFTING", 409);
  const action =
    payload.executionMode === "live" ? "publish_live" : "publish_test";
  await update(tx, scope, mission, {
    ...m,
    allowedActions: [...new Set([...(m.allowedActions ?? []), action])],
    endAt: new Date(
      Math.max(
        Date.parse(m.endAt),
        Math.min(slotEnd, Date.parse(data(policyRow).endAt)),
      ),
    ).toISOString(),
    publishAuthorizedBy: {
      actionRequestId: request.id,
      contentId: payload.contentId,
    },
  });
  await audit(tx, scope, "mission.publish_authorized", mission.id, {
    actionRequestId: request.id,
    contentId: payload.contentId,
    action,
  });
  // The owner saw the exact text: their decision is the human content review.
  const reviewed = await reviewContent(
    tx,
    scope,
    payload.contentId,
    payload.contentVersion,
    true,
  );
  if (data(reviewed).status !== "reviewed")
    throw new DomainError("CONTENT_REVIEW_REQUIRED", 409);
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
  const publication = await publishIntent(tx, scope, {
    contentId: reviewed.id,
    version: reviewed.version,
  });
  await consumeActionRequest(
    tx,
    scope,
    request.id,
    "schedule:" + request.id,
    data(request).packageHash,
  );
  const pkg = await entity(tx, scope, "content_packages", payload.packageId);
  await update(tx, scope, pkg, {
    ...data(pkg),
    steps: (data(pkg).steps as Array<Record<string, any>>).map((step) =>
      step.schedule?.actionRequestId === request.id
        ? {
            ...step,
            schedule: { ...step.schedule, publicationId: publication.id },
          }
        : step,
    ),
  });
  await audit(tx, scope, "content_package.scheduled", publication.id, {
    actionRequestId: request.id,
    packageId: payload.packageId,
    scheduledAt: payload.scheduledAt,
    test: data(publication).test,
  });
}

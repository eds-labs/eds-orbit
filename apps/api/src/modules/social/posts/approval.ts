import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  consumeActionRequest,
  createActionRequest,
  type ActionDefinition,
} from "../../../platform/governance/action-requests.ts";
import { audit, data, DomainError } from "../../../shared.ts";
import { startDelivery } from "../dispatch/dispatch.ts";
import { SocialDetailError } from "../errors.ts";
import {
  APPROVAL_BEARING,
  currentIssues,
  getPost,
  lockPost,
  packageOf,
  packageWith,
  resetApproval,
  type PostView,
  type SocialPostRow,
} from "./posts.ts";
import { resolveSchedule, type ResolvedSchedule } from "./schedule-time.ts";

// Approving the publication of a social post (ADR 0020 §6.3, S-D6, S-D9).
// An owner's own schedule or publish-now in the UI is its approval; anyone
// else's becomes an ActionRequest the owner decides in Decisions. The
// approval binds the package (content, accounts, images, time); a change
// clears it. Nothing is sent here: S5 publishes approved posts.

export const SCHEDULE_ACTION = "social.post.schedule";
export const PUBLISH_NOW_ACTION = "social.post.publish_now";

const approvalPayload = z
  .object({
    postId: z.uuid(),
    postVersion: z.int().min(1),
    packageHash: z.string().regex(/^[0-9a-f]{64}$/),
    requesterId: z.string().min(1),
    schedule: z
      .object({
        mode: z.enum(["at", "now"]),
        at: z.string().nullable(),
        local: z.string().nullable(),
        timeZone: z.string(),
      })
      .strict(),
    variants: z
      .array(
        z
          .object({
            accountId: z.uuid(),
            platform: z.enum(["x", "facebook", "instagram", "telegram"]),
            handle: z.string(),
            body: z.string(),
            media: z.array(
              z
                .object({ mediaId: z.uuid(), width: z.int(), height: z.int(), altText: z.string().nullable() })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type SocialApprovalPayload = z.infer<typeof approvalPayload>;

const LEAD_MS = 2 * 60_000;
const stale = () => new DomainError("SOCIAL_APPROVAL_STALE", 409);

async function requireValid(tx: DbTx, scope: Scope, post: SocialPostRow) {
  const failing = (await currentIssues(tx, scope, post))
    .map((v) => ({ accountId: v.accountId, issues: v.issues.filter((i) => i.severity === "error") }))
    .filter((v) => v.issues.length);
  if (failing.length) throw new SocialDetailError("SOCIAL_VALIDATION_FAILED", 409, { variants: failing });
}

/** Checks a stored request against the post as it is now; throws when it no longer matches. */
async function checkRequest(tx: DbTx, scope: Scope, payload: SocialApprovalPayload, post: SocialPostRow) {
  if (post.readOnly || post.status !== "needs_approval") throw stale();
  // The package hash binds what the owner approves; a title edit (which
  // bumps the version) leaves the request decidable.
  if (post.packageHash !== payload.packageHash) throw stale();
  if ((await packageOf(tx, scope, post.id)).hash !== payload.packageHash) throw stale();
  await requireValid(tx, scope, post);
  if (payload.schedule.mode === "at" && (!post.scheduledAt || post.scheduledAt.getTime() < Date.now() + LEAD_MS))
    throw new DomainError("SOCIAL_SCHEDULE_TOO_SOON", 422);
}

function definition(): ActionDefinition<SocialApprovalPayload> {
  return {
    riskClass: "W2",
    approvalMode: "approval_required",
    deciderRole: "owner",
    policyRequired: false,
    ttlMs: 7 * 86_400_000,
    payload: approvalPayload,
    costCeilingMicros: () => 0,
    summary: (payload) => ({
      operation: {
        kind: "social_post",
        mode: payload.schedule.mode,
        at: payload.schedule.at,
        local: payload.schedule.local,
        timeZone: payload.schedule.timeZone,
        variants: payload.variants,
      },
    }),
    async revalidate(tx, scope, payload) {
      const post = await tx.socialPost.findFirst({ where: { id: payload.postId, projectId: scope.projectId } });
      if (!post) throw stale();
      await checkRequest(tx, scope, payload, post);
    },
    async onApproved(tx, scope, request) {
      const d = data(request);
      const payload = approvalPayload.parse(d.payload);
      const post = await lockPost(tx, scope, payload.postId);
      if (post.approvalRequestId !== request.id) throw stale();
      await checkRequest(tx, scope, payload, post);
      await tx.socialPost.update({
        where: { id: post.id },
        data: {
          status: payload.schedule.mode === "at" ? "scheduled" : "approved",
          approvedAt: new Date(),
          approvedBy: scope.userId,
          version: { increment: 1 },
        },
      });
      await consumeActionRequest(tx, scope, request.id, `social-post:${post.id}`, d.packageHash);
      await startDelivery(tx, scope, post.id);
      await audit(tx, scope, "social.post.approved", post.id, { requestId: request.id, packageHash: payload.packageHash });
    },
  };
}

/** The social action types (registered through the module's contributions). */
export const socialActionTypes: Record<string, ActionDefinition<SocialApprovalPayload>> = {
  [SCHEDULE_ACTION]: definition(),
  [PUBLISH_NOW_ACTION]: definition(),
};

const timeFields = {
  at: z.string().max(40).optional(),
  local: z.string().max(16).optional(),
  timeZone: z.string().max(64).optional(),
  fold: z.enum(["earlier", "later"]).optional(),
};
const scheduleInput = z
  .object({ version: z.int().min(1), ...timeFields })
  .strict()
  .refine((v) => (v.at === undefined) !== (v.local === undefined), "give at or local");
const rescheduleInput = z
  .object({ version: z.int().min(1), reapprove: z.boolean().optional(), ...timeFields })
  .strict()
  .refine((v) => (v.at === undefined) !== (v.local === undefined), "give at or local");
const publishInput = z.object({ version: z.int().min(1) }).strict();

async function resolveFor(tx: DbTx, scope: Scope, input: z.infer<typeof scheduleInput>): Promise<ResolvedSchedule> {
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { timezone: true } });
  const zone = project?.timezone ?? "UTC";
  return resolveSchedule(
    input.at !== undefined ? { at: input.at } : { local: input.local!, timeZone: input.timeZone, fold: input.fold },
    zone,
    new Date(),
  );
}

/** A post that may be submitted: a draft, or one whose request ended without approval. */
async function requireSubmittable(tx: DbTx, scope: Scope, post: SocialPostRow, version: number) {
  if (post.readOnly) throw new DomainError("SOCIAL_POST_READ_ONLY", 409);
  if (post.version !== version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  if (post.status === "draft") return;
  if (post.status === "needs_approval" && post.approvalRequestId) {
    const row = await tx.entity.findFirst({
      where: { id: post.approvalRequestId, projectId: scope.projectId, kind: "action_requests" },
    });
    const d = data(row);
    const open = d.status === "pending" && Date.parse(d.expiresAt) > Date.now();
    if (!open) return;
  }
  throw new DomainError("SOCIAL_POST_NOT_EDITABLE", 409);
}

/**
 * Stores the time, validates, and either approves (an owner's own action)
 * or asks the owner (anyone else). `post` is locked and may carry an old
 * approval, which the caller has already cleared.
 */
async function submit(
  tx: DbTx,
  scope: Scope,
  post: SocialPostRow,
  when: { mode: "at"; resolved: ResolvedSchedule } | { mode: "now" },
): Promise<PostView> {
  await requireValid(tx, scope, post);
  const schedule =
    when.mode === "at"
      ? {
          scheduleMode: "at",
          scheduledAt: when.resolved.at,
          scheduleLocal: when.resolved.local,
          scheduleTimezone: when.resolved.timeZone,
          scheduleFold: when.resolved.fold,
        }
      : { scheduleMode: "now", scheduledAt: null, scheduleLocal: null, scheduleFold: null };
  await tx.socialPost.update({ where: { id: post.id }, data: schedule });
  const { hash } = await packageOf(tx, scope, post.id);
  const version = post.version + 1;
  if (scope.role === "owner") {
    await tx.socialPost.update({
      where: { id: post.id },
      data: {
        status: when.mode === "at" ? "scheduled" : "approved",
        packageHash: hash,
        approvalRequestId: null,
        approvedAt: new Date(),
        approvedBy: scope.userId,
        version,
      },
    });
    await audit(tx, scope, "social.post.approved", post.id, { channel: "owner_direct", packageHash: hash });
    await startDelivery(tx, scope, post.id);
    return getPost(tx, scope, post.id);
  }
  const view = await getPost(tx, scope, post.id);
  const payload: SocialApprovalPayload = {
    postId: post.id,
    postVersion: version,
    packageHash: hash,
    requesterId: scope.userId,
    schedule: {
      mode: when.mode,
      at: view.schedule.at,
      local: view.schedule.local,
      timeZone: view.schedule.timeZone,
    },
    variants: view.variants.map((v) => ({
      accountId: v.accountId,
      platform: v.platform,
      handle: v.handle,
      body: v.body,
      media: v.media,
    })),
  };
  const request = await createActionRequest(tx, scope, {
    actionType: when.mode === "at" ? SCHEDULE_ACTION : PUBLISH_NOW_ACTION,
    payload,
    requestedBy: { kind: "user", userId: scope.userId },
  });
  await tx.socialPost.update({
    where: { id: post.id },
    data: {
      status: "needs_approval",
      packageHash: hash,
      approvalRequestId: request.id,
      approvedAt: null,
      approvedBy: null,
      version,
    },
  });
  await audit(tx, scope, "social.post.approval_requested", post.id, { requestId: request.id, packageHash: hash });
  return getPost(tx, scope, post.id);
}

export async function schedulePost(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView> {
  const input = scheduleInput.parse(raw);
  const post = await lockPost(tx, scope, id);
  await requireSubmittable(tx, scope, post, input.version);
  return submit(tx, scope, post, { mode: "at", resolved: await resolveFor(tx, scope, input) });
}

export async function publishNow(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView> {
  const input = publishInput.parse(raw);
  const post = await lockPost(tx, scope, id);
  await requireSubmittable(tx, scope, post, input.version);
  return submit(tx, scope, post, { mode: "now" });
}

/**
 * A new time (the calendar's drag target, S-D6). A draft only gets the
 * time. An approved or waiting post needs a new approval: an editor's move
 * asks the owner again; an owner's move needs `reapprove` (the UI asks).
 */
export async function reschedulePost(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView> {
  const input = rescheduleInput.parse(raw);
  const post = await lockPost(tx, scope, id);
  if (post.readOnly) throw new DomainError("SOCIAL_POST_READ_ONLY", 409);
  if (post.version !== input.version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  const resolved = await resolveFor(tx, scope, input);
  if (post.status === "draft") {
    await tx.socialPost.update({
      where: { id: post.id },
      data: {
        scheduleMode: "at",
        scheduledAt: resolved.at,
        scheduleLocal: resolved.local,
        scheduleTimezone: resolved.timeZone,
        scheduleFold: resolved.fold,
        version: { increment: 1 },
      },
    });
    await audit(tx, scope, "social.post.rescheduled", post.id, { approvalReset: false });
    return getPost(tx, scope, post.id);
  }
  if (!APPROVAL_BEARING.includes(post.status)) throw new DomainError("SOCIAL_POST_NOT_EDITABLE", 409);
  if (scope.role === "owner" && input.reapprove !== true) throw new DomainError("SOCIAL_REAPPROVAL_REQUIRED", 409);
  await tx.socialPost.update({ where: { id: post.id }, data: await resetApproval(tx, scope, post, "rescheduled") });
  await audit(tx, scope, "social.post.rescheduled", post.id, { approvalReset: true });
  return submit(tx, scope, post, { mode: "at", resolved });
}

// ------------------------------------------------ MCP proposals (S7)

/** The time of an MCP schedule proposal: an instant, or a local time in a zone. */
export type ProposedTime =
  | { mode: "now" }
  | { mode: "at"; at?: string; local?: string; timeZone?: string; fold?: "earlier" | "later" };

/** The package an approval of `when` would bind, as the approval shows it. */
export type ProposedSchedule = {
  packageHash: string;
  mode: "at" | "now";
  at: string | null;
  local: string | null;
  timeZone: string;
  variants: SocialApprovalPayload["variants"];
};

async function resolveProposed(tx: DbTx, scope: Scope, when: ProposedTime): Promise<ResolvedSchedule | null> {
  if (when.mode === "now") return null;
  if ((when.at === undefined) === (when.local === undefined)) throw new DomainError("SOCIAL_SCHEDULE_INVALID", 422);
  return resolveFor(tx, scope, { version: 1, at: when.at, local: when.local, timeZone: when.timeZone, fold: when.fold });
}

/**
 * What approving `when` for the post would bind (S7): checked like a
 * schedule in the UI (submittable, valid, lead time), nothing stored.
 */
export async function proposedSchedule(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  when: ProposedTime,
): Promise<ProposedSchedule> {
  const post = await tx.socialPost.findFirst({ where: { id, projectId: scope.projectId } });
  if (!post) throw new DomainError("NOT_FOUND", 404);
  await requireSubmittable(tx, scope, post, version);
  const resolved = await resolveProposed(tx, scope, when);
  await requireValid(tx, scope, post);
  const { hash } = await packageWith(tx, scope, id, {
    scheduleMode: when.mode,
    scheduledAt: resolved?.at ?? null,
  });
  const view = await getPost(tx, scope, id);
  return {
    packageHash: hash,
    mode: when.mode,
    at: resolved?.at.toISOString() ?? null,
    local: resolved?.local ?? null,
    timeZone: resolved?.timeZone ?? view.schedule.timeZone,
    variants: view.variants.map((v) => ({
      accountId: v.accountId,
      platform: v.platform,
      handle: v.handle,
      body: v.body,
      media: v.media,
    })),
  };
}

/**
 * Applies a time the owner approved through an MCP request (S7): the
 * request is the approval, so no second (native) request is made. The post
 * must still match the approved package exactly.
 */
export async function applyApprovedSchedule(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  when: ProposedTime,
  approval: { packageHash: string; requestId: string; deciderId: string },
): Promise<PostView> {
  const post = await lockPost(tx, scope, id);
  await requireSubmittable(tx, scope, post, version);
  const resolved = await resolveProposed(tx, scope, when);
  await requireValid(tx, scope, post);
  const schedule =
    resolved
      ? {
          scheduleMode: "at",
          scheduledAt: resolved.at,
          scheduleLocal: resolved.local,
          scheduleTimezone: resolved.timeZone,
          scheduleFold: resolved.fold,
        }
      : { scheduleMode: "now", scheduledAt: null, scheduleLocal: null, scheduleFold: null };
  await tx.socialPost.update({ where: { id: post.id }, data: schedule });
  if ((await packageOf(tx, scope, post.id)).hash !== approval.packageHash) throw stale();
  await tx.socialPost.update({
    where: { id: post.id },
    data: {
      status: resolved ? "scheduled" : "approved",
      packageHash: approval.packageHash,
      approvalRequestId: approval.requestId,
      approvedAt: new Date(),
      approvedBy: approval.deciderId,
      version: post.version + 1,
    },
  });
  // The run acts as the proposing member: the audit names the decider.
  await audit(tx, scope, "social.post.approved", post.id, {
    channel: "mcp_request",
    requestId: approval.requestId,
    approvedBy: approval.deciderId,
    packageHash: approval.packageHash,
  });
  await startDelivery(tx, scope, post.id);
  return getPost(tx, scope, post.id);
}

// ------------------------------------------ origin-authorized posts (S9)

/**
 * Approves a post another module created for content it approved itself
 * (Marketing's package approval, its veto window and preflight): the post
 * is sent right away, without a Social approval. Validity is checked as for
 * any approval; Social's own gates still apply when it sends.
 */
export async function approveOriginPost(
  tx: DbTx,
  scope: Scope,
  id: string,
  origin: { type: string; id: string; version: number; packageHash: string },
): Promise<void> {
  const post = await lockPost(tx, scope, id);
  await requireValid(tx, scope, post);
  await tx.socialPost.update({
    where: { id: post.id },
    data: { scheduleMode: "now", scheduledAt: null, scheduleLocal: null, scheduleFold: null },
  });
  const { hash } = await packageOf(tx, scope, post.id);
  await tx.socialPost.update({
    where: { id: post.id },
    data: {
      status: "approved",
      packageHash: hash,
      approvalRequestId: null,
      approvedAt: new Date(),
      approvedBy: scope.userId,
      version: post.version + 1,
    },
  });
  await audit(tx, scope, "social.post.approved", post.id, {
    channel: "origin_authorized",
    originType: origin.type,
    originId: origin.id,
    originVersion: origin.version,
    originPackageHash: origin.packageHash,
    packageHash: hash,
  });
  await startDelivery(tx, scope, post.id);
}

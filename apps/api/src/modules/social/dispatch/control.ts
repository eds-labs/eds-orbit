import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { publishEvent } from "../../../platform/events/events.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { authorize, PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { audit, data, DomainError } from "../../../shared.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { lockPublication, postOfPublication } from "./claim.ts";
import { publicationView, type PublicationView } from "./publication-view.ts";
import { DELIVER, DISPATCH, RECONCILE } from "./queues.ts";
import { refreshPostStatus } from "./status.ts";

// Stopping, resuming and settling deliveries (ADR 0020 §7 "Cancellation",
// "Pause / disable", unknown outcomes). Cancel stops what was not sent; a
// send in flight is marked and its result still wins. After a pause only
// deliveries due within the last 30 minutes go out (no surprise late posts).
// The owner settles an unclear send; nothing is ever resent.

const LATE_WINDOW_MS = 30 * 60_000;
const ACTIVE_JOB = ["queued", "retry_scheduled", "blocked_dependency"];

async function cancelJobs(tx: DbTx, scope: Scope, publicationId: string) {
  const jobs = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "jobs",
      AND: [{ data: { path: ["topic"], equals: DELIVER } }, { data: { path: ["resourceId"], equals: publicationId } }],
    },
  });
  for (const job of jobs) {
    const d = data(job);
    if (ACTIVE_JOB.includes(d.status))
      await tx.entity.update({
        where: { id: job.id },
        data: { data: { ...d, status: "canceled", error: "SOCIAL_CANCELED" }, version: { increment: 1 } },
      });
  }
}

/** Stops the post's publications that were not sent yet. */
export async function cancelDelivery(tx: DbTx, scope: Scope, postId: string): Promise<{ canceled: number; tooLate: number }> {
  const variants = await tx.socialPostVariant.findMany({ where: { projectId: scope.projectId, postId }, select: { id: true } });
  const pubs = await tx.socialPublication.findMany({ where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } } });
  let canceled = 0;
  let tooLate = 0;
  for (const listed of pubs) {
    const pub = await lockPublication(tx, scope, listed.id);
    const waiting =
      pub.status === "pending" || pub.status === "blocked" || (pub.status === "failed" && pub.retryDisposition === "after-delay" && pub.nextAttemptAt);
    if (waiting) {
      await tx.socialPublication.update({
        where: { id: pub.id },
        data: { status: "canceled", nextAttemptAt: null, fence: null, version: { increment: 1 } },
      });
      await cancelJobs(tx, scope, pub.id);
      canceled++;
    } else if (pub.status === "claimed") {
      // No provider call yet: the delivery drops it before sending.
      await tx.socialPublication.update({ where: { id: pub.id }, data: { status: "cancel_requested", version: { increment: 1 } } });
      tooLate++;
    } else if (pub.status === "sending") {
      // In flight: its result still decides (a crash makes it unknown), but
      // a refusal or Instagram's processing then ends it instead of a retry.
      await tx.socialPublication.update({
        where: { id: pub.id },
        data: {
          providerState: { ...(pub.providerState as Record<string, unknown>), cancelRequested: true } as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      tooLate++;
    } else if (pub.status === "processing" || pub.status === "accepted") tooLate++;
  }
  await refreshPostStatus(tx, scope, postId);
  await audit(tx, scope, "social.post.delivery_canceled", postId, { canceled, tooLate });
  return { canceled, tooLate };
}

/**
 * Project resume hook: deliveries the pause blocked go out again if they
 * were due within the last 30 minutes; older ones wait for a person.
 */
export async function resumeBlocked(tx: DbTx, scope: Scope, now: Date, generation: number): Promise<number> {
  const blocked = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, status: "blocked", blockedCode: "PROJECT_PAUSED" },
    take: 200,
  });
  let resumed = 0;
  for (const pub of blocked) {
    const post = await postOfPublication(tx, scope, pub.variantId);
    const planned = post.scheduleMode === "at" && post.scheduledAt ? post.scheduledAt : pub.createdAt;
    if (planned.getTime() < now.getTime() - LATE_WINDOW_MS) continue;
    await tx.socialPublication.update({
      where: { id: pub.id },
      data: { status: "pending", blockedCode: null, version: { increment: 1 } },
    });
    await enqueue(tx, scope, DELIVER, pub.id, `social-deliver:${pub.id}:g${generation}`, now);
    resumed++;
  }
  // Posts whose dispatch the pause blocked (no publications yet): the same
  // window; older ones stay due and show as missed (attention).
  const dispatches = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "jobs",
      AND: [
        { data: { path: ["topic"], equals: DISPATCH } },
        { data: { path: ["status"], equals: "blocked_dependency" } },
        { data: { path: ["error"], equals: "PROJECT_PAUSED" } },
      ],
    },
    take: 200,
  });
  for (const job of dispatches) {
    const d = data(job);
    const post = await tx.socialPost.findFirst({ where: { id: String(d.resourceId), projectId: scope.projectId } });
    if (!post || !["scheduled", "approved"].includes(post.status) || String(post.version) !== String(d.postVersion)) continue;
    const planned = post.scheduleMode === "at" && post.scheduledAt ? post.scheduledAt : (post.approvedAt ?? job.createdAt);
    if (planned.getTime() < now.getTime() - LATE_WINDOW_MS) continue;
    await enqueue(tx, scope, DISPATCH, post.id, `social-dispatch:${post.id}:v${post.version}:g${generation}`, now, {
      postVersion: String(post.version),
    });
    resumed++;
  }
  // Instagram posts still processing: their read-back starts again.
  const processing = await tx.socialPublication.findMany({ where: { projectId: scope.projectId, status: "processing" }, take: 200 });
  for (const pub of processing)
    await enqueue(tx, scope, RECONCILE, pub.id, `social-reconcile:${pub.id}:g${generation}`, now, { attempt: "1" });
  return resumed;
}

const resolveInput = z
  .object({
    resolution: z.enum(["published_confirmed", "not_published"]),
    permalink: z.url({ protocol: /^https$/ }).max(500).optional(),
    version: z.int().min(1),
  })
  .strict();

/** The owner says what happened to an unclear send. */
export async function resolvePublication(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PublicationView> {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = resolveInput.parse(raw);
  const pub = await lockPublication(tx, scope, id);
  // History mirrored from another system is not Social's to settle (S10).
  if (pub.legacyEntityId) throw new DomainError("SOCIAL_POST_READ_ONLY", 409);
  if (pub.status !== "outcome_unknown") throw new DomainError("SOCIAL_PUBLICATION_NOT_UNKNOWN", 409);
  if (pub.version !== input.version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  const published = input.resolution === "published_confirmed";
  const row = await tx.socialPublication.update({
    where: { id },
    data: published
      ? {
          status: "published",
          resolution: input.resolution,
          resolvedBy: scope.userId,
          publishedAt: new Date(),
          ...(input.permalink ? { permalink: input.permalink } : {}),
          version: { increment: 1 },
        }
      : {
          status: "failed",
          resolution: input.resolution,
          resolvedBy: scope.userId,
          retryDisposition: "never",
          nextAttemptAt: null,
          lastErrorCode: "SOCIAL_NOT_PUBLISHED",
          version: { increment: 1 },
        },
  });
  const post = await postOfPublication(tx, scope, pub.variantId);
  const account = await tx.socialAccount.findFirstOrThrow({ where: { id: pub.accountId, projectId: scope.projectId } });
  await audit(tx, scope, "social.publication.resolved", id, { resolution: input.resolution });
  await refreshPostStatus(tx, scope, post.id);
  await publishEvent(tx, scope, {
    type: published ? "social.publication.published" : "social.publication.failed",
    subject: { type: "social.publication", id },
    actor: { kind: "user", id: scope.userId },
    origin: "social",
    data: { postId: post.id, platform: account.platform },
  });
  return publicationView(row, account.platform as SocialPlatform);
}

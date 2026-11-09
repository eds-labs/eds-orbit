import { createHash, randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { audit, data } from "../../../shared.ts";
import { lockPost, packageOf } from "../posts/posts.ts";
import { DELIVER, DISPATCH } from "./queues.ts";

// From an approved post to its publications (ADR 0020 §7, S5). Approving a
// post enqueues one dispatch job for that exact version, due at the post's
// time (now for publish-now). Publications are created only when it runs,
// so editing, moving or canceling the post before then only cancels the
// job, and a job of an older version finds nothing to do.

const ACTIVE_JOB = ["queued", "retry_scheduled", "blocked_dependency"];

export const idempotencyKeyOf = (p: { postId: string; variantId: string; accountId: string; packageHash: string }) =>
  "social:" + createHash("sha256").update(`${p.postId}:${p.variantId}:${p.accountId}:${p.packageHash}`).digest("hex");

/**
 * Enqueues the dispatch of an approved (`scheduled` or `approved`) post.
 * `originSlotAt`: the origin's planned time (Marketing's slot), carried to
 * the publications for the lateness limit (lateness.ts).
 */
export async function startDelivery(tx: DbTx, scope: Scope, postId: string, options: { originSlotAt?: Date } = {}): Promise<void> {
  const post = await tx.socialPost.findFirstOrThrow({ where: { id: postId, projectId: scope.projectId } });
  await enqueue(
    tx,
    scope,
    DISPATCH,
    post.id,
    `social-dispatch:${post.id}:v${post.version}`,
    post.scheduleMode === "at" && post.scheduledAt ? post.scheduledAt : new Date(),
    {
      postVersion: String(post.version),
      ...(options.originSlotAt ? { originSlotAt: options.originSlotAt.toISOString() } : {}),
    },
  );
}

/** Cancels the post's waiting dispatch jobs (the approval they carried ended). */
export async function stopDelivery(tx: DbTx, scope: Scope, postId: string, reason: string): Promise<void> {
  const jobs = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "jobs",
      AND: [
        { data: { path: ["topic"], equals: DISPATCH } },
        { data: { path: ["resourceId"], equals: postId } },
      ],
    },
  });
  for (const job of jobs) {
    const d = data(job);
    if (!ACTIVE_JOB.includes(d.status)) continue;
    await tx.entity.update({
      where: { id: job.id },
      data: { data: { ...d, status: "canceled", error: `SOCIAL_${reason.toUpperCase()}` }, version: { increment: 1 } },
    });
  }
}

/**
 * The dispatch job: creates a publication per variant of the approved
 * version and enqueues their delivery. Anything else is "canceled".
 */
export async function dispatchPost(
  scope: Scope,
  postId: string,
  postVersion: number,
  originSlotAt?: string,
): Promise<{ status: "succeeded" | "canceled"; errorCode: string | null }> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const post = await lockPost(tx, scope, postId);
    if (!["scheduled", "approved"].includes(post.status) || post.version !== postVersion)
      return { status: "canceled", errorCode: "SOCIAL_POST_CHANGED" };
    const { hash } = await packageOf(tx, scope, post.id);
    if (hash !== post.packageHash) return { status: "canceled", errorCode: "SOCIAL_POST_CHANGED" };
    const variants = await tx.socialPostVariant.findMany({ where: { projectId: scope.projectId, postId: post.id } });
    for (const v of variants) {
      const idempotencyKey = idempotencyKeyOf({ postId: post.id, variantId: v.id, accountId: v.accountId, packageHash: hash });
      if (await tx.socialPublication.findUnique({ where: { idempotencyKey } })) continue;
      const publication = await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          variantId: v.id,
          accountId: v.accountId,
          idempotencyKey,
          ...(originSlotAt ? { providerState: { originSlotAt } } : {}),
        },
      });
      await enqueue(tx, scope, DELIVER, publication.id, `social-deliver:${publication.id}:1`);
    }
    await tx.socialPost.update({ where: { id: post.id }, data: { status: "publishing", version: { increment: 1 } } });
    await audit(tx, scope, "social.post.dispatched", post.id, { publications: variants.length });
    return { status: "succeeded", errorCode: null };
  });
}

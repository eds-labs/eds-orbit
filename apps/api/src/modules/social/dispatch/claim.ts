import { randomUUID } from "node:crypto";
import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { publishEvent } from "../../../platform/events/events.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { audit, DomainError, exception } from "../../../shared.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { markReconnectRequired } from "../accounts/vault.ts";
import { markWriteVerified } from "../accounts/verify-write.ts";
import type { SendResult } from "../adapters/registry.ts";
import { publicMediaEnabled } from "../media/public-url.ts";
import { packageOf } from "../posts/posts.ts";
import { platformEnabled, sendMode, type SendMode } from "./gates.ts";
import { DELIVER, RECONCILE } from "./queues.ts";
import { refreshPostStatus } from "./status.ts";
import { takeThrottle } from "./throttle.ts";

// Claiming and finishing one publication (ADR 0020 §7). The claim runs in
// a transaction with the publication locked: it checks again everything
// the approval assumed, counts the throttle and hands out a new fence. The
// result is written only with that fence, so a late or duplicate worker
// can never overwrite it. Automatic retries happen only when the provider
// says nothing was posted; an unclear send becomes outcome_unknown.

const MAX_ATTEMPTS = 3;
const MIN_RETRY_MS = 60_000;
const RECONCILE_FIRST_MS = 15_000;
const UNKNOWN_READ_BACK_MS = 2 * 60_000;

export type ClaimResult =
  | { kind: "claimed"; fence: string; mode: SendMode }
  | { kind: "skip"; reason: string }
  | { kind: "blocked"; code: string }
  | { kind: "later"; at: Date };

export const lockPublication = async (tx: DbTx, scope: Scope, id: string) => {
  await tx.$queryRaw`SELECT id FROM "SocialPublication" WHERE id = ${id}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  const row = await tx.socialPublication.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
};

export async function postOfPublication(tx: DbTx, scope: Scope, variantId: string) {
  const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { id: variantId, projectId: scope.projectId } });
  return tx.socialPost.findFirstOrThrow({ where: { id: variant.postId, projectId: scope.projectId } });
}

/** Stops a publication with a reason (a person or a later change resolves it). */
export async function blockPublication(tx: DbTx, scope: Scope, id: string, code: string) {
  const row = await tx.socialPublication.update({
    where: { id },
    data: { status: "blocked", blockedCode: code, fence: null, version: { increment: 1 } },
  });
  await audit(tx, scope, "social.publication.blocked", id, { code });
  await refreshPostStatus(tx, scope, (await postOfPublication(tx, scope, row.variantId)).id);
}

export async function claimPublication(tx: DbTx, scope: Scope, id: string, now: Date): Promise<ClaimResult> {
  const pub = await lockPublication(tx, scope, id);
  if (pub.status === "cancel_requested") {
    await tx.socialPublication.update({ where: { id }, data: { status: "canceled", fence: null, version: { increment: 1 } } });
    await refreshPostStatus(tx, scope, (await postOfPublication(tx, scope, pub.variantId)).id);
    return { kind: "skip", reason: "canceled" };
  }
  const due =
    pub.status === "pending" ||
    (pub.status === "failed" && pub.retryDisposition === "after-delay" && pub.nextAttemptAt !== null && pub.nextAttemptAt <= now);
  if (!due) return { kind: "skip", reason: pub.status };
  const post = await postOfPublication(tx, scope, pub.variantId);
  if (post.status !== "publishing") return { kind: "skip", reason: `post_${post.status}` };
  const account = await tx.socialAccount.findFirstOrThrow({ where: { id: pub.accountId, projectId: scope.projectId } });
  const platform = account.platform as SocialPlatform;
  const mode = sendMode();
  const blocked = async (code: string): Promise<ClaimResult> => {
    await blockPublication(tx, scope, id, code);
    return { kind: "blocked", code };
  };
  if (account.status !== "active") return blocked("ACCOUNT_RECONNECT_REQUIRED");
  if (mode === "live") {
    if (!platformEnabled(platform)) return blocked("SOCIAL_PLATFORM_NOT_AVAILABLE");
    // A write verification is the post that earns write_verified (S5).
    if (account.capability !== "write_verified" && post.originType !== "write_verification")
      return blocked("SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED");
    if (platform === "instagram" && !publicMediaEnabled()) return blocked("SOCIAL_MEDIA_PUBLIC_REQUIRED");
  }
  if ((await packageOf(tx, scope, post.id)).hash !== post.packageHash) return blocked("SOCIAL_APPROVAL_STALE");
  if (mode === "live") {
    const throttle = await takeThrottle(tx, scope, { id: account.id, platform }, now);
    if (!throttle.ok) return { kind: "later", at: throttle.until };
  }
  const fence = randomUUID();
  await tx.socialPublication.update({
    where: { id },
    data: { status: "claimed", fence, attempts: { increment: 1 }, claimedAt: now, version: { increment: 1 } },
  });
  return { kind: "claimed", fence, mode };
}

/** Marks a claimed publication as being sent; false when it was canceled meanwhile. */
export async function markSending(tx: DbTx, scope: Scope, id: string, fence: string): Promise<boolean> {
  const pub = await lockPublication(tx, scope, id);
  if (pub.fence !== fence) throw new DomainError("SOCIAL_STALE_FENCE", 409);
  if (pub.status === "cancel_requested") {
    await tx.socialPublication.update({ where: { id }, data: { status: "canceled", fence: null, version: { increment: 1 } } });
    await refreshPostStatus(tx, scope, (await postOfPublication(tx, scope, pub.variantId)).id);
    return false;
  }
  await tx.socialPublication.update({ where: { id }, data: { status: "sending", version: { increment: 1 } } });
  return true;
}

const event = (tx: DbTx, scope: Scope, type: string, id: string, postId: string, platform: string) =>
  publishEvent(tx, scope, {
    type,
    subject: { type: "social.publication", id },
    actor: { kind: "system", id: null },
    origin: "social",
    data: { postId, platform },
  });

/** Records an unknown outcome: never sent again automatically. */
export async function markOutcomeUnknown(tx: DbTx, scope: Scope, id: string, code: string) {
  const row = await tx.socialPublication.update({
    where: { id },
    data: { status: "outcome_unknown", lastErrorCode: code, fence: null, version: { increment: 1 } },
  });
  const post = await postOfPublication(tx, scope, row.variantId);
  const account = await tx.socialAccount.findFirstOrThrow({ where: { id: row.accountId, projectId: scope.projectId } });
  await exception(tx, scope, "SOCIAL_OUTCOME_UNKNOWN", id);
  await refreshPostStatus(tx, scope, post.id);
  await event(tx, scope, "social.publication.outcome_unknown", id, post.id, account.platform);
  return { row, post, account };
}

/** Writes a send's result with the claim's fence (S5 outcome mapping). */
export async function finishPublication(
  tx: DbTx,
  scope: Scope,
  id: string,
  fence: string,
  result: SendResult,
  mode: SendMode,
): Promise<void> {
  const pub = await lockPublication(tx, scope, id);
  if (pub.fence !== fence) throw new DomainError("SOCIAL_STALE_FENCE", 409);
  const post = await postOfPublication(tx, scope, pub.variantId);
  const account = await tx.socialAccount.findFirstOrThrow({ where: { id: pub.accountId, projectId: scope.projectId } });
  const now = new Date();
  const state = (extra: Record<string, unknown> | undefined) =>
    ({ ...(pub.providerState as Record<string, unknown>), ...(extra ?? {}) }) as Prisma.InputJsonValue;
  // Stopped while it was being sent: what went out stays recorded, but a
  // refusal is not retried and a post still processing is not published.
  const stopped = pub.status === "cancel_requested" || (pub.providerState as { cancelRequested?: unknown })?.cancelRequested === true;
  if (stopped && (result.kind === "failed" || result.kind === "processing")) {
    await tx.socialPublication.update({
      where: { id },
      data: {
        status: "canceled",
        lastErrorCode: result.kind === "failed" ? result.code : null,
        nextAttemptAt: null,
        fence: null,
        version: { increment: 1 },
      },
    });
    await audit(tx, scope, "social.publication.canceled", id, { during: "send" });
    await refreshPostStatus(tx, scope, post.id);
    return;
  }
  switch (result.kind) {
    case "published":
      await tx.socialPublication.update({
        where: { id },
        data: {
          status: "published",
          externalPostId: result.externalPostId,
          permalink: result.permalink,
          publishedAt: now,
          providerState: state(result.providerState),
          lastErrorCode: null,
          retryDisposition: null,
          nextAttemptAt: null,
          fence: null,
          version: { increment: 1 },
        },
      });
      // A live verification post that went out: the account may post live.
      if (mode === "live" && post.originType === "write_verification") await markWriteVerified(tx, scope, account.id);
      await refreshPostStatus(tx, scope, post.id);
      await event(tx, scope, "social.publication.published", id, post.id, account.platform);
      return;
    case "processing":
      await tx.socialPublication.update({
        where: { id },
        data: { status: "processing", providerState: state(result.providerState), version: { increment: 1 } },
      });
      await enqueue(tx, scope, RECONCILE, id, `social-reconcile:${id}:1`, new Date(now.getTime() + RECONCILE_FIRST_MS), { attempt: "1" });
      return;
    case "unknown": {
      if (result.providerState)
        await tx.socialPublication.update({ where: { id }, data: { providerState: state(result.providerState) } });
      await markOutcomeUnknown(tx, scope, id, result.code);
      // X and Instagram can be read back; Telegram stays with the owner.
      if (mode === "live" && (account.platform === "x" || account.platform === "instagram"))
        await enqueue(tx, scope, RECONCILE, id, `social-reconcile:${id}:unknown`, new Date(now.getTime() + UNKNOWN_READ_BACK_MS), { attempt: "unknown" });
      return;
    }
    case "failed":
      if (result.retry === "after-reconnect") {
        await markReconnectRequired(tx, scope, account.id, result.code);
        await tx.socialPublication.update({ where: { id }, data: { lastErrorCode: result.code } });
        await blockPublication(tx, scope, id, "ACCOUNT_RECONNECT_REQUIRED");
        return;
      }
      if (result.retry === "after-delay" && pub.attempts < MAX_ATTEMPTS) {
        const next = new Date(now.getTime() + Math.max(result.delayMs ?? 0, MIN_RETRY_MS));
        await tx.socialPublication.update({
          where: { id },
          data: {
            status: "failed",
            retryDisposition: "after-delay",
            nextAttemptAt: next,
            lastErrorCode: result.code,
            fence: null,
            version: { increment: 1 },
          },
        });
        await enqueue(tx, scope, DELIVER, id, `social-deliver:${id}:${pub.attempts + 1}`, next);
        await refreshPostStatus(tx, scope, post.id);
        return;
      }
      await tx.socialPublication.update({
        where: { id },
        data: {
          status: "failed",
          retryDisposition: "never",
          nextAttemptAt: null,
          lastErrorCode: result.code,
          fence: null,
          version: { increment: 1 },
        },
      });
      await refreshPostStatus(tx, scope, post.id);
      await event(tx, scope, "social.publication.failed", id, post.id, account.platform);
      return;
  }
}

import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit } from "../../../shared.ts";
import { refreshPostStatus } from "./status.ts";

// Social never sends a post more than 30 minutes late (decision D-3): a
// scheduled post counts from its time, any other from its approval. After a
// delay of any cause (a worker outage, a throttle wait, a retry) the post
// fails with SOCIAL_SLOT_EXPIRED instead of going out at a surprising time.

export const LATE_WINDOW_MS = 30 * 60_000;

type Timed = { scheduleMode: string; scheduledAt: Date | null; approvedAt: Date | null; createdAt: Date };

/** The last moment a post may still be sent (a send after it is late). */
export function sendDeadline(post: Timed): Date {
  const reference = post.scheduleMode === "at" && post.scheduledAt ? post.scheduledAt : (post.approvedAt ?? post.createdAt);
  return new Date(reference.getTime() + LATE_WINDOW_MS);
}

/** Fails a publication for good because its slot is over; nothing was sent. */
export async function expirePublication(tx: DbTx, scope: Scope, id: string): Promise<void> {
  const row = await tx.socialPublication.update({
    where: { id },
    data: {
      status: "failed",
      retryDisposition: "never",
      nextAttemptAt: null,
      lastErrorCode: "SOCIAL_SLOT_EXPIRED",
      fence: null,
      version: { increment: 1 },
    },
  });
  await audit(tx, scope, "social.publication.expired", id, { code: "SOCIAL_SLOT_EXPIRED" });
  const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { id: row.variantId, projectId: scope.projectId } });
  await refreshPostStatus(tx, scope, variant.postId);
}

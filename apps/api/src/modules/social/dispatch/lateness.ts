import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit } from "../../../shared.ts";
import { refreshPostStatus } from "./status.ts";

// Social never sends a post more than 30 minutes late (decision D-3): a
// scheduled post counts from its time, any other from its approval. An
// origin post (Marketing's hand-off at its slot) counts from the earlier of
// its approval and the origin's slot, which the dispatch copies onto each
// publication (`providerState.originSlotAt`), so a late hand-off does not
// extend the limit. After a delay of any cause (a worker outage, a throttle
// wait, a retry) the post fails with SOCIAL_SLOT_EXPIRED instead of going
// out at a surprising time.

export const LATE_WINDOW_MS = 30 * 60_000;

type Timed = { scheduleMode: string; scheduledAt: Date | null; approvedAt: Date | null; createdAt: Date };

/** The origin's planned time a publication carries, if any. */
export function originSlotOf(publication: { providerState: unknown } | null | undefined): Date | null {
  const raw = (publication?.providerState as { originSlotAt?: unknown } | null | undefined)?.originSlotAt;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The earlier of `at` and the origin slot of `publication`. */
export function notAfterOriginSlot(at: Date, publication: { providerState: unknown } | null | undefined): Date {
  const slot = originSlotOf(publication);
  return slot && slot < at ? slot : at;
}

/** The last moment a post may still be sent (a send after it is late). */
export function sendDeadline(post: Timed, publication?: { providerState: unknown }): Date {
  const reference =
    post.scheduleMode === "at" && post.scheduledAt
      ? post.scheduledAt
      : notAfterOriginSlot(post.approvedAt ?? post.createdAt, publication);
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

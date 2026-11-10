import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";

// A post's status while and after it is sent (ADR 0020 §7): publishing as
// long as any publication can still change, then published, partly
// published, failed or canceled.

const OPEN = new Set(["pending", "claimed", "sending", "accepted", "processing", "blocked", "outcome_unknown", "cancel_requested"]);

type Publication = { status: string; retryDisposition: string | null; nextAttemptAt: Date | null };

export function postStatusOf(publications: Publication[]): string | null {
  if (!publications.length) return null;
  const open = publications.some(
    (p) => OPEN.has(p.status) || (p.status === "failed" && p.retryDisposition === "after-delay" && p.nextAttemptAt !== null),
  );
  if (open) return "publishing";
  const published = publications.filter((p) => p.status === "published").length;
  if (published === publications.length) return "published";
  if (published > 0) return "partially_published";
  return publications.every((p) => p.status === "canceled") ? "canceled" : "failed";
}

/** Sets the post's status from its publications (no change without any). */
export async function refreshPostStatus(tx: DbTx, scope: Scope, postId: string): Promise<void> {
  const variants = await tx.socialPostVariant.findMany({ where: { projectId: scope.projectId, postId }, select: { id: true } });
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
    select: { status: true, retryDisposition: true, nextAttemptAt: true },
  });
  const status = postStatusOf(publications);
  if (!status) return;
  await tx.socialPost.updateMany({
    where: { id: postId, projectId: scope.projectId, NOT: { status } },
    data: { status, version: { increment: 1 } },
  });
}

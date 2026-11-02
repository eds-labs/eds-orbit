import { createHash, randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { publishEvent } from "../../../platform/events/events.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { audit } from "../../../shared.ts";
import { senderFor, type SendResult } from "../adapters/registry.ts";
import { finishPublication, lockPublication, markOutcomeUnknown, postOfPublication } from "./claim.ts";
import { sendInputOf } from "./deliver.ts";
import { RECONCILE } from "./queues.ts";
import { refreshPostStatus } from "./status.ts";

// After the send (ADR 0020 §7): a publication still processing (Instagram)
// is read again with a growing pause until it is published or given up as
// unknown; an unknown X or Instagram send is read back once and confirmed
// when the post is found. Nothing here submits a new post.

export const RECONCILE_MAX = 12;
export const RECONCILE_DELAYS_MS = (attempt: number) => Math.min(15_000 * 2 ** (attempt - 1), 900_000);

type Outcome = { status: string; errorCode: string | null };
type ReadBack = SendResult | { kind: "not_found" };

async function recordRead(tx: DbTx, scope: Scope, id: string, result: ReadBack, attempt: number | "unknown") {
  const pub = await tx.socialPublication.findFirstOrThrow({ where: { id, projectId: scope.projectId } });
  await tx.socialDeliveryAttempt.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      publicationId: id,
      step: "status",
      outcome: result.kind === "failed" ? "rejected" : result.kind === "unknown" ? "unknown" : "ok",
      providerCode: result.kind === "failed" || result.kind === "unknown" ? result.code : null,
      requestHash: createHash("sha256").update(`${pub.idempotencyKey}:status:${attempt}`).digest("hex"),
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
}

export async function reconcilePublication(scope: Scope, id: string, attempt: number | "unknown"): Promise<Outcome> {
  const pub = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.socialPublication.findFirst({ where: { id, projectId: scope.projectId } }),
  );
  if (!pub) return { status: "succeeded", errorCode: "NOT_FOUND" };
  const waiting = attempt === "unknown" ? "outcome_unknown" : "processing";
  if (pub.status !== waiting) return { status: "succeeded", errorCode: null };
  let result: ReadBack;
  try {
    const { input, platform } = await sendInputOf(scope, id);
    const sender = senderFor(platform);
    if (!sender?.reconcile) return { status: "succeeded", errorCode: "SOCIAL_NO_READ_BACK" };
    result = await sender.reconcile(scope, { ...input, since: pub.claimedAt ?? pub.updatedAt });
  } catch {
    // Credentials or media could not be read: nothing was asked, try later.
    result = { kind: "processing", providerState: {} };
  }
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await lockPublication(tx, scope, id);
    if (current.status !== waiting) return;
    await recordRead(tx, scope, id, result, attempt);
    if (attempt === "unknown") {
      if (result.kind !== "published") return;
      await tx.socialPublication.update({
        where: { id },
        data: {
          status: "published",
          externalPostId: result.externalPostId,
          permalink: result.permalink,
          publishedAt: new Date(),
          resolution: "published_confirmed",
          resolvedBy: "system",
          version: { increment: 1 },
        },
      });
      const post = await postOfPublication(tx, scope, current.variantId);
      await audit(tx, scope, "social.publication.resolved", id, { resolution: "published_confirmed", by: "read_back" });
      await refreshPostStatus(tx, scope, post.id);
      const account = await tx.socialAccount.findFirstOrThrow({ where: { id: current.accountId, projectId: scope.projectId } });
      await publishEvent(tx, scope, {
        type: "social.publication.published",
        subject: { type: "social.publication", id },
        actor: { kind: "system", id: null },
        origin: "social",
        data: { postId: post.id, platform: account.platform },
      });
      return;
    }
    if (result.kind === "published" || result.kind === "failed" || result.kind === "unknown") {
      await finishPublication(tx, scope, id, current.fence!, result, "live");
      return;
    }
    if (attempt >= RECONCILE_MAX) {
      await markOutcomeUnknown(tx, scope, id, "SOCIAL_PROCESSING_TIMEOUT");
      return;
    }
    const next = attempt + 1;
    await enqueue(tx, scope, RECONCILE, id, `social-reconcile:${id}:${next}`, new Date(Date.now() + RECONCILE_DELAYS_MS(next)), {
      attempt: String(next),
    });
  });
  return { status: "succeeded", errorCode: null };
}

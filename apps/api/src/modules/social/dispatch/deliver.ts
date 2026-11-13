import { createHash, randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { readFile } from "../../../platform/files/files.ts";
import { aiImageLabelsEnabled, assertAiLabelPublishable } from "../../../platform/provenance/image-provenance.ts";
import { DomainError } from "../../../shared.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { accountCredentials } from "../accounts/vault.ts";
import { senderFor, type SendInput, type SendResult } from "../adapters/registry.ts";
import { publicMediaEnabled, publicMediaUrl } from "../media/public-url.ts";
import { recordedAiOrigin } from "../media/provenance.ts";
import { renditionFor } from "../media/rules.ts";
import { blockPublication, claimPublication, finishPublication, lockPublication, markSending } from "./claim.ts";
import { DELIVER } from "./queues.ts";

// One delivery (ADR 0020 §7): claim (transaction 1), mark it as being sent
// (transaction 2, committed before any provider call), send outside any
// transaction, then write the attempt and the result with the fence
// (transaction 3). Test mode finishes without a provider call.

type Outcome = { status: string; errorCode: string | null };

/** What the sender needs: credentials, the variant's text and the platform's renditions. */
export async function sendInputOf(scope: Scope, id: string): Promise<{ input: SendInput; platform: SocialPlatform }> {
  const rows = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const pub = await tx.socialPublication.findFirstOrThrow({ where: { id, projectId: scope.projectId } });
    const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { id: pub.variantId, projectId: scope.projectId } });
    const account = await tx.socialAccount.findFirstOrThrow({ where: { id: pub.accountId, projectId: scope.projectId } });
    const media = await tx.socialPostMedia.findMany({ where: { projectId: scope.projectId, variantId: variant.id }, orderBy: { position: "asc" } });
    const assets = await tx.socialMediaAsset.findMany({ where: { projectId: scope.projectId, fileId: { in: media.map((m) => m.fileId) } } });
    return { pub, variant, account, media, assets };
  });
  const platform = rows.account.platform as SocialPlatform;
  const credentials = await accountCredentials(scope, rows.account.id);
  const media: SendInput["media"] = [];
  for (const m of rows.media) {
    const asset = rows.assets.find((a) => a.fileId === m.fileId);
    if (!asset) throw new Error("SOCIAL_MEDIA_MISSING");
    const original = renditionFor(asset, platform) === "original";
    const fileId = original ? asset.fileId : asset.jpegFileId;
    const { file, bytes } = await readFile(scope, fileId);
    media.push({
      fileId,
      bytes,
      mime: file.mime === "image/png" ? "image/png" : "image/jpeg",
      width: original ? asset.width : asset.jpegWidth,
      height: original ? asset.height : asset.jpegHeight,
      publicUrl: platform === "instagram" && publicMediaEnabled() ? publicMediaUrl(scope, { publicationId: id, fileId }) : null,
    });
  }
  return {
    platform,
    input: {
      publicationId: id,
      credentials,
      account: {
        externalId: rows.account.externalId,
        handle: rows.account.handle,
        settings: rows.account.settings as { xLongPosts?: boolean },
      },
      body: rows.variant.body,
      options: (rows.variant.platformOptions ?? {}) as Record<string, unknown>,
      media,
      providerState: (rows.pub.providerState ?? {}) as Record<string, unknown>,
    },
  };
}

/** Why nothing could be sent (credentials or media), as a result. */
function notSent(error: unknown): SendResult {
  const code = (error as { code?: string; message?: string })?.code ?? (error as Error)?.message ?? "";
  if (code === "SOCIAL_ACCOUNT_RECONNECT_REQUIRED") return { kind: "failed", code, retry: "after-reconnect" };
  if (code === "SOCIAL_ACCOUNT_DISABLED" || code === "SOCIAL_MEDIA_MISSING" || code === "NOT_FOUND")
    return { kind: "failed", code: code === "NOT_FOUND" ? "SOCIAL_MEDIA_MISSING" : code, retry: "never" };
  return { kind: "failed", code: "SOCIAL_CREDENTIALS_UNAVAILABLE", retry: "after-delay" };
}

const attemptOutcome = (result: SendResult, sent: boolean) =>
  !sent ? "not_sent" : result.kind === "unknown" ? "unknown" : result.kind === "failed" ? "rejected" : "ok";

async function recordAttempt(tx: DbTx, scope: Scope, id: string, result: SendResult, sent: boolean, startedAt: Date) {
  const pub = await tx.socialPublication.findFirstOrThrow({ where: { id, projectId: scope.projectId } });
  await tx.socialDeliveryAttempt.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      publicationId: id,
      step: "publish",
      outcome: attemptOutcome(result, sent),
      providerCode: result.kind === "failed" || result.kind === "unknown" ? result.code : null,
      retryAfterMs: result.kind === "failed" && result.delayMs !== undefined ? result.delayMs : null,
      requestHash: createHash("sha256").update(`${pub.idempotencyKey}:${pub.attempts}`).digest("hex"),
      startedAt,
      finishedAt: new Date(),
    },
  });
}

const AI_LABEL_REFUSALS = new Set(["AI_LABEL_MISSING", "AI_LABEL_INVALID"]);

/**
 * The AI label gate (ADR 0028 §4) on the exact bytes about to leave, right
 * before the provider call (so also before Instagram fetches its public
 * URL). A refusal blocks the publication with AI_LABEL_MISSING or
 * AI_LABEL_INVALID in the same transaction as the gate's audit record and
 * one `not_sent` attempt; nothing is sent and nothing retries it. A
 * publication stopped meanwhile is canceled instead. Null when every image
 * may go out (or the flag is off).
 */
async function aiLabelBlock(
  scope: Scope,
  id: string,
  fence: string,
  platform: SocialPlatform,
  media: SendInput["media"],
  startedAt: Date,
): Promise<string | null> {
  if (!aiImageLabelsEnabled() || !media.length) return null;
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    for (const m of media) {
      const bytes = Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength);
      try {
        await assertAiLabelPublishable(tx, scope, {
          bytes,
          declaredOrigin: await recordedAiOrigin(tx, scope, m.fileId, bytes),
          context: `social.deliver.${platform}`,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || !AI_LABEL_REFUSALS.has(error.code)) throw error;
        const pub = await lockPublication(tx, scope, id);
        if (pub.fence !== fence) throw new DomainError("SOCIAL_STALE_FENCE", 409);
        const refused: SendResult = { kind: "failed", code: error.code, retry: "never" };
        await recordAttempt(tx, scope, id, refused, false, startedAt);
        const stopped =
          pub.status === "cancel_requested" || (pub.providerState as { cancelRequested?: unknown })?.cancelRequested === true;
        if (stopped) await finishPublication(tx, scope, id, fence, refused, "live");
        else await blockPublication(tx, scope, id, error.code);
        return error.code;
      }
    }
    return null;
  });
}

export async function deliverPublication(scope: Scope, id: string): Promise<Outcome> {
  const claim = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const result = await claimPublication(tx, scope, id, new Date());
    if (result.kind === "later")
      await enqueue(tx, scope, DELIVER, id, `social-deliver:${id}:t${result.at.getTime()}`, result.at);
    return result;
  });
  if (claim.kind === "skip") return { status: "succeeded", errorCode: null };
  if (claim.kind === "blocked") return { status: "succeeded", errorCode: claim.code };
  if (claim.kind === "expired") return { status: "succeeded", errorCode: "SOCIAL_SLOT_EXPIRED" };
  if (claim.kind === "later") return { status: "succeeded", errorCode: "SOCIAL_THROTTLED" };
  if (claim.mode === "test") {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      finishPublication(
        tx,
        scope,
        id,
        claim.fence,
        { kind: "published", externalPostId: `test:${randomUUID()}`, permalink: null, providerState: { test: true } },
        "test",
      ),
    );
    return { status: "succeeded", errorCode: null };
  }
  const sending = await scoped(scope.workspaceId, scope.projectId, (tx) => markSending(tx, scope, id, claim.fence));
  if (!sending) return { status: "succeeded", errorCode: "SOCIAL_CANCELED" };
  const startedAt = new Date();
  let result: SendResult;
  let sent = false;
  try {
    const { input, platform } = await sendInputOf(scope, id);
    const labelBlocked = await aiLabelBlock(scope, id, claim.fence, platform, input.media, startedAt);
    if (labelBlocked) return { status: "succeeded", errorCode: labelBlocked };
    const sender = senderFor(platform);
    if (!sender) result = { kind: "failed", code: "SOCIAL_PLATFORM_NOT_AVAILABLE", retry: "never" };
    else {
      sent = true;
      result = await sender.send(scope, input);
    }
  } catch (error) {
    // A sender never throws; anything here happened before the send.
    result = sent ? { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" } : notSent(error);
  }
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await recordAttempt(tx, scope, id, result, sent, startedAt);
    await finishPublication(tx, scope, id, claim.fence, result, "live");
  });
  return { status: "succeeded", errorCode: result.kind === "published" ? null : result.kind === "failed" || result.kind === "unknown" ? result.code : null };
}

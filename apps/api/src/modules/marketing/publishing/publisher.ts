import { exportAssetContent } from "../pipeline/content-export.ts";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  createPostizClient,
  ConnectorError,
  postizProviderSettings,
} from "../../../../../../packages/connectors/src/index.ts";
import {
  data,
  list,
  entity,
  update,
  DomainError,
  exception,
} from "../../../shared.ts";
import { preflight } from "../policy/policy.ts";
import { isAssignedPostizChannel } from "./postiz-assignment.ts";
import { finalPostText } from "./channel-rules.ts";
import { notify, reportBlockedPost } from "../agents/notifications.ts";
import {
  claimPublication,
  finishPublication,
  enqueue,
} from "../pipeline/workflow.ts";
import { connectionAccess } from "../../../platform/connections/connections.ts";
import { creativeStudioEnabled } from "../creative/flag.ts";
import { publishingBackend } from "./backend.ts";
import {
  accountForChannel,
  cancelOriginPost,
  importOriginMedia,
  originPostStatus,
  submitOriginPost,
} from "../../social/contract.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
export async function dispatchPublication(scope: Scope, pubId: string) {
  // A project on Social (S9) hands the post to Social instead of Postiz; a
  // post already handed to Social stays with Social whatever the setting.
  const route = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const pub = await entity(tx, scope, "publications", pubId);
    if (data(pub).publishingBackend === "social") return "social";
    return publishingBackend(tx, scope);
  });
  if (route === "social") return dispatchThroughSocial(scope, pubId);
  const credentials = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const pub = await entity(tx, scope, "publications", pubId);
      if (data(pub).test) return null;
      const connector = (await list(tx, scope, "connectors")).find(
        (c) =>
          data(c).provider === "postiz" && data(c).status === "write_verified",
      );
      if (!connector) throw new DomainError("PUBLISHER_NOT_VERIFIED");
      const c = data(connector),
        integration = (c.channels ?? []).find(
          (i: any) => i.id === data(pub).channel && !i.disabled,
        );
      if (
        !integration ||
        !isAssignedPostizChannel(c, integration.id) ||
        !(c.writeVerifiedIntegrationIds ?? []).includes(integration.id) ||
        c.writeVerifiedInstanceId !== process.env.PUBLISHER_INSTANCE_ID
      )
        throw new DomainError("CHANNEL_NOT_VERIFIED");
      const access = await connectionAccess(tx, scope, c);
      return {
        baseUrl: access.baseUrl ?? c.baseUrl,
        token: access.credential,
        integration,
        connectorId: connector.id,
        connectorVersion: connector.version,
      };
    },
  );
  // Claim is the final database preflight immediately before the bounded HTTP handoff.
  const packet = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      if (credentials) {
        const c = await entity(
          tx,
          scope,
          "connectors",
          credentials.connectorId,
        );
        if (c.version !== credentials.connectorVersion)
          throw new DomainError("CONNECTOR_CHANGED");
      }
      return claimPublication(tx, scope, pubId);
    },
  );
  if (!packet.send) return packet.pub;
  const p = data(packet.pub),
    content = data(packet.content!);
  if (p.test)
    return scoped(scope.workspaceId, scope.projectId, (tx) =>
      finishPublication(tx, scope, pubId, p.fence, {
        status: "published_test",
        remoteId: "test-" + pubId,
      }),
    );
  if (!credentials) throw new DomainError("PUBLISHER_NOT_VERIFIED");
  const client = createPostizClient(credentials);
  try {
    const images: { id: string; path: string }[] = [];
    if (content.assetId) {
      const asset = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        entity(tx, scope, "assets", content.assetId),
      );
      // Approved PNGs may live inline or in Drive (checksum-bound read).
      const file = await exportAssetContent(scope, data(asset));
      if (!file) throw new ConnectorError("ASSET_NOT_SUPPORTED");
      const media = await client.uploadMedia({
        bytes: file.bytes,
        mime: "image/png",
        filename: "creative.png",
      });
      images.push(media);
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const pub = await entity(tx, scope, "publications", pubId);
        await update(tx, scope, pub, { ...data(pub), uploadedMedia: images });
      });
    }
    const canSend = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        const pub = await entity(tx, scope, "publications", pubId);
        const v = data(pub);
        const checked = await preflight(tx, scope, p.contentId, {
          test: false,
          ignoreApproval: true,
          approvalPublicationId: pubId,
          // An assignment post keeps its veto window up to the send (R53).
          ...(v.vetoDeadline && v.assignmentRunId
            ? {
                veto: {
                  deadline: v.vetoDeadline,
                  vetoedAt: v.vetoedAt ?? null,
                  assignmentRunId: v.assignmentRunId,
                  handoff: true,
                },
              }
            : {}),
        });
        if (
          data(pub).status !== "sending" ||
          data(pub).fence !== p.fence ||
          checked.packageHash !== p.packageHash ||
          !checked.allowed
        ) {
          await update(tx, scope, pub, {
            ...data(pub),
            status: "blocked_dependency",
            reason: "HANDOFF_DEPENDENCY_CHANGED",
          });
          await reportBlockedPost(
            tx,
            scope,
            pubId,
            v,
            checked.blockers.length
              ? checked.blockers
              : ["HANDOFF_DEPENDENCY_CHANGED"],
          );
          return false;
        }
        return true;
      },
    );
    if (!canSend) return { status: "blocked_dependency" };
    const publishedText = finalPostText(content.body, content.targetUrl);
    const result = await client.createPost({
      type: "now",
      date: new Date().toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: credentials.integration.id },
          value: [{ content: publishedText, image: images }],
          // The Instagram post type comes with the Creative Studio (R64).
          settings: postizProviderSettings(credentials.integration.identifier, {
            instagramFeedPost: creativeStudioEnabled(),
          }),
        },
      ],
    });
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const current = await entity(tx, scope, "publications", pubId);
      if (data(current).fence !== p.fence) throw new DomainError("STALE_FENCE");
      const row = await update(tx, scope, current, {
        ...data(current),
        remoteId: result.remotePosts[0]!.postId,
        connectorId: credentials.connectorId,
        remoteState: "accepted",
        status:
          data(current).status === "sending"
            ? "scheduled_remote"
            : "reconciliation_required",
        handoffCompletedAt: new Date().toISOString(),
      });
      await enqueue(
        tx,
        scope,
        "reconciliation",
        pubId,
        "reconcile:" + pubId,
        new Date(Date.now() + 15000),
      );
      return row;
    });
  } catch (error) {
    const outcome = error instanceof ConnectorError ? error.outcome : "unknown";
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const done = await finishPublication(tx, scope, pubId, p.fence, {
        status:
          outcome === "not_sent" || outcome === "rejected"
            ? "failed"
            : "outcome_unknown",
      });
      // Tell the owner's bot in the same transaction (Orbit Agents).
      if (["failed", "outcome_unknown"].includes(data(done).status))
        await notify(tx, scope, "postiz_error", pubId);
      return done;
    });
  }
}
/**
 * The handoff to Social (S9): the same claim and final preflight as for
 * Postiz, then, in one transaction, an origin-authorized Social post that
 * Social sends at once and the publication's record of it. Nothing reaches
 * a platform before that transaction commits, so a failure here is a plain
 * failure, never an unknown outcome.
 */
async function dispatchThroughSocial(scope: Scope, pubId: string) {
  const packet = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const pub = await entity(tx, scope, "publications", pubId);
    // Already handed over: a redelivered job changes nothing (Social has it).
    if (data(pub).publishingBackend === "social" && data(pub).remoteId)
      return { send: false as const, pub };
    return claimPublication(tx, scope, pubId);
  });
  if (!packet.send) return packet.pub;
  const p = data(packet.pub),
    content = data(packet.content!);
  if (p.test)
    return scoped(scope.workspaceId, scope.projectId, (tx) =>
      finishPublication(tx, scope, pubId, p.fence, {
        status: "published_test",
        remoteId: "test-" + pubId,
      }),
    );
  try {
    const mediaIds: string[] = [];
    if (content.assetId) {
      const asset = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        entity(tx, scope, "assets", content.assetId),
      );
      const file = await exportAssetContent(scope, data(asset));
      if (!file) throw new DomainError("ASSET_NOT_SUPPORTED");
      mediaIds.push(
        await importOriginMedia(scope, { bytes: file.bytes, mime: "image/png" }),
      );
    }
    return await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const pub = await entity(tx, scope, "publications", pubId);
      const v = data(pub);
      const checked = await preflight(tx, scope, p.contentId, {
        test: false,
        ignoreApproval: true,
        approvalPublicationId: pubId,
        ...(v.vetoDeadline && v.assignmentRunId
          ? {
              veto: {
                deadline: v.vetoDeadline,
                vetoedAt: v.vetoedAt ?? null,
                assignmentRunId: v.assignmentRunId,
                handoff: true,
              },
            }
          : {}),
      });
      if (
        v.status !== "sending" ||
        v.fence !== p.fence ||
        checked.packageHash !== p.packageHash ||
        !checked.allowed
      ) {
        const blockers = checked.blockers.length
          ? checked.blockers
          : ["HANDOFF_DEPENDENCY_CHANGED"];
        await update(tx, scope, pub, {
          ...v,
          status: "blocked_dependency",
          reason: "HANDOFF_DEPENDENCY_CHANGED",
        });
        await reportBlockedPost(tx, scope, pubId, v, blockers);
        return entity(tx, scope, "publications", pubId);
      }
      const account = await accountForChannel(tx, scope, v.channel);
      if (!account) throw new DomainError("SOCIAL_CHANNEL_NOT_MAPPED", 409);
      const { postId } = await submitOriginPost(tx, scope, {
        origin: { module: "marketing", type: "publication", id: pubId, version: 1 },
        accountId: account.accountId,
        text: finalPostText(content.body, content.targetUrl),
        mediaIds,
        mode: "now",
        packageHash: p.packageHash,
      });
      const row = await update(tx, scope, pub, {
        ...v,
        publishingBackend: "social",
        remoteId: postId,
        connectorId: null,
        remoteState: "accepted",
        status: "scheduled_remote",
        handoffCompletedAt: new Date().toISOString(),
      });
      await enqueue(
        tx,
        scope,
        "reconciliation",
        pubId,
        "reconcile:" + pubId,
        new Date(Date.now() + 15000),
      );
      return row;
    });
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "SOCIAL_HANDOFF_FAILED";
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const done = await finishPublication(tx, scope, pubId, p.fence, {
        status: "failed",
      });
      await update(tx, scope, done, { ...data(done), publishingBackend: "social", reason: code });
      if (data(done).status === "failed") await notify(tx, scope, "postiz_error", pubId);
      return entity(tx, scope, "publications", pubId);
    });
  }
}

/**
 * Takes a handed-over post back in Social when Marketing no longer wants it
 * (pause, calendar block, invalidated source, a stop): true when Social had
 * not sent it and the publication is now canceled.
 */
export async function withdrawSocialHandoff(
  tx: DbTx,
  scope: Scope,
  row: Awaited<ReturnType<typeof entity>>,
  reason: string,
): Promise<boolean> {
  const p = data(row);
  if (p.publishingBackend !== "social" || typeof p.remoteId !== "string") return false;
  if ((await cancelOriginPost(tx, scope, p.remoteId, reason)) !== "canceled") return false;
  await update(tx, scope, row, { ...p, status: "canceled", reason, canceledAt: new Date().toISOString() });
  return true;
}

// Polls: quickly at first, then every 15 minutes for two days, so a
// delivery Social holds for a person (reconnect, pause) is still recorded.
const FAST_POLLS = 8;
const MAX_POLLS = 200;

/** Reads a handed-over post's state from Social (S9), like the Postiz poll. */
async function reconcileThroughSocial(scope: Scope, pubId: string) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const pub = await entity(tx, scope, "publications", pubId);
    const p = data(pub);
    const open = ["scheduled_remote", "outcome_unknown"];
    const unwanted = ["cancellation_required", "reconciliation_required"];
    if (p.test || ![...open, ...unwanted].includes(p.status)) return { unchanged: true };
    // Marketing no longer wants it: take it back if Social has not sent it.
    if (unwanted.includes(p.status) && (await withdrawSocialHandoff(tx, scope, pub, p.reason ?? p.status)))
      return entity(tx, scope, "publications", pubId);
    const [found] = await originPostStatus(tx, scope, [String(p.remoteId)]);
    const observed = !found ? "outcome_unknown" : found.status;
    let status =
      observed === "published"
        ? "published"
        : observed === "failed"
          ? "failed"
          : observed === "canceled" || observed === "withdrawn"
            ? "canceled"
            : observed === "outcome_unknown"
              ? "outcome_unknown"
              : "scheduled_remote";
    // A stop that came too late keeps its state until Social's outcome is known.
    if (unwanted.includes(p.status) && status === "scheduled_remote") status = p.status;
    if (unwanted.includes(p.status) && status === "published")
      await exception(tx, scope, "REMOTE_CANCELLATION_REQUIRED", pubId);
    if (status === "outcome_unknown" && p.status !== "outcome_unknown")
      await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pubId);
    // A delivery Social holds for a person: the owner sees it once.
    if (observed === "blocked" && p.remoteState !== "blocked")
      await exception(tx, scope, "SOCIAL_DELIVERY_BLOCKED", pubId);
    if (["failed", "outcome_unknown"].includes(status) && status !== p.status)
      await notify(tx, scope, "postiz_error", pubId);
    const attempts = (p.reconcileAttempts ?? 0) + 1;
    const waiting = [...open, ...unwanted].includes(status) && Boolean(found);
    if (waiting && attempts < MAX_POLLS)
      await enqueue(
        tx,
        scope,
        "reconciliation",
        pubId,
        `reconcile:${pubId}:${attempts}`,
        new Date(Date.now() + (attempts < FAST_POLLS ? Math.min(900000, 15000 * 2 ** attempts) : 900000)),
      );
    if (waiting && attempts === FAST_POLLS)
      await exception(tx, scope, "RECONCILIATION_POLL_LIMIT", pubId);
    const reason =
      observed === "withdrawn"
        ? "SOCIAL_POST_WITHDRAWN"
        : (found?.errorCode ?? undefined);
    return update(tx, scope, pub, {
      ...p,
      reconcileAttempts: attempts,
      status,
      remoteState: observed,
      reconciledAt: new Date().toISOString(),
      ...(found?.permalink ? { releaseUrl: found.permalink } : {}),
      ...(reason ? { reason } : {}),
    });
  });
}

export async function reconcilePublication(scope: Scope, pubId: string) {
  if (
    (await scoped(scope.workspaceId, scope.projectId, async (tx) =>
      data(await entity(tx, scope, "publications", pubId)),
    )).publishingBackend === "social"
  )
    return reconcileThroughSocial(scope, pubId);
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const pub = await entity(tx, scope, "publications", pubId),
        p = data(pub);
      if (
        p.test ||
        (p.status === "published" && p.reconciliationStatus !== "required")
      )
        return null;
      if (!p.remoteId || !p.connectorId)
        throw new DomainError("REMOTE_ID_UNKNOWN");
      const connector = await entity(tx, scope, "connectors", p.connectorId);
      const access = await connectionAccess(tx, scope, data(connector));
      return { pub, connector, access };
    },
  );
  if (!prepared) return { unchanged: true };
  const p = data(prepared.pub),
    c = data(prepared.connector);
  const client = createPostizClient({
    baseUrl: prepared.access.baseUrl ?? c.baseUrl,
    token: prepared.access.credential,
  });
  const result = await client.findPostStatus(p.remoteId, {
    startDate: new Date(
      new Date(p.scheduledAt).valueOf() - 86400000,
    ).toISOString(),
    endDate: new Date(
      new Date(p.scheduledAt).valueOf() + 86400000,
    ).toISOString(),
  });
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const pub = await entity(tx, scope, "publications", pubId);
    const state = result.found ? result.post.state : "UNKNOWN";
    if (data(pub).status === "published") {
      return update(tx, scope, pub, {
        ...data(pub),
        remoteObservation: state,
        reconciliationStatus: "observed_requires_owner_review",
        reconciledAt: new Date().toISOString(),
      });
    }
    const remoteStatus =
      state === "PUBLISHED"
        ? "published"
        : state === "ERROR"
          ? "failed"
          : result.found
            ? "scheduled_remote"
            : "outcome_unknown";
    const status =
      ["cancellation_required", "reconciliation_required"].includes(
        data(pub).status,
      ) && remoteStatus === "scheduled_remote"
        ? data(pub).status
        : remoteStatus;
    if (["cancellation_required", "reconciliation_required"].includes(status))
      await exception(tx, scope, "REMOTE_CANCELLATION_REQUIRED", pubId);
    if (status === "outcome_unknown")
      await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pubId);
    // Postiz reports an error, or the post cannot be found: the owner's bot hears of it.
    if (["failed", "outcome_unknown"].includes(status))
      await notify(tx, scope, "postiz_error", pubId);
    const attempts = (data(pub).reconcileAttempts ?? 0) + 1;
    if (status === "scheduled_remote" && attempts < 8)
      await enqueue(
        tx,
        scope,
        "reconciliation",
        pubId,
        `reconcile:${pubId}:${attempts}`,
        new Date(Date.now() + Math.min(900000, 15000 * 2 ** attempts)),
      );
    if (status === "scheduled_remote" && attempts >= 8)
      await exception(tx, scope, "RECONCILIATION_POLL_LIMIT", pubId);
    return update(tx, scope, pub, {
      ...data(pub),
      reconcileAttempts: attempts,
      status,
      remoteState: state,
      reconciledAt: new Date().toISOString(),
      ...(result.found ? { releaseUrl: result.post.releaseURL ?? null } : {}),
    });
  });
}

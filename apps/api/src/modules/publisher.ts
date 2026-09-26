import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  createPostizClient,
  ConnectorError,
} from "../../../../packages/connectors/src/index.ts";
import {
  data,
  list,
  entity,
  decrypt,
  update,
  DomainError,
  exception,
} from "../shared.ts";
import { preflight } from "./policy.ts";
import { isAssignedPostizChannel } from "./postiz-assignment.ts";
import { finalPostText } from "./channel-rules.ts";
import { claimPublication, finishPublication, enqueue } from "./workflow.ts";
export async function dispatchPublication(scope: Scope, pubId: string) {
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
      return {
        baseUrl: c.baseUrl,
        token: decrypt(c.encryptedCredential, process.env.CREDENTIAL_KEY!),
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
      const a = data(asset);
      if (a.mime !== "image/png" || !a.usageApproved || !a.base64)
        throw new ConnectorError("ASSET_NOT_SUPPORTED");
      const media = await client.uploadMedia({
        bytes: Buffer.from(a.base64, "base64"),
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
        const checked = await preflight(tx, scope, p.contentId, {
          test: false,
          ignoreApproval: true,
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
          settings: { __type: credentials.integration.identifier },
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
    return scoped(scope.workspaceId, scope.projectId, (tx) =>
      finishPublication(tx, scope, pubId, p.fence, {
        status:
          outcome === "not_sent" || outcome === "rejected"
            ? "failed"
            : "outcome_unknown",
      }),
    );
  }
}
export async function reconcilePublication(scope: Scope, pubId: string) {
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
      return { pub, connector };
    },
  );
  if (!prepared) return { unchanged: true };
  const p = data(prepared.pub),
    c = data(prepared.connector);
  const client = createPostizClient({
    baseUrl: c.baseUrl,
    token: decrypt(c.encryptedCredential, process.env.CREDENTIAL_KEY!),
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

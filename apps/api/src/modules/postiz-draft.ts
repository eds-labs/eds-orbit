import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  createPostizClient,
} from "../../../../packages/connectors/src/index.ts";
import {
  audit,
  create,
  data,
  decrypt,
  DomainError,
  entity,
  exception,
  hash,
  list,
  update,
} from "../shared.ts";
import { activePolicy, checkClaims } from "./policy.ts";
import { isAssignedPostizChannel } from "./postiz-assignment.ts";
import { finalPostText } from "./channel-rules.ts";
import { exportAssetContent } from "./content-export.ts";

/**
 * Owner-confirmed handoff of one reviewed Content version to Postiz as a
 * draft. It never schedules or publishes: the payload type is fixed to
 * "draft". Postiz has no idempotency, so every handoff is recorded as
 * "sending" before the HTTP call and an unclear result becomes
 * "outcome_unknown" without an automatic retry.
 */
export const postizDraftInput = z
  .object({
    contentId: z.uuid(),
    version: z.number().int().positive(),
    confirmDraftOnly: z.literal(true),
  })
  .strict();

type DraftPayload = {
  integrationId: string;
  identifier: string;
  text: string;
  images: { id: string; path: string }[];
  date: string;
};

export function postizDraftPayload(p: DraftPayload) {
  return {
    type: "draft" as const,
    date: p.date,
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: p.integrationId },
        value: [{ content: p.text, image: p.images }],
        settings: { __type: p.identifier },
      },
    ],
  };
}

export function postizDraftsEnabled() {
  return process.env.ENABLE_POSTIZ_DRAFTS === "true";
}

async function prepare(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  version: number,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  if (!postizDraftsEnabled())
    throw new DomainError("POSTIZ_DRAFTS_DISABLED", 409);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${contentId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const content = await entity(tx, scope, "content", contentId);
  const c = data(content);
  if (content.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (c.synthetic || !c.missionId || c.type !== "social")
    throw new DomainError("CAMPAIGN_SOCIAL_CONTENT_REQUIRED", 409);
  if (
    c.status !== "reviewed" ||
    !(await checkClaims(tx, scope, contentId)).valid
  )
    throw new DomainError("CONTENT_REVIEW_REQUIRED", 409);
  const previous = (await list(tx, scope, "postiz_drafts")).filter(
    (row) => data(row).contentId === contentId,
  );
  const open = previous.find((row) =>
    ["sending", "outcome_unknown"].includes(data(row).status),
  );
  if (open) throw new DomainError("POSTIZ_DRAFT_OUTCOME_UNKNOWN", 409);
  const done = previous.find(
    (row) =>
      data(row).status === "accepted" &&
      data(row).contentVersion === content.version,
  );
  if (done) return { done };
  const connector = (await list(tx, scope, "connectors")).find(
    (row) =>
      data(row).provider === "postiz" &&
      ["read_verified", "write_verified"].includes(data(row).status),
  );
  if (!connector) throw new DomainError("POSTIZ_NOT_CONNECTED", 409);
  const k = data(connector);
  const integration = (k.channels ?? []).find(
    (item: any) => item.id === c.channel && !item.disabled,
  );
  if (!integration || !isAssignedPostizChannel(k, integration.id))
    throw new DomainError("POSTIZ_CHANNEL_NOT_ASSIGNED", 409);
  const policy = await activePolicy(tx, scope);
  if (!policy || !data(policy).channels?.includes(integration.id))
    throw new DomainError("POLICY_CHANNEL_REQUIRED", 409);
  const mission = data(await entity(tx, scope, "missions", c.missionId));
  const startAt = Date.parse(mission.startAt);
  const packageData = {
    contentId,
    contentVersion: content.version,
    body: c.body,
    targetUrl: c.targetUrl ?? null,
    assetId: c.assetId ?? null,
    integrationId: integration.id,
  };
  const handoff = await create(tx, scope, "postiz_drafts", {
    ...packageData,
    packageHash: hash(packageData),
    integrationName: integration.name ?? null,
    integrationIdentifier: integration.identifier,
    connectorId: connector.id,
    connectorVersion: connector.version,
    status: "sending",
    requestedBy: scope.userId,
    startedAt: new Date().toISOString(),
  });
  await audit(tx, scope, "postiz_draft.requested", handoff.id, {
    contentId,
    contentVersion: content.version,
    integrationId: integration.id,
  });
  return {
    handoff,
    send: {
      baseUrl: k.baseUrl as string,
      token: decrypt(k.encryptedCredential, process.env.CREDENTIAL_KEY!),
      integrationId: integration.id as string,
      identifier: integration.identifier as string,
      text: finalPostText(c.body, c.targetUrl),
      asset: c.assetId
        ? data(await entity(tx, scope, "assets", c.assetId))
        : null,
      date: new Date(
        Number.isFinite(startAt) && startAt > Date.now() ? startAt : Date.now(),
      ).toISOString(),
    },
  };
}

export async function handoffPostizDraft(
  scope: Scope,
  raw: unknown,
  deps = { createClient: createPostizClient, readAsset: exportAssetContent },
) {
  const input = postizDraftInput.parse(raw);
  const prepared = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    prepare(tx, scope, input.contentId, input.version),
  );
  if ("done" in prepared && prepared.done) return prepared.done;
  const { handoff, send } = prepared;
  let remoteId: string;
  try {
    const client = deps.createClient({
      baseUrl: send.baseUrl,
      token: send.token,
    });
    const images: { id: string; path: string }[] = [];
    const asset = await deps.readAsset(scope, send.asset);
    if (asset)
      images.push(
        await client.uploadMedia({
          bytes: asset.bytes,
          mime: "image/png",
          filename: "creative.png",
        }),
      );
    const result = await client.createPost(
      postizDraftPayload({
        integrationId: send.integrationId,
        identifier: send.identifier,
        text: send.text,
        images,
        date: send.date,
      }),
    );
    remoteId = result.remotePosts[0]!.postId;
  } catch (error) {
    const outcome =
      error instanceof ConnectorError ? error.outcome : ("unknown" as const);
    const code =
      error instanceof ConnectorError || error instanceof DomainError
        ? error.message
        : "POSTIZ_DRAFT_FAILED";
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await entity(tx, scope, "postiz_drafts", handoff.id);
      const known = outcome === "not_sent" || outcome === "rejected";
      if (!known)
        await exception(tx, scope, "POSTIZ_DRAFT_OUTCOME_UNKNOWN", handoff.id);
      return update(tx, scope, row, {
        ...data(row),
        status: known ? "failed" : "outcome_unknown",
        error: code,
        finishedAt: new Date().toISOString(),
      });
    });
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await entity(tx, scope, "postiz_drafts", handoff.id);
    await audit(tx, scope, "postiz_draft.accepted", handoff.id, { remoteId });
    return update(tx, scope, row, {
      ...data(row),
      status: "accepted",
      remoteId,
      remoteType: "draft",
      finishedAt: new Date().toISOString(),
    });
  });
}

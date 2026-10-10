import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  createPostizClient,
  postizProviderSettings,
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
 * "sending" before the HTTP call. A failed media upload cannot have created
 * a post, so it is a clear failure; only an unclear post creation becomes
 * "outcome_unknown", which blocks retries until an owner resolves it after
 * checking Postiz.
 *
 * Assignments with the delivery "Postiz draft" (R73) hand their approved
 * posts over through the same checks, records and HTTP step
 * (`draftTarget`, `recordDraftHandoff`, `sendDraftHandoff`); their booking,
 * slot and worker job live in agents/draft-delivery.ts.
 */
export const postizDraftInput = z
  .object({
    contentId: z.uuid(),
    version: z.number().int().positive(),
    confirmDraftOnly: z.literal(true),
    withoutImage: z.boolean().optional(),
  })
  .strict();

export const postizDraftResolveInput = z
  .object({
    handoffId: z.uuid(),
    resolution: z.enum(["not_created", "exists"]),
    confirmCheckedInPostiz: z.literal(true),
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
        settings: postizProviderSettings(p.identifier),
      },
    ],
  };
}

export function postizDraftsEnabled() {
  return process.env.ENABLE_POSTIZ_DRAFTS === "true";
}

/**
 * Handoffs that block another one of the same content: an assignment
 * delivery booked but not sent yet (`queued`), one in flight (`sending`) and
 * one whose outcome nobody knows (`outcome_unknown`).
 */
const OPEN = ["queued", "sending", "outcome_unknown"];

/** What every handoff of one content version goes to: its Postiz integration and connector. */
export type DraftTarget = {
  content: Awaited<ReturnType<typeof entity>>;
  c: Record<string, any>;
  connector: Awaited<ReturnType<typeof entity>>;
  integration: Record<string, any>;
};

/**
 * The checks every draft handoff shares, the owner's action and an
 * assignment's delivery (R73): the content version is a reviewed campaign
 * social post with a valid claim review, no other handoff of it is open,
 * and its channel is a Postiz integration assigned to the project and
 * allowed by the active policy. `done` is the accepted handoff of exactly
 * this version, if there is one. `except` leaves one handoff out of the
 * open check: the delivery's own booked record. Locks the content row.
 */
export async function draftTarget(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  version: number,
  except: string | null = null,
): Promise<DraftTarget | { done: Awaited<ReturnType<typeof entity>> }> {
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
    (row) => data(row).contentId === contentId && row.id !== except,
  );
  const open = previous.find((row) => OPEN.includes(data(row).status));
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
  return { content, c, connector, integration };
}

/**
 * Records one handoff of the target's content version before anything is
 * sent (Postiz has no idempotency) and audits the request. `fields` carry
 * the status (`sending` for the owner's action, `queued` for a booked
 * assignment delivery) and what the caller adds.
 */
export async function recordDraftHandoff(
  tx: DbTx,
  scope: Scope,
  target: DraftTarget,
  fields: Record<string, unknown> & { status: "sending" | "queued" },
) {
  const { content, c, connector, integration } = target;
  const packageData = {
    contentId: content.id,
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
    requestedBy: scope.userId,
    startedAt: new Date().toISOString(),
    ...fields,
  });
  await audit(tx, scope, "postiz_draft.requested", handoff.id, {
    contentId: content.id,
    contentVersion: content.version,
    integrationId: integration.id,
    ...(typeof fields.assignmentId === "string"
      ? { assignmentId: fields.assignmentId }
      : {}),
  });
  return handoff;
}

/** What the HTTP step of one handoff needs, read inside the transaction. */
export type DraftSend = {
  baseUrl: string;
  token: string;
  integrationId: string;
  identifier: string;
  text: string;
  asset: Record<string, any> | null;
  date: string;
};

export async function draftSend(
  tx: DbTx,
  scope: Scope,
  target: DraftTarget,
  date: string,
): Promise<DraftSend> {
  const k = data(target.connector);
  const c = target.c;
  return {
    baseUrl: k.baseUrl as string,
    token: decrypt(k.encryptedCredential, process.env.CREDENTIAL_KEY!),
    integrationId: target.integration.id as string,
    identifier: target.integration.identifier as string,
    text: finalPostText(c.body, c.targetUrl),
    asset: c.assetId
      ? data(await entity(tx, scope, "assets", c.assetId))
      : null,
    date,
  };
}

export type DraftDeps = {
  createClient: typeof createPostizClient;
  readAsset: typeof exportAssetContent;
};
const defaultDeps: DraftDeps = {
  createClient: createPostizClient,
  readAsset: exportAssetContent,
};

/**
 * The HTTP step of every handoff, outside any transaction, and its recorded
 * outcome. The handoff must be `sending`. A failed media upload cannot have
 * created a post, so it is a clear failure; only an unclear post creation
 * becomes `outcome_unknown`, with an exception. With `imageFallback` a
 * failed image read or upload goes on without the image (still nothing was
 * posted) and records `imageError`. `after` runs in the transaction that
 * records the outcome, with the saved handoff.
 */
export async function sendDraftHandoff(
  scope: Scope,
  handoffId: string,
  send: DraftSend,
  deps: DraftDeps = defaultDeps,
  options: {
    withoutImage?: boolean;
    imageFallback?: boolean;
    after?: (
      tx: DbTx,
      row: Awaited<ReturnType<typeof entity>>,
    ) => Promise<void>;
  } = {},
) {
  let remoteId: string;
  let step: "upload_media" | "create_post" = "upload_media";
  let withoutImage = options.withoutImage === true;
  let imageError: string | null = null;
  try {
    const client = deps.createClient({
      baseUrl: send.baseUrl,
      token: send.token,
    });
    const images: { id: string; path: string }[] = [];
    try {
      const asset = withoutImage
        ? null
        : await deps.readAsset(scope, send.asset);
      if (asset)
        images.push(
          await client.uploadMedia({
            bytes: asset.bytes,
            mime: "image/png",
            filename: "creative.png",
          }),
        );
    } catch (error) {
      if (!options.imageFallback) throw error;
      // No post request was sent yet: the draft goes without its image.
      imageError =
        error instanceof ConnectorError || error instanceof DomainError
          ? error.message
          : "POSTIZ_DRAFT_IMAGE_FAILED";
      withoutImage = true;
      images.length = 0;
    }
    step = "create_post";
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
      const row = await entity(tx, scope, "postiz_drafts", handoffId);
      // No post request was sent before the upload finished.
      const known =
        step === "upload_media" ||
        outcome === "not_sent" ||
        outcome === "rejected";
      if (!known)
        await exception(tx, scope, "POSTIZ_DRAFT_OUTCOME_UNKNOWN", handoffId);
      const saved = await update(tx, scope, row, {
        ...data(row),
        status: known ? "failed" : "outcome_unknown",
        error: code,
        failedStep: step,
        httpStatus:
          error instanceof ConnectorError ? (error.status ?? null) : null,
        providerMessage:
          error instanceof ConnectorError ? (error.detail ?? null) : null,
        withoutImage,
        ...(imageError ? { imageError } : {}),
        finishedAt: new Date().toISOString(),
      });
      await options.after?.(tx, saved);
      return saved;
    });
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await entity(tx, scope, "postiz_drafts", handoffId);
    await audit(tx, scope, "postiz_draft.accepted", handoffId, { remoteId });
    const saved = await update(tx, scope, row, {
      ...data(row),
      status: "accepted",
      remoteId,
      remoteType: "draft",
      remoteDate: send.date,
      withoutImage,
      ...(imageError ? { imageError } : {}),
      finishedAt: new Date().toISOString(),
    });
    await options.after?.(tx, saved);
    return saved;
  });
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
  const target = await draftTarget(tx, scope, contentId, version);
  if ("done" in target) return target;
  const handoff = await recordDraftHandoff(tx, scope, target, {
    status: "sending",
  });
  const mission = data(await entity(tx, scope, "missions", target.c.missionId));
  const startAt = Date.parse(mission.startAt);
  const planned = Date.parse(target.c.scheduledAt ?? "");
  // Prefer the post's own planned slot, then the mission start.
  const date = new Date(
    Number.isFinite(planned) && planned > Date.now()
      ? planned
      : Number.isFinite(startAt) && startAt > Date.now()
        ? startAt
        : Date.now(),
  ).toISOString();
  return { handoff, send: await draftSend(tx, scope, target, date) };
}

export async function handoffPostizDraft(
  scope: Scope,
  raw: unknown,
  deps: DraftDeps = defaultDeps,
) {
  const input = postizDraftInput.parse(raw);
  const prepared = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    prepare(tx, scope, input.contentId, input.version),
  );
  if ("done" in prepared) return prepared.done;
  return sendDraftHandoff(scope, prepared.handoff.id, prepared.send, deps, {
    withoutImage: input.withoutImage === true,
  });
}

/** Owner decision after checking Postiz for a handoff with an unclear outcome. */
export async function resolvePostizDraft(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = postizDraftResolveInput.parse(raw);
  const row = await entity(tx, scope, "postiz_drafts", input.handoffId);
  if (data(row).status !== "outcome_unknown")
    throw new DomainError("POSTIZ_DRAFT_NOT_UNKNOWN", 409);
  await audit(tx, scope, "postiz_draft.resolved", row.id, {
    resolution: input.resolution,
  });
  return update(tx, scope, row, {
    ...data(row),
    status: input.resolution === "exists" ? "accepted" : "failed",
    resolution: input.resolution,
    resolvedBy: scope.userId,
    resolvedAt: new Date().toISOString(),
  });
}

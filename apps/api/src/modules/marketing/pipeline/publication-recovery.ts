import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { retrieve } from "../../../../../../packages/knowledge/src/index.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import {
  cancelOriginPost,
  confirmedOriginCancellation,
  hasAccountBooking,
} from "../../social/contract.ts";
import { closedDraftStatus } from "../approval-state.ts";
import {
  assertCampaignContext,
  currentMarketingProfile,
} from "../brand/marketing-profile.ts";
import { withdrawPublication } from "../agents/package-schedule.ts";
import {
  activePolicy,
  approve,
  checkClaims,
  packageFor,
} from "../policy/policy.ts";
import { publishingBackend } from "../publishing/backend.ts";
import { publishIntent } from "./workflow.ts";

export const prepareRecoveryInput = z
  .object({
    publicationId: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();

export const releaseRecoveryInput = z
  .object({
    contentId: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();

async function lockBookings(tx: DbTx, scope: Scope) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId}, 0))`;
}

const recoveryRefused = () =>
  new DomainError("PUBLICATION_RECOVERY_NOT_AVAILABLE", 409);

async function relatedBooking(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  exceptId: string,
) {
  const publications = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      data: { path: ["contentId"], equals: contentId },
    },
  });
  return publications.find((row) => {
    if (row.id === exceptId) return false;
    const p = data(row);
    if (p.status === "canceled" && p.recoveredContentId === contentId)
      return false;
    return (
      !["blocked_dependency", "canceled", "failed"].includes(p.status) ||
      p.remoteId ||
      p.handoffCompletedAt ||
      p.reconciliationStatus === "required" ||
      (p.status === "failed" && p.socialPostId)
    );
  });
}

/**
 * Return one locally stopped post to the owner's review. A fresh evidence
 * pack and campaign use current rights. The stopped publication keeps its
 * history. This action never gives a publishing right or books a slot.
 */
export async function preparePublicationRecovery(
  tx: DbTx,
  scope: Scope,
  input: z.infer<typeof prepareRecoveryInput>,
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  await lockBookings(tx, scope);
  const publication = await entity(
    tx,
    scope,
    "publications",
    input.publicationId,
  );
  const p = data(publication);
  if (
    !["blocked_dependency", "canceled"].includes(p.status) ||
    p.reconciliationStatus === "required"
  )
    throw recoveryRefused();
  if (
    (p.remoteId || p.handoffCompletedAt) &&
    !(
      p.status === "canceled" &&
      p.publishingBackend === "social" &&
      typeof p.remoteId === "string" &&
      (await confirmedOriginCancellation(tx, scope, p.remoteId, {
        module: "marketing",
        type: "publication",
        id: publication.id,
        version: 1,
      }))
    )
  )
    throw new DomainError("RECONCILIATION_REQUIRED", 409);
  const content = await entity(tx, scope, "content", p.contentId);
  const c = data(content);
  if (closedDraftStatus(c) || c.type !== "social" || !c.body || !c.missionId)
    throw recoveryRefused();
  if (c.recoveredFromPublicationId === publication.id) return content;
  if (
    p.recoveredContentId ||
    (await relatedBooking(tx, scope, content.id, publication.id))
  )
    throw recoveryRefused();
  if (publication.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);

  const policyRow = await activePolicy(tx, scope);
  const profileRow = await currentMarketingProfile(tx, scope);
  if (!policyRow || !profileRow) throw recoveryRefused();
  const policy = data(policyRow);
  if (
    !policy.channels.includes(c.channel) ||
    !policy.contentTypes.includes("social")
  )
    throw new DomainError("SCOPE_NOT_ALLOWED", 409);
  const profile = marketingProfile.parse(profileRow.data);
  const priorMission = data(await entity(tx, scope, "missions", c.missionId));
  const oldEvidence = data(
    await tx.entity.findFirst({
      where: {
        id: c.evidenceId,
        kind: "evidence",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
    }),
  );
  const citedFacts = new Set(
    (c.claims ?? []).map((claim: { factId?: string }) => claim.factId),
  );
  const relevantFacts = (oldEvidence.facts ?? []).filter(
    (fact: { id: string }) => citedFacts.has(fact.id),
  );
  const fresh = await retrieve(tx, scope, {
    query: String(oldEvidence.query || priorMission.goal || c.title).slice(
      0,
      2000,
    ),
    language: c.language,
    purpose: "public",
    consumer: "marketing",
    factKeys: relevantFacts.map((fact: { key: string }) => fact.key),
  });
  const links = profile.officialLinks.filter((link) =>
    policy.allowedOrigins.includes(new URL(link.url).origin),
  );
  const targetUrl = (
    links.find((link) => link.url === priorMission.targetUrl) ?? links[0]
  )?.url;
  const targetAction = profile.primaryCtas.includes(priorMission.targetAction)
    ? priorMission.targetAction
    : profile.primaryCtas[0];
  const missionData = {
    title: String(priorMission.title || c.title).slice(0, 160),
    goal: String(priorMission.goal || c.title).slice(0, 2000),
    audience: priorMission.audience,
    product: priorMission.product,
    language: c.language,
    channels: [c.channel],
    allowedActions: ["draft", "review"],
    maxContents: 1,
    startAt: new Date().toISOString(),
    endAt: policy.endAt,
    targetAction,
    targetUrl,
    contentType: "social",
    campaignType: priorMission.campaignType,
    profileVersion: profileRow.version,
    sourceIds: [
      ...new Set(
        relevantFacts.map((fact: { sourceId: string }) => fact.sourceId),
      ),
    ],
    assetIds: c.assetId ? [c.assetId] : [],
    recoveryContentId: content.id,
    status: "ready",
  };
  await assertCampaignContext(tx, scope, missionData);

  if (
    typeof p.socialPostId === "string" &&
    (await cancelOriginPost(
      tx,
      scope,
      p.socialPostId,
      "PUBLICATION_RECOVERY",
    )) !== "canceled"
  )
    throw new DomainError("RECONCILIATION_REQUIRED", 409);

  const mission = await create(tx, scope, "missions", missionData);
  // The recovery is an editorial decision, separate from the completed
  // assignment and its old slot. Keep exact copy, claims and approved asset.
  const {
    assignmentId: _assignment,
    assignmentRunId: _run,
    scheduledAt: _oldTime,
    humanReviewedBodyHash: _human,
    agentReview: _agent,
    sharedFrom: _shared,
    packageId: _package,
    delivery: _delivery,
    approvalMode: _approvalMode,
    dependencyInvalidated: _invalid,
    invalidationReason: _reason,
    profileInvalidatedFrom: _oldProfile,
    profileInvalidatedTo: _newProfile,
    ...rest
  } = c;
  const prepared = await update(tx, scope, content, {
    ...rest,
    missionId: mission.id,
    profileVersion: profileRow.version,
    evidenceId: fresh.id,
    targetUrl,
    status: "needs_review",
    recoveredFromPublicationId: publication.id,
    // This is only the proposed time in the draft editor.
    ...(Date.parse(p.scheduledAt) > Date.now()
      ? { scheduledAt: p.scheduledAt }
      : {}),
  });
  await withdrawPublication(tx, scope, publication, "CANCELED", {
    recoveredContentId: content.id,
    recoveryPriorReason:
      p.reason ?? p.invalidationReason ?? p.blockers?.[0] ?? null,
  });
  const review = await checkClaims(tx, scope, prepared.id);
  await audit(tx, scope, "publication.recovery_prepared", publication.id, {
    contentId: content.id,
    missionId: mission.id,
  });
  return update(tx, scope, prepared, { ...data(prepared), review });
}

/** Release only the reviewed version and saved time, in one guarded transaction. */
export async function releasePublicationRecovery(
  tx: DbTx,
  scope: Scope,
  input: z.infer<typeof releaseRecoveryInput>,
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  await lockBookings(tx, scope);
  const content = await entity(tx, scope, "content", input.contentId);
  const c = data(content);
  if (content.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (!c.recoveredFromPublicationId || closedDraftStatus(c))
    throw recoveryRefused();
  const prior = data(
    await entity(tx, scope, "publications", c.recoveredFromPublicationId),
  );
  if (prior.recoveredContentId !== content.id || prior.status !== "canceled")
    throw recoveryRefused();
  const existing = await relatedBooking(
    tx,
    scope,
    content.id,
    c.recoveredFromPublicationId,
  );
  if (existing) {
    const booking = data(existing);
    if (
      !["blocked_dependency", "canceled", "failed"].includes(booking.status) &&
      booking.contentVersion === content.version
    )
      return existing;
    throw recoveryRefused();
  }
  if (c.status !== "reviewed" || c.humanReviewedBodyHash !== hash(c.body))
    throw new DomainError("HUMAN_CONTENT_REVIEW_REQUIRED", 409);
  const at = new Date(c.scheduledAt);
  if (!(at.valueOf() > Date.now()))
    throw new DomainError("INVALID_SCHEDULE", 409);
  if (
    (await publishingBackend(tx, scope)) === "social" &&
    (await hasAccountBooking(tx, scope, c.channel, at))
  )
    throw new DomainError("RECOVERY_SLOT_OCCUPIED", 409);
  const mission = await entity(tx, scope, "missions", c.missionId);
  const m = data(mission);
  if (m.recoveryContentId !== content.id) throw recoveryRefused();
  await update(tx, scope, mission, {
    ...m,
    recoveryContentVersion: content.version,
    allowedActions: [
      ...new Set([
        ...m.allowedActions,
        process.env.EXECUTION_MODE === "live" ? "publish_live" : "publish_test",
      ]),
    ],
  });
  const pkg = await packageFor(tx, scope, content.id);
  await approve(
    tx,
    scope,
    {
      contentId: content.id,
      version: content.version,
      packageHash: pkg.packageHash,
    },
    new Date(at.valueOf() + 60 * 60_000),
  );
  const booking = await publishIntent(tx, scope, {
    contentId: content.id,
    version: content.version,
    scheduledAt: c.scheduledAt,
  });
  return update(tx, scope, booking, {
    ...data(booking),
    ownerReleasedAt: new Date().toISOString(),
    ownerReleasedBy: scope.userId,
    recoveredFromPublicationId: c.recoveredFromPublicationId,
  });
}

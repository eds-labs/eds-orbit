import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import {
  mission as missionSchema,
  policy as policySchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { getActiveIndex } from "../../../../../../packages/knowledge/src/index.ts";
import {
  draftTaskClass,
  estimateCost,
  resolveRoute,
} from "../../../../../../packages/ai/src/index.ts";
import {
  authorize,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { indexHasEmbeddings } from "../../../platform/knowledge/retrieval.ts";
import { runtimeOpenAiConfiguration } from "../../../platform/ai/openai-configuration.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import { chatScoped, conversation, where } from "../../chat.ts";
import { activePolicy } from "../policy/policy.ts";
import { assertCampaignContext } from "../brand/marketing-profile.ts";
import { assertMissionAssets } from "../brand/asset-tools.ts";
import { assertAssignedSocialChannels } from "../publishing/postiz-assignment.ts";

// Campaign proposals of the assistant (WP2.2): the propose_campaign tool
// saves one, the user confirms it into a draft-only mission. Moved unchanged
// from chat.ts; the ChatProposal table stays the platform's assistant storage.

export const confirmInput = z
  .object({
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationId: z.uuid(),
  })
  .strict();
const proposeInput = z
  .object({ mission: z.unknown(), factIds: z.array(z.uuid()).min(1).max(20) })
  .strict();

/**
 * Checks one draft-only mission against the current marketing profile,
 * policy, assigned channels, period, run budget, sources and verified facts.
 * Shared by chat proposals and content packages.
 */
export async function validateDraftMission(
  tx: DbTx,
  scope: Scope,
  mission: unknown,
  factIds: string[],
) {
  const parsed = missionSchema.parse({
    ...(mission as object),
    allowedActions: ["draft"],
  });
  if (!parsed.sourceIds.length)
    throw new DomainError("PROPOSAL_SOURCE_REQUIRED", 409);
  await assertCampaignContext(tx, scope, parsed);
  await assertMissionAssets(tx, scope, parsed.assetIds);
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const p = policySchema.parse(
    Object.fromEntries(
      Object.entries(data(policyRow)).filter(
        ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
      ),
    ),
  );
  if (parsed.channels.some((channel) => !p.channels.includes(channel)))
    throw new DomainError("CHANNEL_NOT_APPROVED", 409);
  if (!p.allowedOrigins.includes(new URL(parsed.targetUrl!).origin))
    throw new DomainError("LINK_NOT_ALLOWED", 409);
  if (parsed.contentType === "social")
    await assertAssignedSocialChannels(tx, scope, parsed.channels);
  if (
    Date.parse(parsed.endAt) <= Date.now() ||
    Date.parse(parsed.endAt) > Date.parse(p.endAt) ||
    Date.parse(parsed.startAt) < Date.parse(p.startAt)
  )
    throw new DomainError("PROPOSAL_PERIOD_OUTSIDE_POLICY", 409);
  const ai = await runtimeOpenAiConfiguration(tx, scope);
  const draftRoute = resolveRoute(draftTaskClass(parsed.contentType), ai);
  const draftModel = draftRoute.model;
  const index = await getActiveIndex(tx, scope);
  // A query embedding is bought (and priced) only for an embedded index.
  const firstDraftMaxMicros =
    estimateCost(draftModel, 50000, draftRoute.maxOutputTokens, ai) +
    ((await indexHasEmbeddings(tx, scope, index))
      ? estimateCost(index.model, 8000, 0, ai)
      : 0);
  if (firstDraftMaxMicros > p.perRunBudgetMicros)
    throw new DomainError("RUN_BUDGET_EXCEEDED", 409);
  const sourceRows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "sources",
      id: { in: parsed.sourceIds },
    },
  });
  if (
    sourceRows.length !== parsed.sourceIds.length ||
    sourceRows.some(
      (s) =>
        data(s).status !== "active" || !data(s).publicUse || !data(s).modelUse,
    )
  )
    throw new DomainError("SOURCE_NOT_APPROVED", 409);
  const assetRows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      id: { in: parsed.assetIds },
    },
  });
  const factRows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "facts",
      id: { in: factIds },
    },
  });
  const verifiedFacts = factRows.filter(
    (f) =>
      parsed.sourceIds.includes(data(f).sourceId) &&
      data(f).status === "verified" &&
      data(f).publicUse &&
      data(f).modelUse &&
      Date.parse(data(f).validFrom) <= Date.now() &&
      (!data(f).validUntil || Date.parse(data(f).validUntil) > Date.now()),
  );
  if (verifiedFacts.length !== factIds.length)
    throw new DomainError("VERIFIED_FACT_REQUIRED", 409);
  return {
    parsed,
    policyRow,
    policy: p,
    sourceRows,
    assetRows,
    verifiedFacts,
    firstDraftMaxMicros,
    draftModel,
    index,
  };
}

export async function createProposal(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  authorize(scope, PROJECT_WRITE, "EDITOR_REQUIRED");
  const input = proposeInput.parse(raw);
  return chatScoped(scope, async (tx) => {
    await conversation(tx, scope, conversationId);
    const {
      parsed,
      policyRow,
      sourceRows,
      assetRows,
      verifiedFacts,
      firstDraftMaxMicros,
      draftModel,
      index,
    } = await validateDraftMission(tx, scope, input.mission, input.factIds);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    const latest = await tx.chatProposal.findFirst({
      where: { ...where(scope), conversationId },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
    });
    const groupId =
      latest?.status === "proposed" ? latest.groupId : randomUUID();
    const version = latest?.status === "proposed" ? latest.version + 1 : 1;
    const payload = {
      mission: parsed,
      projectGeneration: project.generation,
      policy: { id: policyRow.id, version: policyRow.version },
      sources: sourceRows.map((s) => ({ id: s.id, version: s.version })),
      facts: verifiedFacts.map((f) => ({ id: f.id, version: f.version })),
      assets: assetRows.map((a) => ({ id: a.id, version: a.version })),
      firstDraftMaxMicros,
      planMaxMicros: firstDraftMaxMicros * parsed.maxContents,
      index: { id: index.id, model: index.model },
      draftModel,
    };
    const row = await tx.chatProposal.create({
      data: {
        ...where(scope),
        conversationId,
        groupId,
        version,
        payload: payload as Prisma.InputJsonValue,
        payloadHash: hash(payload),
      },
    });
    return row;
  });
}

export async function confirmProposal(
  scope: Scope,
  proposalId: string,
  raw: unknown,
) {
  authorize(scope, PROJECT_WRITE, "FORBIDDEN");
  const input = confirmInput.parse(raw);
  return chatScoped(scope, async (tx) => {
    const proposal = await tx.chatProposal.findFirst({
      where: { ...where(scope), id: proposalId },
    });
    if (!proposal) throw new DomainError("NOT_FOUND", 404);
    if (
      proposal.version !== input.version ||
      proposal.payloadHash !== input.hash
    )
      throw new DomainError("PROPOSAL_VERSION_CONFLICT", 409);
    if (proposal.status === "confirmed")
      return {
        missionId: proposal.missionId,
        jobId: proposal.jobId,
        status: "in_progress",
      };
    if (proposal.status !== "proposed")
      throw new DomainError("PROPOSAL_BLOCKED", 409);
    const newer = await tx.chatProposal.findFirst({
      where: { groupId: proposal.groupId, version: { gt: proposal.version } },
    });
    if (newer) throw new DomainError("PROPOSAL_SUPERSEDED", 409);
    const payload = proposal.payload as any;
    if (hash(payload) !== proposal.payloadHash)
      throw new DomainError("PROPOSAL_TAMPERED", 409);
    const mission = missionSchema.parse(payload.mission);
    if (mission.allowedActions.some((action) => action !== "draft"))
      throw new DomainError("CHAT_PUBLISHING_FORBIDDEN", 403);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    if (project.paused || project.generation !== payload.projectGeneration)
      throw new DomainError("PROJECT_CHANGED", 409);
    await assertCampaignContext(tx, scope, mission);
    await assertMissionAssets(tx, scope, mission.assetIds);
    const active = await activePolicy(tx, scope);
    if (
      !active ||
      active.id !== payload.policy.id ||
      active.version !== payload.policy.version
    )
      throw new DomainError("POLICY_CHANGED", 409);
    const policy = policySchema.parse(
      Object.fromEntries(
        Object.entries(data(active)).filter(
          ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
        ),
      ),
    );
    if (
      !policy.approvedPaidTests ||
      mission.channels.some((channel) => !policy.channels.includes(channel)) ||
      !policy.allowedOrigins.includes(new URL(mission.targetUrl!).origin) ||
      Date.parse(mission.endAt) > Date.parse(policy.endAt) ||
      Date.parse(mission.endAt) <= Date.now() ||
      payload.firstDraftMaxMicros > policy.perRunBudgetMicros
    )
      throw new DomainError("PROPOSAL_PREREQUISITE_CHANGED", 409);
    if (mission.contentType === "social")
      await assertAssignedSocialChannels(tx, scope, mission.channels);
    const ai = await runtimeOpenAiConfiguration(tx, scope);
    const currentIndex = await getActiveIndex(tx, scope);
    const currentRoute = resolveRoute(draftTaskClass(mission.contentType), ai);
    const currentModel = currentRoute.model;
    const currentCost =
      estimateCost(currentModel, 50000, currentRoute.maxOutputTokens, ai) +
      ((await indexHasEmbeddings(tx, scope, currentIndex))
        ? estimateCost(currentIndex.model, 8000, 0, ai)
        : 0);
    if (
      currentIndex.id !== payload.index.id ||
      currentModel !== payload.draftModel ||
      currentCost > payload.firstDraftMaxMicros
    )
      throw new DomainError("PROPOSAL_COST_CHANGED", 409);
    const now = new Date();
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const rows = await tx.budgetReservation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        createdAt: { gte: month },
        state: { not: "released" },
      },
    });
    const amount = (r: (typeof rows)[number]) =>
      Number(r.state === "settled" ? r.settledMicros : r.amountMicros);
    const monthly = rows.reduce((n, r) => n + amount(r), 0);
    const daily = rows
      .filter((r) => r.createdAt >= day)
      .reduce((n, r) => n + amount(r), 0);
    if (
      monthly + currentCost > policy.monthlyBudgetMicros ||
      daily + currentCost > policy.dailyBudgetMicros
    )
      throw new DomainError("BUDGET_EXCEEDED", 409);
    for (const ref of payload.sources) {
      const row = await entity(tx, scope, "sources", ref.id);
      if (
        row.version !== ref.version ||
        data(row).status !== "active" ||
        !data(row).publicUse ||
        !data(row).modelUse
      )
        throw new DomainError("SOURCE_CHANGED", 409);
    }
    const factKeys = new Set<string>();
    for (const ref of payload.facts) {
      const row = await entity(tx, scope, "facts", ref.id);
      factKeys.add(String(data(row).key));
      if (
        row.version !== ref.version ||
        data(row).status !== "verified" ||
        !data(row).publicUse ||
        !data(row).modelUse ||
        Date.parse(data(row).validFrom) > Date.now() ||
        (data(row).validUntil && Date.parse(data(row).validUntil) <= Date.now())
      )
        throw new DomainError("FACT_CHANGED", 409);
    }
    for (const ref of payload.assets) {
      const row = await entity(tx, scope, "assets", ref.id);
      if (
        row.version !== ref.version ||
        !data(row).usageApproved ||
        data(row).assetStatus !== "approved"
      )
        throw new DomainError("ASSET_CHANGED", 409);
    }
    const created = await create(tx, scope, "missions", {
      ...mission,
      status: "ready",
      chatProposalId: proposal.id,
      chatCostCeilingMicros: payload.firstDraftMaxMicros,
      // Exact keys of the confirmed verified facts bound mission retrieval,
      // independent of the free-text topics the model chose.
      factKeys: [...factKeys],
    });
    const availableAt = new Date(
      Math.max(Date.now(), Date.parse(mission.startAt)),
    );
    const job = await enqueue(
      tx,
      scope,
      "generation",
      created.id,
      "mission:" + created.id + ":" + created.version,
      availableAt,
    );
    await tx.chatProposal.update({
      where: { id: proposal.id },
      data: {
        status: "confirmed",
        confirmationId: input.confirmationId,
        missionId: created.id,
        jobId: job.id,
        confirmedAt: new Date(),
      },
    });
    await audit(tx, scope, "chat.proposal.confirmed", proposal.id, {
      missionId: created.id,
      jobId: job.id,
      version: proposal.version,
    });
    return { missionId: created.id, jobId: job.id, status: "in_progress" };
  });
}

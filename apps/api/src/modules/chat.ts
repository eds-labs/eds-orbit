import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../packages/db/src/index.ts";
import { scoped } from "../../../../packages/db/src/index.ts";
import {
  mission as missionSchema,
  policy as policySchema,
  type Scope,
} from "../../../../packages/schemas/src/index.ts";
import { getActiveIndex } from "../../../../packages/knowledge/src/index.ts";
import { estimateCost, route } from "../../../../packages/ai/src/index.ts";
import {
  data,
  create,
  audit,
  hash,
  DomainError,
  entity,
  list,
} from "../shared.ts";
import { enqueue } from "./workflow.ts";
import { activePolicy } from "./policy.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
import {
  assertCampaignContext,
  currentMarketingProfile,
} from "./marketing-profile.ts";
import { assertMissionAssets } from "./asset-tools.ts";

export const sendInput = z
  .object({
    text: z.string().trim().min(1).max(4000),
    clientRequestId: z.uuid(),
  })
  .strict();
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

export async function chatScoped<T>(
  scope: Scope,
  work: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
    return work(tx);
  });
}

function where(scope: Scope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    userId: scope.userId,
  };
}

async function conversation(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.chatConversation.findFirst({
    where: { ...where(scope), id },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export async function createConversation(scope: Scope) {
  return chatScoped(scope, (tx) =>
    tx.chatConversation.create({ data: where(scope) }),
  );
}

export async function listConversations(scope: Scope, cursor?: string) {
  return chatScoped(scope, async (tx) => {
    const items = await tx.chatConversation.findMany({
      where: where(scope),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return {
      items: items.slice(0, 20),
      nextCursor: items.length > 20 ? (items[19]?.id ?? null) : null,
    };
  });
}

export async function getConversation(scope: Scope, id: string) {
  return chatScoped(scope, async (tx) => {
    const row = await conversation(tx, scope, id);
    const savedMessages = await tx.chatMessage.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { sequence: "asc" },
      take: 200,
    });
    const cardIds = savedMessages.flatMap((message) =>
      Array.isArray(message.cards)
        ? (message.cards as any[])
            .map((card) => card.resourceId)
            .filter((value) => typeof value === "string")
        : [],
    );
    const cardResources = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        id: { in: cardIds },
      },
    });
    const messages = savedMessages.map((message) => ({
      ...message,
      cards: Array.isArray(message.cards)
        ? (message.cards as any[]).map((card) => {
            if (!card.resourceId) return card;
            const resource = cardResources.find(
              (candidate) => candidate.id === card.resourceId,
            );
            const valid =
              resource &&
              resource.version === card.version &&
              (card.kind === "source"
                ? data(resource).status === "active"
                : data(resource).usageApproved === true &&
                  data(resource).assetStatus === "approved");
            return { ...card, status: valid ? card.status : "stale" };
          })
        : [],
    }));
    const runs = await tx.chatRun.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const proposals = await tx.chatProposal.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const jobs = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "jobs",
        id: {
          in: proposals.flatMap((proposal) =>
            proposal.jobId ? [proposal.jobId] : [],
          ),
        },
      },
    });
    const contents = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "content",
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const linked = proposals.map((proposal) => {
      const job = jobs.find((candidate) => candidate.id === proposal.jobId);
      const content = contents.find(
        (candidate) => data(candidate).jobId === proposal.jobId,
      );
      return {
        ...proposal,
        action: job
          ? {
              status: data(job).status,
              error: data(job).error ?? null,
              contentId: content?.id ?? null,
            }
          : null,
      };
    });
    return { conversation: row, messages, runs, proposals: linked };
  });
}

export async function sendMessage(scope: Scope, id: string, raw: unknown) {
  const input = sendInput.parse(raw);
  return chatScoped(scope, async (tx) => {
    const thread = await conversation(tx, scope, id);
    const prior = await tx.chatRun.findUnique({
      where: {
        conversationId_clientRequestId: {
          conversationId: id,
          clientRequestId: input.clientRequestId,
        },
      },
    });
    if (prior)
      return { runId: prior.id, jobId: prior.jobId, status: prior.status };
    const active = await tx.chatRun.findFirst({
      where: {
        ...where(scope),
        conversationId: id,
        status: { in: ["queued", "running"] },
      },
    });
    if (active) throw new DomainError("CHAT_RUN_IN_PROGRESS", 409);
    const last = await tx.chatMessage.findFirst({
      where: { ...where(scope), conversationId: id },
      orderBy: { sequence: "desc" },
    });
    await tx.chatMessage.create({
      data: {
        ...where(scope),
        conversationId: id,
        sequence: (last?.sequence ?? 0) + 1,
        role: "user",
        text: input.text,
      },
    });
    const run = await tx.chatRun.create({
      data: {
        ...where(scope),
        conversationId: id,
        clientRequestId: input.clientRequestId,
      },
    });
    const job = await enqueue(tx, scope, "chat", run.id, "chat:" + run.id);
    await tx.chatRun.update({ where: { id: run.id }, data: { jobId: job.id } });
    await tx.chatConversation.update({
      where: { id },
      data: {
        title:
          thread.title === "New conversation"
            ? input.text.slice(0, 80)
            : thread.title,
      },
    });
    return { runId: run.id, jobId: job.id, status: "queued" };
  });
}

export async function getRun(scope: Scope, runId: string) {
  return chatScoped(scope, async (tx) => {
    const run = await tx.chatRun.findFirst({
      where: { ...where(scope), id: runId },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    return run;
  });
}

export async function cancelRun(scope: Scope, runId: string) {
  return chatScoped(scope, async (tx) => {
    const run = await tx.chatRun.findFirst({
      where: { ...where(scope), id: runId },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    if (["succeeded", "blocked", "failed", "canceled"].includes(run.status))
      return run;
    return tx.chatRun.update({
      where: { id: run.id },
      data: { status: "canceled", sequence: { increment: 1 } },
    });
  });
}

export async function createProposal(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  const input = proposeInput.parse(raw);
  return chatScoped(scope, async (tx) => {
    await conversation(tx, scope, conversationId);
    const parsed = missionSchema.parse({
      ...(input.mission as object),
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
    if (
      Date.parse(parsed.endAt) <= Date.now() ||
      Date.parse(parsed.endAt) > Date.parse(p.endAt) ||
      Date.parse(parsed.startAt) < Date.parse(p.startAt)
    )
      throw new DomainError("PROPOSAL_PERIOD_OUTSIDE_POLICY", 409);
    const ai = await runtimeOpenAiConfiguration(tx, scope);
    const draftModel = route("draft", 0, 0, ai);
    const index = await getActiveIndex(tx, scope);
    const firstDraftMaxMicros =
      estimateCost(draftModel, 50000, 1800, ai) +
      estimateCost(index.model, 8000, 0, ai);
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
          data(s).status !== "active" ||
          !data(s).publicUse ||
          !data(s).modelUse,
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
        id: { in: input.factIds },
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
    if (verifiedFacts.length !== input.factIds.length)
      throw new DomainError("VERIFIED_FACT_REQUIRED", 409);
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
  if (scope.role === "viewer") throw new DomainError("FORBIDDEN", 403);
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
      Date.parse(mission.endAt) > Date.parse(policy.endAt) ||
      Date.parse(mission.endAt) <= Date.now() ||
      payload.firstDraftMaxMicros > policy.perRunBudgetMicros
    )
      throw new DomainError("PROPOSAL_PREREQUISITE_CHANGED", 409);
    const ai = await runtimeOpenAiConfiguration(tx, scope);
    const currentIndex = await getActiveIndex(tx, scope);
    const currentModel = route("draft", 0, 0, ai);
    const currentCost =
      estimateCost(currentModel, 50000, 1800, ai) +
      estimateCost(currentIndex.model, 8000, 0, ai);
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
    for (const ref of payload.facts) {
      const row = await entity(tx, scope, "facts", ref.id);
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

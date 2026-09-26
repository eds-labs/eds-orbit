import { finishMissionRun } from "./planning.ts";
import { retrieveHybrid } from "./retrieval.ts";
import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  retrieve,
  validateEvidence,
} from "../../../../packages/knowledge/src/index.ts";
import {
  generate,
  route,
  estimateCost,
} from "../../../../packages/ai/src/index.ts";
import { activePolicy } from "./policy.ts";
import { reserve, settle, markTransmitted } from "./budget.ts";
import {
  data,
  entity,
  create,
  update,
  DomainError,
  audit,
  hash,
} from "../shared.ts";
import { policy } from "../../../../packages/schemas/src/index.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
import { assertMissionAssets } from "./asset-tools.ts";
import { campaignGenerationContext } from "./marketing-profile.ts";
type GenerationContract = {
  goal: string;
  audience: string;
  product: string;
  language: string;
  channel: string;
  contentType: string;
  allowedTopics: string[];
  channelConstraints: {
    approvedChannels: string[];
    approvedContentTypes: string[];
    characterLimit: null;
  };
  missionId: string;
  missionVersion: number;
  projectGeneration: number;
  policyId: string;
  policyVersion: number;
  costCeilingMicros: number;
  evidenceId: string;
  sourceIds: string[];
  approvedAssetIds: string[];
  campaign: Awaited<ReturnType<typeof campaignGenerationContext>> | null;
  planContext: unknown;
};
export async function generateMissionLive(
  scope: Scope,
  missionId: string,
  jobId: string,
) {
  const saved = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.entity.findFirst({
      where: {
        projectId: scope.projectId,
        kind: "content",
        data: { path: ["jobId"], equals: jobId },
      },
    }),
  );
  if (saved) return saved;
  const initial = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const mission = await entity(tx, scope, "missions", missionId),
        m = data(mission);
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) throw new DomainError("PROJECT_PAUSED");
      if (m.status !== "ready") throw new DomainError("MISSION_NOT_READY");
      if ((m.completedRuns ?? 0) >= m.maxContents)
        throw new DomainError("MISSION_RUN_QUOTA");
      if (new Date(m.startAt) > new Date() || new Date(m.endAt) <= new Date())
        throw new DomainError("MISSION_NOT_ACTIVE");
      if (
        (await tx.entity.count({
          where: {
            projectId: scope.projectId,
            kind: "content",
            data: { path: ["missionId"], equals: missionId },
          },
        })) >= m.maxContents
      )
        throw new DomainError("MISSION_CONTENT_QUOTA");
      const reservation = await tx.budgetReservation.findFirst({
        where: {
          projectId: scope.projectId,
          key: scope.projectId + ":" + jobId,
        },
      });
      if (reservation) throw new DomainError("RESERVATION_ALREADY_USED");
      if (m.campaignType || m.profileVersion)
        await campaignGenerationContext(
          tx,
          scope,
          m,
          m.channels[(m.completedRuns ?? 0) % m.channels.length],
        );
      const currentPolicy = await activePolicy(tx, scope);
      if (!currentPolicy) throw new DomainError("POLICY_REQUIRED");
      const activeScope = data(currentPolicy);
      const channel = m.channels[(m.completedRuns ?? 0) % m.channels.length];
      if (
        !activeScope.channels?.includes(channel) ||
        !activeScope.contentTypes?.includes(m.contentType)
      )
        throw new DomainError("SCOPE_NOT_ALLOWED", 409);
      if (
        m.targetUrl &&
        !activeScope.allowedOrigins?.includes(new URL(m.targetUrl).origin)
      )
        throw new DomainError("LINK_NOT_ALLOWED", 409);
      route(
        m.contentType === "blog" ? "blog" : "draft",
        0,
        0,
        await runtimeOpenAiConfiguration(tx, scope),
      );
      return mission;
    },
  );
  const retrieved = await retrieveHybrid(
    scope,
    {
      query: data(initial).goal,
      sourceIds: data(initial).sourceIds,
      language: data(initial).language,
      purpose: "public",
      forModel: true,
      at: new Date(),
    },
    "mission:" + jobId,
  );
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const mission = await entity(tx, scope, "missions", missionId),
        m = data(mission);
      if (new Date(m.endAt) <= new Date())
        throw new DomainError("MISSION_EXPIRED");
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) throw new DomainError("PROJECT_PAUSED");
      await assertMissionAssets(tx, scope, m.assetIds ?? []);
      const count = await tx.entity.count({
        where: {
          projectId: scope.projectId,
          kind: "content",
          data: { path: ["missionId"], equals: missionId },
        },
      });
      if (count >= m.maxContents)
        throw new DomainError("MISSION_CONTENT_QUOTA");
      if (mission.version !== initial.version)
        throw new DomainError("MISSION_CHANGED");
      const evidence = await entity(tx, scope, "evidence", retrieved.id);
      if (!(await validateEvidence(tx, scope, evidence.id, new Date())).valid)
        throw new DomainError("EVIDENCE_INVALID");
      if (data(evidence).status !== "ready")
        throw new DomainError("INSUFFICIENT_MODEL_APPROVED_EVIDENCE");
      const ai = await runtimeOpenAiConfiguration(tx, scope);
      const model = route(
        m.contentType === "blog" ? "blog" : "draft",
        0,
        0,
        ai,
      );
      const p = await activePolicy(tx, scope);
      if (!p) throw new DomainError("POLICY_REQUIRED");
      const parsed = policy.parse(
        Object.fromEntries(
          Object.entries(data(p)).filter(
            ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
          ),
        ),
      );
      const channel = m.channels[(m.completedRuns ?? 0) % m.channels.length];
      if (
        !parsed.channels.includes(channel) ||
        !parsed.contentTypes.includes(m.contentType)
      )
        throw new DomainError("SCOPE_NOT_ALLOWED", 409);
      if (
        m.targetUrl &&
        !parsed.allowedOrigins.includes(new URL(m.targetUrl).origin)
      )
        throw new DomainError("LINK_NOT_ALLOWED", 409);
      const campaignContext =
        m.campaignType || m.profileVersion
          ? await campaignGenerationContext(tx, scope, m, channel)
          : null;
      const contract: GenerationContract = {
        goal: m.goal,
        audience: m.audience,
        product: campaignContext?.product ?? m.product,
        language: m.language,
        channel,
        contentType: m.contentType,
        allowedTopics: m.allowedTopics ?? [],
        channelConstraints: {
          approvedChannels: parsed.channels,
          approvedContentTypes: parsed.contentTypes,
          characterLimit: null,
        },
        missionId,
        missionVersion: mission.version,
        projectGeneration: project.generation,
        policyId: p.id,
        policyVersion: p.version,
        costCeilingMicros: parsed.perRunBudgetMicros,
        evidenceId: evidence.id,
        sourceIds: m.sourceIds,
        approvedAssetIds: m.assetIds ?? [],
        campaign: campaignContext,
        planContext: m.planContext
          ? {
              ...m.planContext,
              insights: (m.planContext.insights ?? []).slice(0, 5),
              preferences: (m.planContext.preferences ?? []).slice(0, 20),
            }
          : null,
      };
      const goal = JSON.stringify(contract);
      const cost = estimateCost(
        model,
        Buffer.byteLength(JSON.stringify({ goal, evidence: data(evidence) })) +
          4000,
        1800,
        ai,
      );
      if (m.chatProposalId) {
        const query = await tx.budgetReservation.findFirst({
          where: {
            projectId: scope.projectId,
            key: scope.projectId + ":query:mission:" + jobId,
          },
        });
        const queryCost = query
          ? Number(
              query.state === "settled"
                ? query.settledMicros
                : query.amountMicros,
            )
          : 0;
        if (
          !Number.isSafeInteger(m.chatCostCeilingMicros) ||
          queryCost + cost > m.chatCostCeilingMicros
        )
          throw new DomainError("CHAT_PROPOSAL_COST_EXCEEDED", 409);
      }
      const reservation = await reserve(
        tx,
        scope,
        jobId,
        "text",
        cost,
        parsed,
        new Date(),
        "mission:" + jobId,
      );
      return {
        mission,
        goal,
        evidence,
        model,
        reservationId: reservation.id,
        ai,
        projectGeneration: project.generation,
        policyId: p.id,
        policyVersion: p.version,
        campaignContext,
      };
    },
  );
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    const mission = await entity(tx, scope, "missions", missionId);
    const current = await activePolicy(tx, scope);
    const valid = await validateEvidence(
      tx,
      scope,
      prepared.evidence.id,
      new Date(),
    );
    const currentCampaignContext = prepared.campaignContext
      ? await campaignGenerationContext(
          tx,
          scope,
          data(mission),
          prepared.campaignContext.targetChannel,
        )
      : null;
    if (
      project.paused ||
      project.generation !== prepared.projectGeneration ||
      mission.version !== prepared.mission.version ||
      current?.id !== prepared.policyId ||
      current?.version !== prepared.policyVersion ||
      Date.now() < Date.parse(data(current).startAt) ||
      Date.now() >= Date.parse(data(current).endAt) ||
      !valid.valid ||
      hash(currentCampaignContext) !== hash(prepared.campaignContext)
    )
      throw new DomainError("GENERATION_DEPENDENCY_CHANGED");
    await markTransmitted(tx, scope, prepared.reservationId);
  });
  let outcome: Awaited<ReturnType<typeof generate>>;
  try {
    outcome = await generate({
      task: "draft",
      goal: prepared.goal,
      evidence: data(prepared.evidence),
      model: prepared.model,
      reservationId: prepared.reservationId,
      runtime: prepared.ai,
    });
  } catch {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      settle(tx, scope, prepared.reservationId, null),
    );
    throw new DomainError("MODEL_OUTCOME_OR_COST_UNKNOWN");
  }
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    settle(tx, scope, prepared.reservationId, outcome.usage.costMicros),
  );
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      }),
      mission = await entity(tx, scope, "missions", missionId),
      currentPolicy = await activePolicy(tx, scope);
    const evidenceCheck = await validateEvidence(
      tx,
      scope,
      prepared.evidence.id,
      new Date(),
    );
    const currentCampaignContext = prepared.campaignContext
      ? await campaignGenerationContext(
          tx,
          scope,
          data(mission),
          prepared.campaignContext.targetChannel,
        )
      : null;
    if (
      project.paused ||
      project.generation !== prepared.projectGeneration ||
      mission.version !== prepared.mission.version ||
      currentPolicy?.id !== prepared.policyId ||
      currentPolicy?.version !== prepared.policyVersion ||
      Date.now() < Date.parse(data(currentPolicy).startAt) ||
      Date.now() >= Date.parse(data(currentPolicy).endAt) ||
      Date.now() >= Date.parse(data(mission).endAt) ||
      !evidenceCheck.valid ||
      hash(currentCampaignContext) !== hash(prepared.campaignContext)
    )
      throw new DomainError("GENERATION_DEPENDENCY_CHANGED");
    const m = data(mission);
    await assertMissionAssets(tx, scope, m.assetIds ?? []);
    const content = await create(tx, scope, "content", {
      ...outcome.output,
      type: m.contentType,
      language: m.language,
      channel: m.channels[(m.completedRuns ?? 0) % m.channels.length],
      missionId,
      campaignType: m.campaignType,
      profileVersion: m.profileVersion,
      ...(prepared.campaignContext
        ? { targetUrl: prepared.campaignContext.officialTargetUrl }
        : {}),
      ...(m.assetIds?.length
        ? { assetId: m.assetIds[(m.completedRuns ?? 0) % m.assetIds.length] }
        : {}),
      evidenceId: prepared.evidence.id,
      risk: "routine",
      status: "draft",
      synthetic: false,
      origin: "generated_derived",
      model: outcome.usage.model,
      usage: outcome.usage,
      jobId,
    });
    await finishMissionRun(tx, scope, missionId, content.id);
    await audit(tx, scope, "generation.completed", content.id, {
      model: outcome.usage.model,
      reservationId: prepared.reservationId,
    });
    return content;
  });
}

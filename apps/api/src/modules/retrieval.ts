import { randomUUID } from "node:crypto";
import { scoped } from "../../../../packages/db/src/index.ts";
import {
  retrieve,
  getActiveIndex,
  validateEvidence,
  type RetrieveInput,
} from "../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { policy } from "../../../../packages/schemas/src/index.ts";
import { embed, estimateCost } from "../../../../packages/ai/src/index.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
import { activePolicy } from "./policy.ts";
import { reserve, settle, markTransmitted } from "./budget.ts";
import { data, DomainError, create, entity, hash } from "../shared.ts";
import { recordSpan, startRun, tracedRun } from "./telemetry.ts";
/**
 * `trace` is set by a caller that owns an agent run (generation): the query
 * reservation and embedding span then join that run and no retrieval run is
 * opened. Without it, a standalone `retrieval` run wraps the paid call.
 */
export async function retrieveHybrid(
  scope: Scope,
  input: RetrieveInput,
  jobKey?: string,
  budgetRunKey = jobKey,
  trace?: {
    agentRunId: string | null;
    missionId?: string | null;
    taskClass?: string;
  },
) {
  const inputHash = hash({
    query: input.query,
    language: input.language,
    purpose: input.purpose,
    forModel: input.forModel,
    sourceIds: input.sourceIds,
    factKeys: input.factKeys,
    market: input.market,
    topK: input.topK,
    profile: input.profile,
  });
  if (jobKey) {
    const cached = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        const run = await tx.entity.findFirst({
          where: {
            projectId: scope.projectId,
            kind: "retrieval_runs",
            data: { path: ["jobKey"], equals: jobKey },
          },
        });
        if (!run) return null;
        if (data(run).inputHash !== inputHash)
          throw new DomainError("RETRIEVAL_JOB_CHANGED");
        const evidence = await entity(
          tx,
          scope,
          "evidence",
          data(run).evidenceId,
        );
        if (!(await validateEvidence(tx, scope, evidence.id, new Date())).valid)
          throw new DomainError("RETRIEVAL_DEPENDENCY_CHANGED");
        return evidence;
      },
    );
    if (cached) return cached;
  }
  const queryKey = jobKey ?? randomUUID();
  const owned = trace === undefined;
  const agentRunId = owned
    ? await startRun(scope, {
        kind: "retrieval",
        agentName: "orbit_retrieval",
        taskClass: "query_embedding",
        subjectType: "retrieval_key",
        subjectId: queryKey,
      })
    : trace.agentRunId;
  const work = async () => {
    const prepared = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        const index = await getActiveIndex(tx, scope),
          p = await activePolicy(tx, scope);
        if (!p) throw new DomainError("POLICY_REQUIRED");
        const approved = policy.parse(
          Object.fromEntries(
            Object.entries(data(p)).filter(
              ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
            ),
          ),
        );
        const project = await tx.project.findUniqueOrThrow({
          where: { id: scope.projectId },
        });
        if (project.paused) throw new DomainError("PROJECT_PAUSED");
        const ai = await runtimeOpenAiConfiguration(tx, scope);
        const amount = estimateCost(
          index.model,
          Buffer.byteLength(input.query),
          0,
          ai,
        );
        const reservation = await reserve(
          tx,
          scope,
          "query:" + queryKey,
          "query_embedding",
          amount,
          approved,
          new Date(),
          budgetRunKey,
          {
            agentRunId,
            taskClass: trace?.taskClass ?? "query_embedding",
            model: index.model,
            missionId: trace?.missionId ?? null,
          },
        );
        await markTransmitted(tx, scope, reservation.id);
        return {
          index,
          reservationId: reservation.id,
          projectGeneration: project.generation,
          policyId: p.id,
          policyVersion: p.version,
          ai,
        };
      },
    );
    let result: Awaited<ReturnType<typeof embed>>;
    const callStartedAt = new Date();
    try {
      result = await embed(
        [input.query],
        prepared.reservationId,
        true,
        {
          model: prepared.index.model,
          dimensions: prepared.index.dimensions,
        },
        prepared.ai,
      );
    } catch {
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        settle(tx, scope, prepared.reservationId, null),
      );
      // Telemetry only after the settlement committed.
      await recordSpan(scope, agentRunId, {
        type: "embedding",
        name: "embeddings.create",
        model: prepared.index.model,
        status: "unknown",
        errorCode: "QUERY_EMBEDDING_COST_UNKNOWN",
        startedAt: callStartedAt,
        durationMs: Date.now() - callStartedAt.valueOf(),
        budgetReservationId: prepared.reservationId,
      });
      throw new DomainError("QUERY_EMBEDDING_COST_UNKNOWN");
    }
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      settle(tx, scope, prepared.reservationId, result.usage.costMicros),
    );
    await recordSpan(scope, agentRunId, {
      type: "embedding",
      name: "embeddings.create",
      model: result.usage.model,
      status: "succeeded",
      startedAt: callStartedAt,
      durationMs: Date.now() - callStartedAt.valueOf(),
      usage: result.usage,
      costMicros: result.usage.costMicros,
      budgetReservationId: prepared.reservationId,
    });
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({
          where: { id: scope.projectId },
        }),
        p = await activePolicy(tx, scope);
      if (
        project.paused ||
        project.generation !== prepared.projectGeneration ||
        p?.id !== prepared.policyId ||
        p.version !== prepared.policyVersion ||
        Date.now() < Date.parse(data(p).startAt) ||
        Date.now() >= Date.parse(data(p).endAt)
      )
        throw new DomainError("QUERY_POLICY_CHANGED");
      const currentIndex = await getActiveIndex(tx, scope);
      if (currentIndex.id !== prepared.index.id)
        throw new DomainError("QUERY_INDEX_CHANGED");
      const evidence = await retrieve(tx, scope, {
        ...input,
        profile: prepared.index.profile,
        queryVector: result.vectors[0],
      });
      if (jobKey)
        await create(tx, scope, "retrieval_runs", {
          jobKey,
          inputHash,
          evidenceId: evidence.id,
        });
      return evidence;
    });
  };
  return owned ? tracedRun(scope, agentRunId, work) : work();
}

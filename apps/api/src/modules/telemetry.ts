import { createHash, randomUUID } from "node:crypto";
import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";

export type RunKind =
  | "chat"
  | "generation"
  | "retrieval"
  | "ingestion"
  | "reindex"
  | "evaluation"
  | "image";
export type SpanInput = {
  type: "model_call" | "tool_call" | "embedding" | "image";
  name: string;
  model?: string;
  status: "succeeded" | "failed" | "unknown" | "blocked";
  errorCode?: string;
  attempt?: number;
  startedAt: Date;
  durationMs: number;
  usage?: {
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  } | null;
  costMicros?: number | null;
  budgetReservationId?: string | null;
  providerResponseId?: string | null;
  inputHash?: string;
  outputHash?: string;
  parentSpanId?: string;
};

const MAX_TEXT = 120;
const clip = (value: string) => value.slice(0, MAX_TEXT);

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Bounded code only: provider or prompt text in a message must never be stored.
export function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,}$/.test(error.message))
    return error.message;
  return "UNEXPECTED";
}

// Telemetry must never break the observed work; log the class name only.
async function safely<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error(
      "Orbit telemetry write failed",
      error instanceof Error ? error.name : "unknown",
    );
    return fallback;
  }
}

export async function startRun(
  scope: Scope,
  input: {
    kind: RunKind;
    agentName: string;
    taskClass: string;
    subjectType?: string;
    subjectId?: string;
    missionId?: string | null;
    routeVersion?: number | null;
  },
): Promise<string | null> {
  return safely(async () => {
    const id = randomUUID();
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.agentRun.create({
        data: {
          id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: input.kind,
          agentName: clip(input.agentName),
          taskClass: clip(input.taskClass),
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          missionId: input.missionId ?? null,
          routeVersion: input.routeVersion ?? null,
        },
      }),
    );
    return id;
  }, null);
}

export async function recordSpan(
  scope: Scope,
  runId: string | null,
  span: SpanInput,
): Promise<void> {
  if (!runId) return;
  await safely(async () => {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.agentSpan.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          runId,
          parentSpanId: span.parentSpanId ?? null,
          type: span.type,
          name: clip(span.name),
          model: span.model ?? null,
          status: span.status,
          errorCode: span.errorCode ? clip(span.errorCode) : null,
          attempt: span.attempt ?? 1,
          startedAt: span.startedAt,
          durationMs: Math.max(0, Math.round(span.durationMs)),
          inputTokens: span.usage?.inputTokens ?? null,
          cachedTokens: span.usage?.cachedTokens ?? null,
          cacheWriteTokens: span.usage?.cacheWriteTokens ?? null,
          outputTokens: span.usage?.outputTokens ?? null,
          reasoningTokens: span.usage?.reasoningTokens ?? null,
          costMicros:
            span.costMicros == null
              ? null
              : BigInt(Math.round(span.costMicros)),
          budgetReservationId: span.budgetReservationId ?? null,
          providerResponseId: span.providerResponseId ?? null,
          inputHash: span.inputHash ?? null,
          outputHash: span.outputHash ?? null,
        },
      }),
    );
  }, undefined);
}

export async function finishRun(
  scope: Scope,
  runId: string | null,
  status: "succeeded" | "failed" | "blocked" | "canceled" | "unknown",
  code?: string,
): Promise<void> {
  if (!runId) return;
  await safely(async () => {
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const run = await tx.agentRun.findFirst({
        where: {
          id: runId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        select: { startedAt: true },
      });
      if (!run) return;
      const now = new Date();
      await tx.agentRun.updateMany({
        where: {
          id: runId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        data: {
          status,
          errorCode: code ? clip(code) : null,
          endedAt: now,
          durationMs: Math.max(0, now.getTime() - run.startedAt.getTime()),
        },
      });
    });
  }, undefined);
}

// Closes a run opened by the caller once `work` settles; never alters its result or error.
export async function tracedRun<T>(
  scope: Scope,
  runId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await finishRun(scope, runId, "failed", errorCode(error));
    throw error;
  }
  await finishRun(scope, runId, "succeeded");
  return result;
}

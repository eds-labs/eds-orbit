import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { DomainError } from "../src/shared.ts";
import {
  errorCode,
  finishRun,
  hashText,
  recordSpan,
  startRun,
} from "../src/modules/telemetry.ts";

describe("Telemetry helpers", () => {
  it("hashes text as sha256 hex", () => {
    expect(hashText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("maps errors to bounded codes without provider text", () => {
    expect(errorCode(new DomainError("BUDGET_EXCEEDED", 402))).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(errorCode(new Error("USAGE_UNKNOWN"))).toBe("USAGE_UNKNOWN");
    expect(errorCode(new Error("Provider said: secret prompt text"))).toBe(
      "UNEXPECTED",
    );
    expect(errorCode("USAGE_UNKNOWN")).toBe("UNEXPECTED");
    expect(errorCode(undefined)).toBe("UNEXPECTED");
  });
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Failure-tolerant agent telemetry", () => {
  let a: Scope, b: Scope, userId: string, workspaceId: string;
  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic telemetry",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    userId = user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Telemetry",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const [pa, pb] = await Promise.all(
      ["Telemetry A", "Telemetry B"].map((name) =>
        authDb.project.create({ data: { workspaceId, name } }),
      ),
    );
    a = { workspaceId, projectId: pa.id, userId, role: "owner" };
    b = { workspaceId, projectId: pb.id, userId, role: "owner" };
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.delete({ where: { id: userId } });
    await closeDatabase();
  });
  const span = (overrides = {}) => ({
    type: "model_call" as const,
    name: "chat.step",
    model: "synthetic-model",
    status: "succeeded" as const,
    startedAt: new Date(),
    durationMs: 12,
    ...overrides,
  });
  const read = (scope: Scope) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => ({
      runs: await tx.agentRun.findMany(),
      spans: await tx.agentSpan.findMany(),
    }));

  it("records a run, its span with usage and cost, and the final status", async () => {
    const runId = await startRun(a, {
      kind: "chat",
      agentName: "orbit-chat",
      taskClass: "standard",
      subjectType: "chat_run",
      subjectId: randomUUID(),
    });
    expect(runId).toEqual(expect.any(String));
    await recordSpan(
      a,
      runId,
      span({
        usage: {
          inputTokens: 100,
          cachedTokens: 40,
          cacheWriteTokens: 5,
          outputTokens: 30,
          reasoningTokens: 7,
        },
        costMicros: 1234,
        providerResponseId: "resp_synthetic",
        inputHash: hashText("in"),
      }),
    );
    await finishRun(a, runId, "succeeded");
    const { runs, spans } = await read(a);
    const run = runs.find((r) => r.id === runId)!;
    expect(run).toEqual(
      expect.objectContaining({
        status: "succeeded",
        kind: "chat",
        agentName: "orbit-chat",
      }),
    );
    expect(run.endedAt).toBeInstanceOf(Date);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    const stored = spans.filter((s) => s.runId === runId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        type: "model_call",
        model: "synthetic-model",
        attempt: 1,
        inputTokens: 100,
        cachedTokens: 40,
        cacheWriteTokens: 5,
        outputTokens: 30,
        reasoningTokens: 7,
        costMicros: 1234n,
        providerResponseId: "resp_synthetic",
      }),
    );
  });

  it("keeps rows invisible to other projects", async () => {
    const runId = await startRun(a, {
      kind: "retrieval",
      agentName: "knowledge",
      taskClass: "fast",
    });
    await recordSpan(a, runId, span({ type: "embedding", name: "embed" }));
    expect((await read(a)).runs.some((r) => r.id === runId)).toBe(true);
    const other = await read(b);
    expect(other.runs).toHaveLength(0);
    expect(other.spans).toHaveLength(0);
  });

  it("never throws and logs only the error class name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = (await read(a)).spans.length;
    await expect(recordSpan(a, randomUUID(), span())).resolves.toBeUndefined();
    expect((await read(a)).spans).toHaveLength(before);
    await expect(finishRun(a, randomUUID(), "failed", "X")).resolves.toBe(
      undefined,
    );
    expect(
      await startRun(
        { ...a, projectId: "not-a-uuid" },
        { kind: "chat", agentName: "x", taskClass: "fast" },
      ),
    ).toBeNull();
    await expect(recordSpan(a, null, span())).resolves.toBeUndefined();
    await expect(finishRun(a, null, "failed")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "Orbit telemetry write failed",
      expect.any(String),
    );
    for (const call of log.mock.calls) expect(call).toHaveLength(2);
    log.mockRestore();
  });

  it("truncates names and error codes to 120 characters", async () => {
    const runId = await startRun(a, {
      kind: "generation",
      agentName: "orbit-generation",
      taskClass: "quality",
    });
    await recordSpan(
      a,
      runId,
      span({
        name: "x".repeat(500),
        status: "failed",
        errorCode: "E".repeat(500),
      }),
    );
    const stored = (await read(a)).spans.find((s) => s.runId === runId)!;
    expect(stored.name).toHaveLength(120);
    expect(stored.errorCode).toHaveLength(120);
  });
});

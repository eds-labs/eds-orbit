import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { recordSpan, startRun } from "../src/modules/telemetry.ts";
import { listRunSpans } from "../src/modules/ai-usage.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The individual steps of a run were recorded but never shown: on 2026-10-06
 * the tool-search check in production could only be inferred from totals.
 */
describe.skipIf(!enabled)("Steps of one AI run", () => {
  let first: Awaited<ReturnType<typeof createPackageProject>>;
  let second: Awaited<ReturnType<typeof createPackageProject>>;

  beforeAll(async () => {
    first = await createPackageProject();
    second = await createPackageProject();
  });
  afterAll(async () => {
    await first.cleanup();
    await second.cleanup();
    await closeDatabase();
  });

  it("lists a run's steps in order without hashes or response IDs", async () => {
    const runId = (await startRun(first.owner, {
      kind: "chat",
      agentName: "orbit_operator",
      taskClass: "chat_operator",
    }))!;
    const at = Date.now();
    await recordSpan(first.owner, runId, {
      type: "tool_call",
      name: "schedule_options",
      status: "succeeded",
      startedAt: new Date(at + 2000),
      durationMs: 40,
      inputHash: "secret-hash",
    });
    await recordSpan(first.owner, runId, {
      type: "model_call",
      name: "responses.create",
      model: "gpt-6.1-sol",
      status: "succeeded",
      startedAt: new Date(at),
      durationMs: 900,
      usage: {
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
      },
      costMicros: 77,
      providerResponseId: "resp_private",
    });
    await recordSpan(first.owner, runId, {
      type: "tool_call",
      name: "tool_search",
      status: "succeeded",
      startedAt: new Date(at + 1000),
      durationMs: 3,
    });
    const steps = await listRunSpans(first.owner, runId);
    expect(steps.map((step) => step.name)).toEqual([
      "responses.create",
      "tool_search",
      "schedule_options",
    ]);
    expect(steps[0]).toMatchObject({
      type: "model_call",
      model: "gpt-6.1-sol",
      status: "succeeded",
      inputTokens: 100,
      outputTokens: 20,
      costMicros: "77",
    });
    expect(JSON.stringify(steps)).not.toMatch(/secret-hash|resp_private/);
  });

  it("does not show a run of another project", async () => {
    const runId = (await startRun(first.owner, {
      kind: "chat",
      agentName: "orbit_operator",
      taskClass: "chat_operator",
    }))!;
    await expect(listRunSpans(second.owner, runId)).rejects.toThrow(
      "NOT_FOUND",
    );
  });
});

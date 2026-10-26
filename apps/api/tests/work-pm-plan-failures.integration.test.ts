import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError as AnthropicApiError } from "@anthropic-ai/sdk";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { data } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { loadProposal, requestPlan, retryPlan, runPlanJob } from "../src/modules/work/pm/planner.ts";
import { syntheticPlan } from "./fixtures/work-pm/plans.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

// Each reply is the model's plan or an error the call throws. No test
// reaches a provider; refusals are the SDK's own error type.
const mocked = vi.hoisted(() => ({ replies: [] as Array<unknown | Error>, calls: 0, models: [] as string[] }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.calls++;
    mocked.models.push(request.route.model);
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    if (next instanceof Error) throw next;
    return {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: typeof next === "string" ? next : JSON.stringify(next) }] }],
      usage: { model: request.route.model, inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 4000, reasoningTokens: 0, costMicros: 50_000 },
      responseId: "resp_pm_plan",
    };
  }),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/** An Anthropic refusal as the SDK raises it (synthetic message, no prompt text). */
const refusal = (status: number, type: string, message: string) =>
  AnthropicApiError.generate(status, { type: "error", error: { type, message } }, message, new Headers({ "request-id": `req_${status}` }));

/**
 * Failed planning runs (2026-10-26 EOP incident: MODEL_REQUEST_NOT_ACCEPTED
 * without a reason, and no way to plan again): a refusal names its cause,
 * leaves no plan, no task and no charge, and a person can plan again once.
 */
describe.skipIf(!enabled)("AI project manager: failed plans", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const proposal = (id: string) => p.run((tx) => loadProposal(tx, p.owner, id));
  const request = async (goal: string, key: string) =>
    (await p.run((tx) => requestPlan(tx, p.editor, { goal, idempotencyKey: key }, "mcp"))).proposal;
  const planJobs = (id: string) =>
    p.run((tx) =>
      tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs", data: { path: ["resourceId"], equals: id } } }),
    );

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject({ name: "Synthetic plan failures" });
  });
  beforeEach(() => {
    mocked.replies.length = 0;
    mocked.calls = 0;
    mocked.models.length = 0;
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it.each([
    [529, "overloaded_error", "Overloaded", "MODEL_OVERLOADED"],
    [429, "rate_limit_error", "Number of request tokens has exceeded your rate limit", "MODEL_RATE_LIMITED"],
    [400, "invalid_request_error", "output_config.format.schema: too many union types", "MODEL_REQUEST_INVALID"],
    [404, "not_found_error", "model: claude-opus-5-5", "MODEL_NOT_AVAILABLE"],
    [401, "authentication_error", "invalid x-api-key", "MODEL_AUTH_REJECTED"],
  ])("names a %i refusal, stores no plan and charges nothing", async (status, type, message, code) => {
    const queued = await request(`Plan after a ${status}`, `refusal-${status}`);
    mocked.replies.push(refusal(status, type, message));
    await runPlanJob(p.owner, queued.id);
    const failed = await proposal(queued.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: code, plan: null, appliedTaskIds: [], costMicros: 0n });
    expect(failed.actionRequestId).toBeNull();
    // The span says what the provider said; the reservation is released at 0.
    const span = await p.run((tx) =>
      tx.agentSpan.findFirstOrThrow({ where: { projectId: p.owner.projectId, runId: failed.agentRunId!, type: "model_call" } }),
    );
    expect(span.errorCode).toContain(code);
    expect(span.errorCode).toContain(`${status} ${type}`);
    expect(span.providerResponseId).toBe(`req_${status}`);
    const reservations = await p.run((tx) =>
      tx.budgetReservation.findMany({ where: { projectId: p.owner.projectId, agentRunId: failed.agentRunId! } }),
    );
    expect(reservations.map((r) => Number(r.settledMicros))).toEqual([0]);
    expect(await p.run((tx) => tx.workTask.count({ where: { projectId: p.owner.projectId } }))).toBe(0);
  });

  it("plans again once after a failure, as a new revision, and never twice", async () => {
    const queued = await request("Plan the EOP initiative", "eop-1");
    mocked.replies.push(refusal(529, "overloaded_error", "Overloaded"));
    await runPlanJob(p.owner, queued.id);
    // The same request again (as an MCP client sends it) starts a new revision.
    const again = await p.run((tx) => requestPlan(tx, p.editor, { goal: "Plan the EOP initiative", idempotencyKey: "eop-1" }, "mcp"));
    expect(again.deduplicated).toBe(false);
    expect(again.proposal).toMatchObject({ status: "queued", revision: 2, supersedesId: queued.id });
    expect(await proposal(queued.id)).toMatchObject({ status: "superseded", idempotencyKey: null });
    // Repeating it while it runs returns the running revision.
    const third = await p.run((tx) => requestPlan(tx, p.editor, { goal: "Plan the EOP initiative", idempotencyKey: "eop-1" }, "mcp"));
    expect(third).toMatchObject({ deduplicated: true, proposal: { id: again.proposal.id } });
    // The failed revision cannot be retried a second time.
    expect(await failure(p.run((tx) => retryPlan(tx, p.editor, queued.id)))).toBe("WORK_PROPOSAL_NOT_FAILED");
    expect((await planJobs(again.proposal.id)).map((j) => data(j).topic)).toEqual(["work_pm"]);
    // The retry succeeds and proposes the plan for approval.
    mocked.replies.push(syntheticPlan(5));
    await runPlanJob(p.owner, again.proposal.id);
    const proposed = await proposal(again.proposal.id);
    expect(proposed).toMatchObject({ status: "proposed", costMicros: 50_000n });
    expect(proposed.actionRequestId).not.toBeNull();
    // A replayed job of the finished revision runs nothing.
    await runPlanJob(p.owner, again.proposal.id);
    expect(mocked.calls).toBe(2);
    // Nothing is created before an editor approves the plan.
    expect(await p.run((tx) => tx.workTask.count({ where: { projectId: p.owner.projectId } }))).toBe(0);
  });

  it("retries from the plan view and keeps an invalid answer from becoming a plan", async () => {
    const queued = await request("Plan with a broken answer", "broken-1");
    mocked.replies.push("{ not json");
    await runPlanJob(p.owner, queued.id);
    expect(await proposal(queued.id)).toMatchObject({ status: "failed", errorCode: "AGENT_OUTPUT_INVALID", plan: null });
    const next = await p.run((tx) => retryPlan(tx, p.editor, queued.id));
    expect(next).toMatchObject({ status: "queued", revision: 2, requestText: "Plan with a broken answer" });
    // A viewer may not plan again.
    const other = await request("Plan for the viewer check", "viewer-1");
    mocked.replies.push(refusal(429, "rate_limit_error", "rate limited"));
    await runPlanJob(p.owner, other.id);
    expect(await failure(p.run((tx) => retryPlan(tx, p.viewer, other.id)))).not.toBe("resolved");
  });

  it("refuses a retry without budget before anything is queued", async () => {
    const queued = await request("Plan without budget later", "budget-1");
    mocked.replies.push(refusal(429, "rate_limit_error", "rate limited"));
    await runPlanJob(p.owner, queued.id);
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) => savePmSettings(tx, p.owner, { ...current.settings, dailyCeilingMicros: 0 }, current.version));
    try {
      expect(await failure(p.run((tx) => retryPlan(tx, p.editor, queued.id)))).toBe("WORK_PM_BUDGET_EXHAUSTED");
      expect(await proposal(queued.id)).toMatchObject({ status: "failed" });
    } finally {
      const now = await p.run((tx) => readPmSettings(tx, p.owner));
      await p.run((tx) => savePmSettings(tx, p.owner, { ...now.settings, dailyCeilingMicros: current.settings.dailyCeilingMicros }, now.version));
    }
  });

  it("fails a run whose requester left without calling the model", async () => {
    const queued = await request("Plan of someone who leaves", "gone-1");
    await p.run((tx) => tx.workPlanProposal.update({ where: { id: queued.id }, data: { requestedBy: "00000000-0000-4000-8000-0000000000aa" } }));
    await runPlanJob(p.owner, queued.id);
    expect(await proposal(queued.id)).toMatchObject({ status: "failed", errorCode: "WORK_PM_REQUESTER_GONE" });
    expect(mocked.calls).toBe(0);
  });
});

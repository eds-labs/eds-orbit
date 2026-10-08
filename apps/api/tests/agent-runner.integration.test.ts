import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { APIError } from "openai";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { policy as policySchema } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { planAssignmentRuns } from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { markTransmitted, reserve } from "../src/modules/budget.ts";
import { defineTool } from "../src/modules/agents/tools/registry.ts";
import {
  registerSpecialist,
  registerStepHandler,
  runAgentTask,
} from "../src/modules/agents/specialists/runner.ts";
import type { Specialist } from "../src/modules/agents/specialists/types.ts";
import { createPackageProject, X } from "./support/package-project.ts";

type Reply = { output: unknown[]; costMicros?: number };
const mocked = vi.hoisted(() => ({
  requests: [] as any[],
  replies: [] as Array<(request: any) => Promise<Reply> | Reply>,
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.requests.push(structuredClone(request));
    const next = mocked.replies.shift();
    if (!next) throw new Error("NO_RECORDED_REPLY");
    const reply = await next(request);
    return {
      output: reply.output,
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: reply.costMicros ?? 7,
      },
      responseId: `resp_${mocked.requests.length}`,
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// 06:00 in Berlin; the run for 10:00 is due (lead 360 minutes).
const MORNING = new Date("2026-10-20T04:00:00Z");

const message = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const lookupCall = (q: string, callId = "call-1") => ({
  type: "function_call",
  call_id: callId,
  name: "echo_lookup",
  arguments: JSON.stringify({ q }),
});
const webSearch = (id: string) => ({
  type: "web_search_call",
  id,
  status: "completed",
  action: { type: "search", query: "beta" },
});

const lookup = defineTool({
  name: "echo_lookup",
  namespace: "research",
  description: "Looks up a word for the echo specialist.",
  parameters: z.object({ q: z.string() }),
  risk: "R0_read",
  roles: ["owner", "editor", "viewer"],
  deferLoading: false,
  async execute(_context, args) {
    return { output: { found: (args as { q: string }).q }, cards: [] };
  },
});

/** The test-only specialist: answers `{ text }`, optionally after a lookup. */
const echo = (
  role: Specialist["role"],
  changes: Partial<Specialist> = {},
): Specialist => ({
  role,
  taskClass: role === "analytics" ? "agent_analytics" : "agent_research",
  instructions: "Echo the step you were given.",
  tools: [lookup],
  hostedTools: [],
  outputSchema: z.object({ text: z.string() }),
  limits: {
    maxModelCalls: 4,
    maxToolCalls: 6,
    maxWebSearches: 3,
    timeoutMs: 120_000,
  },
  ...changes,
});

describe.skipIf(!enabled)("Specialist runner", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const makeAssignment = () => {
    const content = {
      name: "Daily product post",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X],
      topicFrame: "Short updates about beta access for product teams",
      image: false,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
      status: "active",
      actionRequestId: null,
    };
    return run((tx) =>
      create(tx, project.owner, "assignments", {
        ...content,
        confirmation: {
          userId: "owner",
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(content),
        },
      }),
    );
  };
  const tasks = () =>
    run((tx) => list(tx, project.owner, "agent_tasks")).then((rows) =>
      rows.map((row): Record<string, any> => ({ id: row.id, ...data(row) })),
    );
  const task = async (stepKey: string) =>
    (await tasks()).find((t) => t.stepKey === stepKey)!;
  const runRow = async () =>
    data((await run((tx) => list(tx, project.owner, "assignment_runs")))[0]!);
  const agentJobs = async () =>
    (await run((tx) => list(tx, project.owner, "jobs")))
      .map((row) => data(row))
      .filter((job) => job.topic === "agent");
  const reservations = (taskId: string) =>
    run((tx) =>
      tx.budgetReservation.findMany({
        where: {
          projectId: project.owner.projectId,
          key: { startsWith: `${project.owner.projectId}:agent:${taskId}:` },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  const month = () => new Date().toISOString().slice(0, 7);
  let assignmentId = "";

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    mocked.requests = [];
    mocked.replies = [];
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    assignmentId = (await makeAssignment()).id;
    registerSpecialist(echo("analytics"));
    registerSpecialist(echo("research"));
    // The plan for a social assignment starts with analytics and research.
    await run((tx) => planAssignmentRuns(tx, project.owner, MORNING));
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("runs one specialist turn and stores its structured output", async () => {
    const research = await task("research");
    mocked.replies.push(() => ({ output: [message('{"text":"hello"}')] }));
    await runAgentTask(worker(), research.id);

    expect(await task("research")).toMatchObject({
      status: "done",
      output: { text: "hello" },
      errorCode: null,
      costMicros: 7,
      input: {
        step: { key: "research", role: "research" },
        assignment: {
          id: assignmentId,
          topicFrame: "Short updates about beta access for product teams",
          channels: [X],
        },
        run: { date: "2026-10-20" },
      },
    });
    const [request] = mocked.requests;
    expect(request.route).toEqual({
      model: "synthetic-model",
      maxOutputTokens: 1800,
    });
    expect(request.instructions).toContain("Echo the step you were given.");
    expect(request.tools.map((tool: any) => tool.name)).toEqual([
      "echo_lookup",
    ]);
    expect(request.outputSchema).toMatchObject({
      type: "object",
      required: ["text"],
      additionalProperties: false,
    });
    expect(request.reservationId).toBeTruthy();
    const agentRun = await run((tx) =>
      tx.agentRun.findFirstOrThrow({
        where: { projectId: project.owner.projectId, subjectId: research.id },
        include: { spans: true },
      }),
    );
    expect(agentRun).toMatchObject({
      kind: "agent",
      agentName: "orbit_research",
      taskClass: "agent_research",
      subjectType: "agent_task",
      status: "succeeded",
    });
    expect(agentRun.spans).toMatchObject([
      { type: "model_call", status: "succeeded", model: "synthetic-model" },
    ]);
    // Analytics still runs, so the strategy waits.
    expect((await tasks()).map((t) => t.stepKey).sort()).toEqual([
      "analytics",
      "research",
    ]);
    expect((await runRow()).steps).toMatchObject([
      { key: "analytics", status: "queued" },
      { key: "research", status: "done" },
      { key: "strategy", status: "pending" },
      { key: `copywriter:${X}`, status: "pending" },
      { key: "review", status: "pending" },
    ]);

    // A finished task is final: its job running again calls nothing.
    await runAgentTask(worker(), research.id);
    expect(mocked.requests).toHaveLength(1);

    mocked.replies.push(() => ({ output: [message('{"text":"figures"}')] }));
    await runAgentTask(worker(), (await task("analytics")).id);
    const strategy = await task("strategy");
    expect(strategy).toMatchObject({
      role: "strategy",
      status: "queued",
      assignmentId,
    });
    expect((await agentJobs()).map((job) => job.idempotencyKey)).toContain(
      `agent:${strategy.id}`,
    );
    expect((await runRow()).costMicros).toBe(14);

    // No strategy specialist is registered in this test: the task fails by name.
    await runAgentTask(worker(), strategy.id);
    expect(await task("strategy")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_ROLE_UNAVAILABLE",
      costMicros: 0,
    });
    expect(mocked.requests).toHaveLength(2);
    // Its dependents drop, the run ends without a deliverable.
    expect(await runRow()).toMatchObject({ status: "partial" });
  });

  it("runs a registered step handler and stores what it returns", async () => {
    registerStepHandler("research", async (_scope, t) => ({
      handled: t.stepKey,
    }));
    try {
      await runAgentTask(worker(), (await task("research")).id);
      expect(await task("research")).toMatchObject({
        status: "done",
        output: { handled: "research" },
      });
      expect(mocked.requests).toHaveLength(0);
    } finally {
      registerSpecialist(echo("research"));
    }
  });

  it("reserves before and settles after every model call under the assignment run key", async () => {
    const research = await task("research");
    const states: string[] = [];
    const current = async () =>
      (await reservations(research.id)).map((r) => r.state);
    mocked.replies.push(async () => {
      states.push(...(await current()));
      return { output: [lookupCall("beta")] };
    });
    mocked.replies.push(async () => {
      states.push(...(await current()));
      return { output: [message('{"text":"found beta"}')], costMicros: 9 };
    });
    await runAgentTask(worker(), research.id);

    // Each call was reserved and in flight before it went out; the first was settled before the second.
    expect(states).toEqual(["in_flight", "settled", "in_flight"]);
    const rows = await reservations(research.id);
    expect(
      rows.map((r) => ({
        key: r.key,
        category: r.category,
        state: r.state,
        settled: Number(r.settledMicros),
        taskClass: r.taskClass,
        model: r.model,
      })),
    ).toEqual(
      [0, 1].map((n) => ({
        key: `${project.owner.projectId}:agent:${research.id}:${n}`,
        category: "agent_text",
        state: "settled",
        settled: n === 0 ? 7 : 9,
        taskClass: "agent_research",
        model: "synthetic-model",
      })),
    );
    expect(rows.every((r) => r.agentRunId)).toBe(true);
    const budgetRun = (
      await run((tx) => list(tx, project.owner, "budget_runs"))
    ).find(
      (row) => data(row).runKey === `assignment:${assignmentId}:${month()}`,
    );
    expect(data(budgetRun!).reservationIds).toEqual(rows.map((r) => r.id));
    // The tool result went back to the model in the second call.
    expect(mocked.requests[1].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ found: "beta" }),
    });
    expect(await task("research")).toMatchObject({
      status: "done",
      output: { text: "found beta" },
      costMicros: 16,
    });
    expect((await runRow()).costMicros).toBe(16);
  });

  it("marks an interrupted paid call outcome_unknown and never repeats it", async () => {
    const research = await task("research");
    mocked.replies.push(() => {
      throw new Error("socket hang up");
    });
    await runAgentTask(worker(), research.id);
    expect(await task("research")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "AGENT_OUTCOME_UNKNOWN",
    });
    expect((await reservations(research.id)).map((r) => r.state)).toEqual([
      "unknown",
    ]);
    await runAgentTask(worker(), research.id);
    expect(mocked.requests).toHaveLength(1);
    // The step counts as failed; the strategy waits only for analytics.
    expect((await runRow()).steps[1]).toMatchObject({
      key: "research",
      status: "failed",
    });

    // A worker that crashed after transmitting leaves the task running with a call in flight.
    const analytics = await task("analytics");
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "agent_tasks", analytics.id);
      await update(tx, project.owner, row, {
        ...data(row),
        status: "running",
      });
      const active = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      const approved = policySchema.parse(
        Object.fromEntries(
          Object.entries(data(active)).filter(
            ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
          ),
        ),
      );
      const reservation = await reserve(
        tx,
        project.owner,
        `agent:${analytics.id}:0`,
        "agent_text",
        5,
        approved,
        new Date(),
        `assignment:${assignmentId}:${month()}`,
      );
      await markTransmitted(tx, project.owner, reservation.id);
    });
    await runAgentTask(worker(), analytics.id);
    expect(mocked.requests).toHaveLength(1);
    expect(await task("analytics")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "AGENT_OUTCOME_UNKNOWN",
    });
    expect((await reservations(analytics.id)).map((r) => r.state)).toEqual([
      "unknown",
    ]);
    // Both inputs are settled: the strategy starts with what exists.
    expect(await task("strategy")).toMatchObject({ status: "queued" });
  });

  it("settles a request the provider refused at zero and fails without retry", async () => {
    const research = await task("research");
    mocked.replies.push(() => {
      throw new APIError(429, { message: "rate limited" }, "rate", undefined);
    });
    await runAgentTask(worker(), research.id);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "MODEL_REQUEST_NOT_ACCEPTED",
      costMicros: 0,
    });
    expect(
      (await reservations(research.id)).map((r) => [
        r.state,
        Number(r.settledMicros),
      ]),
    ).toEqual([["settled", 0]]);
    await runAgentTask(worker(), research.id);
    expect(mocked.requests).toHaveLength(1);
  });

  it("fails a task that exceeds its limits with AGENT_LIMIT and continues the run", async () => {
    // One model call only, but the model asks for a tool.
    registerSpecialist(
      echo("research", {
        limits: {
          maxModelCalls: 1,
          maxToolCalls: 6,
          maxWebSearches: 3,
          timeoutMs: 120_000,
        },
      }),
    );
    // One web search allowed, the model ran two.
    registerSpecialist(
      echo("analytics", {
        hostedTools: [{ type: "web_search" }],
        limits: {
          maxModelCalls: 4,
          maxToolCalls: 6,
          maxWebSearches: 1,
          timeoutMs: 120_000,
        },
      }),
    );
    try {
      mocked.replies.push(() => ({ output: [lookupCall("beta")] }));
      await runAgentTask(worker(), (await task("research")).id);
      expect(await task("research")).toMatchObject({
        status: "failed",
        errorCode: "AGENT_LIMIT",
        costMicros: 7,
      });

      mocked.replies.push(() => ({
        output: [webSearch("ws1"), webSearch("ws2"), message('{"text":"x"}')],
      }));
      await runAgentTask(worker(), (await task("analytics")).id);
      expect(mocked.requests[1].tools).toContainEqual({ type: "web_search" });
      expect(await task("analytics")).toMatchObject({
        status: "failed",
        errorCode: "AGENT_LIMIT",
        costMicros: 7,
      });
      // Both optional inputs dropped: the strategy still starts.
      expect(await task("strategy")).toMatchObject({ status: "queued" });
      expect(await runRow()).toMatchObject({
        status: "running",
        costMicros: 14,
      });
    } finally {
      registerSpecialist(echo("research"));
      registerSpecialist(echo("analytics"));
    }
  });

  it("stops the run when the assignment budget is exhausted", async () => {
    // Prior spend of this assignment this month leaves less than one call.
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", assignmentId);
      await update(tx, project.owner, row, {
        ...data(row),
        monthlyBudgetMicros: 1,
      });
    });
    const research = await task("research");
    const analytics = await task("analytics");
    await runAgentTask(worker(), research.id);
    expect(mocked.requests).toHaveLength(0);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "ASSIGNMENT_BUDGET_EXHAUSTED",
      costMicros: 0,
    });
    const assignment = await run((tx) =>
      entity(tx, project.owner, "assignments", assignmentId),
    );
    expect(data(assignment).status).toBe("budget_exhausted");
    const exceptions = await run((tx) => list(tx, project.owner, "exceptions"));
    expect(
      exceptions.map((row) => data(row)).filter((e) => e.status === "open"),
    ).toContainEqual(
      expect.objectContaining({
        code: "ASSIGNMENT_BUDGET_EXHAUSTED",
        resourceIds: [assignmentId],
      }),
    );
    expect(await runRow()).toMatchObject({ status: "canceled" });
    expect(await task("analytics")).toMatchObject({ status: "canceled" });
    // The canceled task's job does nothing, and no further step was enqueued.
    await runAgentTask(worker(), analytics.id);
    expect(mocked.requests).toHaveLength(0);
    expect((await tasks()).map((t) => t.stepKey).sort()).toEqual([
      "analytics",
      "research",
    ]);
    expect(await agentJobs()).toHaveLength(2);
  });

  it("treats a project budget refusal as an exhausted assignment", async () => {
    await setPolicy({ dailyBudgetMicros: 1 });
    await runAgentTask(worker(), (await task("research")).id);
    expect(mocked.requests).toHaveLength(0);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "ASSIGNMENT_BUDGET_EXHAUSTED",
    });
    const assignment = await run((tx) =>
      entity(tx, project.owner, "assignments", assignmentId),
    );
    expect(data(assignment).status).toBe("budget_exhausted");
  });

  it("refuses an output that does not match the schema with AGENT_OUTPUT_INVALID (cost settled)", async () => {
    const research = await task("research");
    mocked.replies.push(() => ({ output: [message('{"wrong":1}')] }));
    await runAgentTask(worker(), research.id);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_OUTPUT_INVALID",
      output: null,
      costMicros: 7,
    });
    expect(
      (await reservations(research.id)).map((r) => [
        r.state,
        Number(r.settledMicros),
      ]),
    ).toEqual([["settled", 7]]);
    expect((await runRow()).costMicros).toBe(7);
  });
});

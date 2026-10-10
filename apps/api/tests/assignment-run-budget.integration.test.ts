import { randomUUID } from "node:crypto";
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
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { policy as policySchema } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { reserve } from "../src/modules/budget.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import {
  planAssignmentRuns,
  REQUIRED_RESERVE_SHARE,
} from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { analyticsSpecialist } from "../src/modules/agents/specialists/analytics.ts";
import { researchSpecialist } from "../src/modules/agents/specialists/research.ts";
import {
  assertTaskBudget,
  registerSpecialist,
  runAgentTask,
  runBudgetKey,
  runSpend,
} from "../src/modules/agents/specialists/runner.ts";
import type { Specialist } from "../src/modules/agents/specialists/types.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

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
// 04:00 in Berlin on 2026-10-20 (UTC+2): the run for 10:00 and 17:00 is due (lead 360 minutes).
const PLAN_AT = new Date("2026-10-20T02:00:00Z");
const SOL = "gpt-6.1-sol";
// 10 USD a month, one run a day.
const MONTHLY = 10_000_000;
const RUN_CEILING = Math.floor(MONTHLY / 30);
// Shares of the fixed per-step split before R75 (weights 10/20/15 of 120).
const OLD_SHARE = {
  analytics: Math.floor((RUN_CEILING * 10) / 120),
  research: Math.floor((RUN_CEILING * 20) / 120),
  strategy: Math.floor((RUN_CEILING * 15) / 120),
};

const message = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

/**
 * A strategy that answers at once. Its instructions stand in for the size of
 * a production strategy input (facts, channel history, analytics and research
 * findings), about 14 KB.
 */
const strategy: Specialist = {
  role: "strategy",
  taskClass: "agent_strategy",
  instructions: `Answer with the step you were given. ${"Context. ".repeat(1_400)}`,
  tools: [],
  hostedTools: [],
  outputSchema: z.object({ text: z.string() }),
  limits: {
    maxModelCalls: 4,
    maxToolCalls: 6,
    maxWebSearches: 0,
    timeoutMs: 120_000,
  },
};

describe.skipIf(!enabled)("Run budget pool of an assignment (R75)", () => {
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
  const approvedPolicy = (tx: DbTx) =>
    list(tx, project.owner, "policies").then((rows) => {
      const row = rows.find((p) => data(p).active === true)!;
      return policySchema.parse(
        Object.fromEntries(
          Object.entries(data(row)).filter(
            ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
          ),
        ),
      );
    });
  const tasks = () =>
    run((tx) => list(tx, project.owner, "agent_tasks")).then((rows) =>
      rows.map((row): Record<string, any> => ({ id: row.id, ...data(row) })),
    );
  const task = async (stepKey: string) =>
    (await tasks()).find((t) => t.stepKey === stepKey)!;
  const runRow = async () => {
    const row = (
      await run((tx) => list(tx, project.owner, "assignment_runs"))
    )[0]!;
    return { id: row.id, ...data(row) } as Record<string, any>;
  };
  const reservationsOf = (taskId: string) =>
    run((tx) =>
      tx.budgetReservation.findMany({
        where: {
          projectId: project.owner.projectId,
          key: { startsWith: `${project.owner.projectId}:agent:${taskId}:` },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  /** Holds `amount` under the run's budget key, as another step of the run would. */
  const holdInRun = (runId: string, amount: number, state = "reserved") =>
    run(async (tx) => {
      const row = await reserve(
        tx,
        project.owner,
        `agent:${randomUUID()}:0`,
        "agent_text",
        amount,
        await approvedPolicy(tx),
        new Date(),
        runBudgetKey(runId),
      );
      if (state === "settled")
        await tx.budgetReservation.update({
          where: { id: row.id },
          data: { state: "settled", settledMicros: BigInt(amount) },
        });
      return row;
    });
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
      perRunBudgetMicros: 5_000_000,
      dailyBudgetMicros: 10_000_000,
    });
    // The production route and prices (route version 8, rate card of 2026-10-02):
    // every agent task class on gpt-6.1-sol with the default 1,800 output tokens.
    await run((tx) =>
      saveOpenAiConfiguration(tx, project.owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: [SOL, "text-embedding-3-small", IMAGE_MODEL],
        rateCard: {
          [SOL]: {
            inputMicrosPerMillion: 2_000_000,
            cachedInputMicrosPerMillion: 100_000,
            cacheWriteMicrosPerMillion: 2_500_000,
            outputMicrosPerMillion: 10_000_000,
            verifiedAt: new Date().toISOString(),
          },
          "text-embedding-3-small": {
            inputMicrosPerMillion: 20_000,
            outputMicrosPerMillion: 0,
            verifiedAt: new Date().toISOString(),
          },
        },
        modelRoutes: {
          fast: SOL,
          standard: SOL,
          quality: SOL,
          escalation: SOL,
        },
        taskRoutes: {
          draft_social: {
            model: SOL,
            reasoningEffort: "low",
            maxOutputTokens: 3000,
          },
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: 50_000,
          pricingVerifiedAt: new Date().toISOString(),
        },
      }),
    );
    // Mario's first assignment: daily 10:00 and 17:00, X and Telegram, with an image, 10 USD a month.
    const content = {
      name: "uLiquid Beta",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X, TELEGRAM],
      topicFrame: "Short updates about beta access for product teams",
      image: true,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: MONTHLY,
      status: "active",
      actionRequestId: null,
    };
    assignmentId = (
      await run((tx) =>
        create(tx, project.owner, "assignments", {
          ...content,
          confirmation: {
            userId: "owner",
            at: "2026-10-01T00:00:00.000Z",
            assignmentHash: assignmentHash(content),
          },
        }),
      )
    ).id;
    registerSpecialist(analyticsSpecialist);
    registerSpecialist(researchSpecialist);
    registerSpecialist(strategy);
    expect(
      await run((tx) => planAssignmentRuns(tx, project.owner, PLAN_AT)),
    ).toEqual({ created: 1 });
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("lets analytics, research and strategy spend from the run pool beyond their old fixed shares", async () => {
    const planned = await runRow();
    expect(planned.ceilingMicros).toBe(RUN_CEILING);
    expect(planned.slots).toHaveLength(4);

    mocked.replies.push(() => ({
      output: [
        message(
          JSON.stringify({
            period: { from: "2026-09-20", to: "2026-10-19" },
            findings: [],
            noData: true,
          }),
        ),
      ],
    }));
    await runAgentTask(worker(), (await task("analytics")).id);
    expect(await task("analytics")).toMatchObject({ status: "done" });

    mocked.replies.push(() => ({ output: [message('{"findings":[]}')] }));
    await runAgentTask(worker(), (await task("research")).id);
    expect(await task("research")).toMatchObject({ status: "done" });
    // Research is offered the hosted search with its full allowance.
    expect(mocked.requests[1].tools).toContainEqual({ type: "web_search" });

    mocked.replies.push(() => ({ output: [message('{"text":"plan"}')] }));
    await runAgentTask(worker(), (await task("strategy")).id);
    expect(await task("strategy")).toMatchObject({ status: "done" });

    // Each worst-case reservation was larger than the step's old fixed share.
    const reserved = async (stepKey: string) =>
      Number((await reservationsOf((await task(stepKey)).id))[0]!.amountMicros);
    for (const stepKey of ["analytics", "research", "strategy"] as const) {
      expect(await reserved(stepKey)).toBeGreaterThan(OLD_SHARE[stepKey]);
      expect(await reserved(stepKey)).toBeLessThan(RUN_CEILING);
    }
    // The run goes on with copywriters and the visual.
    const steps = new Map(
      ((await runRow()).steps as any[]).map((step) => [step.key, step.status]),
    );
    expect(steps.get(`copywriter:${X}`)).toBe("queued");
    expect(steps.get(`copywriter:${TELEGRAM}`)).toBe("queued");
    expect(steps.get("visual")).toBe("queued");
  });

  it("refuses a step whose estimate exceeds what is left of the run pool", async () => {
    const planned = await runRow();
    // Earlier steps hold all but 20,000 micros of the run.
    await holdInRun(planned.id, RUN_CEILING - 20_000, "settled");
    for (const stepKey of ["analytics", "research", "strategy"]) {
      await runAgentTask(worker(), (await task(stepKey)).id);
      expect(await task(stepKey)).toMatchObject({
        status: "failed",
        errorCode: "AGENT_LIMIT",
        costMicros: 0,
      });
    }
    expect(mocked.requests).toHaveLength(0);
    expect(await reservationsOf((await task("strategy")).id)).toEqual([]);
  });

  it("keeps the sum of the run's reservations within its ceiling across steps", async () => {
    const planned = await runRow();
    const step = (stepKey: string) => ({
      id: randomUUID(),
      assignmentId,
      runId: planned.id,
      stepKey,
    });
    // Copywriters, visual and review reserve 90,000 each until the pool is used up.
    const keys = [
      `copywriter:${X}`,
      `copywriter:${TELEGRAM}`,
      "visual",
      "review",
      "review",
    ];
    const outcomes: string[] = [];
    for (const key of keys)
      outcomes.push(
        await run(async (tx) => {
          const t = step(key);
          await assertTaskBudget(tx, project.owner, t, 90_000);
          await reserve(
            tx,
            project.owner,
            `agent:${t.id}:0`,
            "agent_text",
            90_000,
            await approvedPolicy(tx),
            new Date(),
            runBudgetKey(planned.id),
          );
          return "reserved";
        }).catch((error) => String(error.code)),
      );
    expect(outcomes).toEqual([
      "reserved",
      "reserved",
      "reserved",
      "AGENT_LIMIT",
      "AGENT_LIMIT",
    ]);
    // Two steps of the run reserving at the same time: the assignment lock lets only one fit.
    const left = RUN_CEILING - 3 * 90_000;
    const parallel = await Promise.allSettled(
      [`copywriter:${X}`, "review"].map((key) =>
        run(async (tx) => {
          const t = step(key);
          await assertTaskBudget(tx, project.owner, t, left);
          await reserve(
            tx,
            project.owner,
            `agent:${t.id}:0`,
            "agent_text",
            left,
            await approvedPolicy(tx),
            new Date(),
            runBudgetKey(planned.id),
          );
        }),
      ),
    );
    expect(parallel.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await run((tx) => runSpend(tx, project.owner, planned.id))).toBe(
      RUN_CEILING,
    );
  });

  it("keeps the required steps' reserve away from analytics and research", async () => {
    const planned = await runRow();
    const reserve40 = Math.ceil(RUN_CEILING * REQUIRED_RESERVE_SHARE);
    const optionalLeft = RUN_CEILING - reserve40;
    const check = (stepKey: string, estimate: number) =>
      run((tx) =>
        assertTaskBudget(
          tx,
          project.owner,
          { id: randomUUID(), assignmentId, runId: planned.id, stepKey },
          estimate,
        ),
      )
        .then(() => "ok")
        .catch((error) => String(error.code));
    expect(await check("research", optionalLeft)).toBe("ok");
    expect(await check("research", optionalLeft + 1)).toBe("AGENT_LIMIT");
    expect(await check("analytics", optionalLeft + 1)).toBe("AGENT_LIMIT");
    // A required step may use the reserve.
    expect(await check("strategy", optionalLeft + 1)).toBe("ok");
    // What the optional steps already hold counts against their part.
    await holdInRun(planned.id, 100_000);
    expect(await check("research", optionalLeft - 100_000)).toBe("ok");
    expect(await check("research", optionalLeft - 100_000 + 1)).toBe(
      "AGENT_LIMIT",
    );
    expect(await check("strategy", RUN_CEILING - 100_000)).toBe("ok");
    expect(await check("strategy", RUN_CEILING - 100_000 + 1)).toBe(
      "AGENT_LIMIT",
    );
  });

  it("still refuses on the assignment's month and the project's budgets", async () => {
    // The month: earlier runs of this month used all but 1,000 micros.
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", assignmentId);
      const next = { ...data(row), monthlyBudgetMicros: 1_000 };
      await update(tx, project.owner, row, {
        ...next,
        confirmation: {
          ...data(row).confirmation,
          assignmentHash: assignmentHash(next),
        },
      });
    });
    await runAgentTask(worker(), (await task("analytics")).id);
    expect(mocked.requests).toHaveLength(0);
    expect(await task("analytics")).toMatchObject({
      status: "failed",
      errorCode: "ASSIGNMENT_BUDGET_EXHAUSTED",
    });
  });

  it("still refuses on the project's daily and per-run budgets", async () => {
    await setPolicy({ dailyBudgetMicros: 1_000 });
    await runAgentTask(worker(), (await task("analytics")).id);
    expect(await task("analytics")).toMatchObject({
      status: "failed",
      errorCode: "BUDGET_EXCEEDED",
    });
    await setPolicy({
      dailyBudgetMicros: 10_000_000,
      perRunBudgetMicros: 1_000,
    });
    await runAgentTask(worker(), (await task("research")).id);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "BUDGET_NOT_APPROVED",
    });
    expect(mocked.requests).toHaveLength(0);
  });
});

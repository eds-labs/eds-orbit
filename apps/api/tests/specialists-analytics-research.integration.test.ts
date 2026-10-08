import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, encrypt, list, update } from "../src/shared.ts";
import { planAssignmentRuns } from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { analyticsSpecialist } from "../src/modules/agents/specialists/analytics.ts";
import { researchSpecialist } from "../src/modules/agents/specialists/research.ts";
import { createPackageProject, X } from "./support/package-project.ts";

type Reply = { output: unknown[]; costMicros?: number };
const mocked = vi.hoisted(() => ({
  requests: [] as any[],
  replies: [] as Array<(request: any) => Promise<Reply> | Reply>,
  postiz: {
    getIntegrationAnalytics: vi.fn(),
    getPostAnalytics: vi.fn(),
  },
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
  embed: vi.fn(async () => ({
    vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
    usage: {
      model: "text-embedding-3-small",
      inputTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costMicros: 3,
    },
  })),
}));
vi.mock("../../../packages/connectors/src/index.ts", async (original) => ({
  ...(await original<
    typeof import("../../../packages/connectors/src/index.ts")
  >()),
  createPostizClient: vi.fn(() => mocked.postiz),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// 06:00 in Berlin; the run for 10:00 is due (lead 360 minutes).
const MORNING = new Date("2026-10-20T04:00:00Z");
const FEE = 10_000;

const message = (value: unknown) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const call = (name: string, args: unknown, callId = "call-1") => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const webSearch = (id: string) => ({
  type: "web_search_call",
  id,
  status: "completed",
  action: { type: "search", query: "beta" },
});
const output = (request: any, callId = "call-1") =>
  JSON.parse(
    request.input.find(
      (item: any) =>
        item.type === "function_call_output" && item.call_id === callId,
    ).output,
  );

describe.skipIf(!enabled)("Analytics and research specialists", () => {
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
  const count = (kind: string) =>
    run((tx) => list(tx, project.owner, kind)).then((rows) => rows.length);
  const reservations = (taskId: string) =>
    run((tx) =>
      tx.budgetReservation.findMany({
        where: {
          projectId: project.owner.projectId,
          OR: [
            {
              key: {
                startsWith: `${project.owner.projectId}:agent:${taskId}:`,
              },
            },
            {
              key: {
                startsWith: `${project.owner.projectId}:query:agent:${taskId}:`,
              },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  const metric = (day: string, changes: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "metrics", {
        source: "matomo",
        accountId: "conn:site:1:report:VisitsSummary.get:goal:all",
        reportFamily: "VisitsSummary.get",
        reportMethod: "VisitsSummary.get",
        campaign: "site:all",
        periodStart: `${day}T00:00:00.000Z`,
        periodEnd: `${day}T23:59:59.999Z`,
        sessions: 40,
        pageviews: 90,
        clicks: null,
        impressions: null,
        conversions: null,
        complete: true,
        providerFetchedAt: "2026-10-19T22:00:00.000Z",
        ...changes,
      }),
    );

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    mocked.requests = [];
    mocked.replies = [];
    mocked.postiz.getIntegrationAnalytics.mockReset();
    mocked.postiz.getPostAnalytics.mockReset();
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    await makeAssignment();
    registerAgentSpecialists();
    await run((tx) => planAssignmentRuns(tx, project.owner, MORNING));
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("registers both roles for the worker", () => {
    expect(analyticsSpecialist.tools.map((t) => t.name)).toEqual([
      "metrics_summary",
      "postiz_analytics",
      "channel_history",
    ]);
    expect(researchSpecialist.tools.map((t) => t.name)).toEqual([
      "knowledge_search",
    ]);
    expect(researchSpecialist.hostedTools).toEqual([{ type: "web_search" }]);
    expect(researchSpecialist.limits).toMatchObject({
      maxModelCalls: 4,
      maxToolCalls: 6,
      maxWebSearches: 3,
      timeoutMs: 120_000,
    });
  });

  it("reports noData honestly without measurements", async () => {
    const analytics = await task("analytics");
    mocked.replies.push(
      () => ({
        output: [
          call("metrics_summary", { from: "2026-09-19", to: "2026-10-19" }),
        ],
      }),
      () => ({
        output: [
          message({
            period: { from: "2026-09-19", to: "2026-10-19" },
            findings: [],
            noData: true,
          }),
        ],
      }),
    );
    await runAgentTask(worker(), analytics.id);

    expect(output(mocked.requests[1])).toMatchObject({
      period: { from: "2026-09-19", to: "2026-10-19" },
      measured: 0,
      noData: true,
      reports: [],
    });
    expect(await task("analytics")).toMatchObject({
      status: "done",
      output: {
        period: { from: "2026-09-19", to: "2026-10-19" },
        findings: [],
        noData: true,
      },
    });
    // The role is not offered to the chat: no web search, only its own tools.
    expect(mocked.requests[0].tools.map((t: any) => t.name)).toEqual([
      "metrics_summary",
      "postiz_analytics",
      "channel_history",
    ]);
  });

  it("rejects an analytics answer that mixes findings and noData", async () => {
    const analytics = await task("analytics");
    const period = { from: "2026-09-19", to: "2026-10-19" };
    mocked.replies.push(() => ({
      output: [message({ period, findings: [], noData: false })],
    }));
    await runAgentTask(worker(), analytics.id);
    expect(await task("analytics")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_OUTPUT_INVALID",
    });
  });

  it("summarizes Postiz and Matomo numbers with freshness", async () => {
    await metric("2026-10-17");
    await metric("2026-10-18", { sessions: 60, pageviews: 100 });
    // Another report has another denominator and is not added to the first.
    await metric("2026-10-18", {
      accountId: "conn:site:1:report:Actions.getPageUrls:page:abc",
      reportFamily: "Actions.getPageUrls",
      campaign: "https://example.invalid/beta",
      sessions: 5,
    });
    // Outside the period.
    await metric("2026-07-01", { sessions: 999 });
    await run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        baseUrl: "https://postiz.example/public/v1",
        encryptedCredential: encrypt(
          "synthetic-token",
          process.env.CREDENTIAL_KEY!,
        ),
      });
      await create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: "post-new",
        publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        state: "PUBLISHED",
        text: "Beta access is open",
        source: "orbit",
        syncedAt: new Date().toISOString(),
      });
      await create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: "post-queued",
        publishedAt: new Date(Date.now() + 86_400_000).toISOString(),
        state: "QUEUE",
        text: "Soon",
        source: "orbit",
        syncedAt: new Date().toISOString(),
      });
    });
    mocked.postiz.getIntegrationAnalytics.mockResolvedValue([
      {
        label: "Impressions",
        data: [
          { total: "120", date: "2026-10-17" },
          { total: 80, date: "2026-10-18" },
        ],
        percentageChange: 4,
      },
    ]);
    mocked.postiz.getPostAnalytics.mockResolvedValue([
      { label: "Likes", data: [{ total: 9, date: "2026-10-18" }] },
    ]);
    const analytics = await task("analytics");
    const period = { from: "2026-09-19", to: "2026-10-19" };
    const args = { channels: [X], postsPerChannel: 3 };
    mocked.replies.push(
      () => ({ output: [call("metrics_summary", period, "c1")] }),
      () => ({ output: [call("postiz_analytics", args, "c2")] }),
      // The model asks again: answered from the task's cache, no second request.
      () => ({ output: [call("postiz_analytics", args, "c3")] }),
      () => ({
        output: [
          message({
            period,
            noData: false,
            findings: [
              {
                statement: "The site had 100 sessions in the period.",
                metric: "sessions",
                value: 100,
                freshness: "2026-10-19T22:00:00.000Z",
              },
              {
                statement: "The channel had 200 impressions.",
                metric: "Impressions",
                value: 200,
                freshness: "2026-10-18",
              },
            ],
          }),
        ],
      }),
    );
    await runAgentTask(worker(), analytics.id);

    const metrics = output(mocked.requests[1], "c1");
    expect(metrics).toMatchObject({ measured: 3, noData: false });
    expect(metrics.reports).toEqual([
      expect.objectContaining({
        source: "matomo",
        report: "VisitsSummary.get",
        days: 2,
        sessions: 100,
        pageviews: 190,
        clicks: null,
        freshness: "2026-10-19T22:00:00.000Z",
        complete: true,
      }),
      expect.objectContaining({
        report: "Actions.getPageUrls",
        sessions: 5,
      }),
    ]);
    const postiz = output(mocked.requests[2], "c2");
    expect(postiz.channels).toHaveLength(1);
    expect(postiz.channels[0]).toMatchObject({
      channelId: X,
      channel: {
        measured: true,
        metrics: [
          {
            label: "Impressions",
            sum: 200,
            latest: { date: "2026-10-18", total: 80 },
            percentageChange: 4,
          },
        ],
      },
      posts: [
        {
          postId: "post-new",
          measured: true,
          metrics: [{ label: "Likes", sum: 9 }],
        },
      ],
    });
    expect(postiz.fetchedAt).toBeTruthy();
    expect(mocked.postiz.getIntegrationAnalytics).toHaveBeenCalledTimes(1);
    expect(mocked.postiz.getPostAnalytics).toHaveBeenCalledTimes(1);
    expect(mocked.postiz.getPostAnalytics).toHaveBeenCalledWith("post-new");
    expect(output(mocked.requests[3], "c3").channels).toEqual(postiz.channels);
    expect(await task("analytics")).toMatchObject({
      status: "done",
      output: {
        noData: false,
        findings: [
          { metric: "sessions", value: 100 },
          { metric: "Impressions", value: 200 },
        ],
      },
    });
  });

  it("refuses Postiz analytics for a channel that is not assigned", async () => {
    await run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        baseUrl: "https://postiz.example/public/v1",
        encryptedCredential: encrypt(
          "synthetic-token",
          process.env.CREDENTIAL_KEY!,
        ),
      });
    });
    const analytics = await task("analytics");
    mocked.replies.push(
      () => ({
        output: [
          call("postiz_analytics", {
            channels: ["foreign-channel"],
            postsPerChannel: null,
          }),
        ],
      }),
      () => ({
        output: [
          message({
            period: { from: "2026-09-19", to: "2026-10-19" },
            findings: [],
            noData: true,
          }),
        ],
      }),
    );
    await runAgentTask(worker(), analytics.id);
    expect(output(mocked.requests[1]).channels).toEqual([
      { channelId: "foreign-channel", error: "CHANNEL_NOT_ASSIGNED" },
    ]);
    expect(mocked.postiz.getIntegrationAnalytics).not.toHaveBeenCalled();
  });

  it("returns web findings with sources and stores no fact", async () => {
    const facts = await count("facts");
    const sources = await count("sources");
    const research = await task("research");
    const findings = [
      {
        claim: "Competitor opened a public beta this month.",
        sourceUrl: "https://news.example.com/beta",
        sourceTitle: "Beta opens",
        observedAt: "2026-10-18",
      },
    ];
    mocked.replies.push(() => ({
      output: [webSearch("ws1"), webSearch("ws2"), message({ findings })],
    }));
    await runAgentTask(worker(), research.id);

    const [request] = mocked.requests;
    expect(request.tools).toContainEqual({ type: "web_search" });
    // The provider is told how many searches remain.
    expect(request.maxToolCalls).toBe(3);
    expect(await task("research")).toMatchObject({
      status: "done",
      output: { findings },
      // 7 for the call and two searches at the per-search fee.
      costMicros: 7 + 2 * FEE,
    });
    const [reservation] = await reservations(research.id);
    // The estimate reserved all three possible searches.
    expect(Number(reservation!.amountMicros)).toBeGreaterThanOrEqual(3 * FEE);
    expect(Number(reservation!.settledMicros)).toBe(7 + 2 * FEE);
    // Findings stay on the task output.
    expect(await count("facts")).toBe(facts);
    expect(await count("sources")).toBe(sources);
  });

  it("rejects a finding without an https source", async () => {
    const research = await task("research");
    mocked.replies.push(() => ({
      output: [
        message({
          findings: [
            {
              claim: "x",
              sourceUrl: "http://news.example.com",
              sourceTitle: "x",
              observedAt: "2026-10-18",
            },
          ],
        }),
      ],
    }));
    await runAgentTask(worker(), research.id);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_OUTPUT_INVALID",
    });
  });

  it("stops at three web searches", async () => {
    const research = await task("research");
    const findings: unknown[] = [];
    mocked.replies.push(
      // Two searches, then a knowledge search for the same task.
      () => ({
        output: [
          webSearch("ws1"),
          webSearch("ws2"),
          call("knowledge_search", { query: "beta access", factKeys: null }),
        ],
      }),
      // One search left: the provider cap says so, the tool is still offered.
      (request) => {
        expect(request.maxToolCalls).toBe(1);
        expect(request.tools).toContainEqual({ type: "web_search" });
        return {
          output: [
            webSearch("ws3"),
            call(
              "knowledge_search",
              { query: "beta access", factKeys: null },
              "call-2",
            ),
          ],
        };
      },
      // None left: the search tool is gone and the provider cap is not sent.
      (request) => {
        expect(request.tools).not.toContainEqual({ type: "web_search" });
        expect(request.maxToolCalls).toBeUndefined();
        return { output: [message({ findings })] };
      },
    );
    await runAgentTask(worker(), research.id);

    expect(await task("research")).toMatchObject({ status: "done" });
    const rows = await reservations(research.id);
    expect(rows.map((row) => row.key.split(`${research.id}:`)[1])).toEqual([
      "0",
      "knowledge:1",
      "1",
      "knowledge:2",
      "2",
    ]);
    // Three searches, three model calls and two query embeddings.
    expect((await task("research")).costMicros).toBe(3 * 7 + 3 * FEE + 2 * 3);
  });

  it("fails with AGENT_LIMIT when the provider runs a fourth search and still pays for it", async () => {
    const research = await task("research");
    mocked.replies.push(() => ({
      output: [
        webSearch("ws1"),
        webSearch("ws2"),
        webSearch("ws3"),
        webSearch("ws4"),
        message({ findings: [] }),
      ],
    }));
    await runAgentTask(worker(), research.id);
    expect(await task("research")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_LIMIT",
      costMicros: 7 + 4 * FEE,
    });
  });

  it("reserves a specialist's knowledge search under the task and the run", async () => {
    const research = await task("research");
    mocked.replies.push(
      () => ({
        output: [
          call("knowledge_search", { query: "beta access", factKeys: null }),
        ],
      }),
      () => ({ output: [message({ findings: [] })] }),
    );
    await runAgentTask(worker(), research.id);

    expect(output(mocked.requests[1]).retrieval.mode).toBe("hybrid");
    const rows = await reservations(research.id);
    const query = rows.find((row) => row.category === "query_embedding")!;
    expect(query.key).toBe(
      `${project.owner.projectId}:query:agent:${research.id}:knowledge:1`,
    );
    expect(query.state).toBe("settled");
    const chat = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { key: { contains: `chat:${research.id}` } },
      }),
    );
    expect(chat).toEqual([]);
    const budgetRun = (
      await run((tx) => list(tx, project.owner, "budget_runs"))
    ).find((row) => data(row).runKey === `assignment-run:${research.runId}`);
    expect(data(budgetRun!).reservationIds).toContain(query.id);
    expect((await task("research")).costMicros).toBe(7 + 7 + 3);
  });
});

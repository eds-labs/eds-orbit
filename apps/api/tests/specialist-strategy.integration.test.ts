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
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { strategySpecialist } from "../src/modules/agents/specialists/strategy.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

type Reply = { output: unknown[]; costMicros?: number };
const mocked = vi.hoisted(() => ({
  requests: [] as any[],
  replies: [] as Array<(request: any) => Promise<Reply> | Reply>,
  // Postiz as the channel history sync reads it (C1).
  listPosts: null as null | ((range: any) => Promise<unknown[]>),
}));
vi.mock("../../../packages/connectors/src/index.ts", async (original) => {
  const actual =
    await original<
      typeof import("../../../packages/connectors/src/index.ts")
    >();
  return {
    ...actual,
    createPostizClient: (...args: any[]) =>
      mocked.listPosts
        ? { listPosts: mocked.listPosts }
        : (actual.createPostizClient as any)(...args),
  };
});
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

const message = (value: unknown, citations: string[] = []) => ({
  type: "message",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: JSON.stringify(value),
      annotations: citations.map((url) => ({
        type: "url_citation",
        url,
        title: "t",
        start_index: 0,
        end_index: 1,
      })),
    },
  ],
});
const DAY = 86_400_000;

describe.skipIf(!enabled)("Strategy specialist", () => {
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
      name: "Two posts a day",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
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
  // Analytics and research settle first; the strategy task exists once they have.
  const strategyTask = async (
    outputs: { analytics?: unknown; research?: unknown } = {},
  ) => {
    for (const role of ["analytics", "research"] as const) {
      const found = await task(role);
      await run(async (tx) => {
        const row = (await list(tx, project.owner, "agent_tasks")).find(
          (r) => r.id === found.id,
        )!;
        const output = outputs[role];
        await update(tx, project.owner, row, {
          ...data(row),
          status: output ? "done" : "failed",
          output: output ?? null,
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    return task("strategy");
  };
  const slots = async (): Promise<Array<{ channel: string; at: string }>> =>
    run(async (tx) => {
      const runs = await list(tx, project.owner, "assignment_runs");
      return data(runs[0]!).slots;
    });
  const post = (changes: Record<string, unknown>) =>
    run((tx) =>
      create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: `post-${Math.random()}`,
        publishedAt: new Date(Date.now() - DAY).toISOString(),
        state: "PUBLISHED",
        text: "A post",
        source: "orbit",
        syncedAt: new Date().toISOString(),
        ...changes,
      }),
    );
  const brief = (
    slot: { channel: string; at: string },
    changes: Record<string, unknown> = {},
  ) => ({
    channel: slot.channel,
    slotAt: slot.at,
    topic: "Beta access for product teams",
    angle: "Lead with what teams can do on day one.",
    factKeys: ["beta.access"],
    cta: "Join the beta.",
    imageIdea: null,
    notARepeatBecause: "Earlier posts announced the beta, this one shows use.",
    ...changes,
  });

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    mocked.requests = [];
    mocked.replies = [];
    mocked.listPosts = null;
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

  it("is a read-only specialist with the strategy route", () => {
    expect(strategySpecialist.role).toBe("strategy");
    expect(strategySpecialist.taskClass).toBe("agent_strategy");
    expect(strategySpecialist.tools.map((t) => t.name)).toEqual([
      "knowledge_search",
      "channel_history",
    ]);
    expect(strategySpecialist.hostedTools).toEqual([]);
    expect(strategySpecialist.limits.maxWebSearches).toBe(0);
  });

  it("syncs the channel history before the strategy, at most once an hour (C1)", async () => {
    const [first, second] = await slots();
    // A connected Postiz with a post another tool published yesterday.
    await run(async (tx) => {
      const row = (await list(tx, project.owner, "connectors")).find(
        (c) => data(c).provider === "postiz",
      )!;
      await update(tx, project.owner, row, {
        ...data(row),
        baseUrl: "https://postiz.example/public/v1",
        encryptedCredential: encrypt(
          "synthetic-postiz-token",
          process.env.CREDENTIAL_KEY!,
        ),
      });
    });
    const yesterday = new Date(Date.now() - DAY).toISOString();
    const listPosts = vi.fn(async (range: any) =>
      yesterday >= range.startDate && yesterday <= range.endDate
        ? [
            {
              id: "chatgpt-1",
              state: "PUBLISHED",
              publishDate: yesterday,
              integration: { id: X },
              content: "<p>Our ChatGPT job posted this.</p>",
            },
          ]
        : [],
    );
    mocked.listPosts = listPosts;
    mocked.replies.push(() => ({
      output: [message({ briefs: [brief(first!), brief(second!)] })],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);
    expect(await task("strategy")).toMatchObject({ status: "done" });
    // One sync: three Postiz reads (two history windows and the days ahead).
    expect(listPosts).toHaveBeenCalledTimes(3);
    const input = JSON.parse(mocked.requests[0].input[0].content);
    expect(input.channelHistory.channels).toEqual([
      {
        channelId: X,
        posts: [
          expect.objectContaining({
            source: "external",
            status: "published",
            text: "Our ChatGPT job posted this.",
          }),
        ],
      },
    ]);

    // The next day's run, within the same hour of real time: its strategy reads
    // the stored history without a new sync.
    const firstRunId = (await task("strategy")).runId;
    await run((tx) =>
      planAssignmentRuns(tx, project.owner, new Date(MORNING.valueOf() + DAY)),
    );
    const nextRun = (await tasks()).find((t) => t.runId !== firstRunId)!.runId;
    for (const role of ["analytics", "research"])
      await run(async (tx) => {
        const row = (await list(tx, project.owner, "agent_tasks")).find(
          (r) => data(r).runId === nextRun && data(r).stepKey === role,
        )!;
        await update(tx, project.owner, row, {
          ...data(row),
          status: "failed",
        });
        await startReadySteps(tx, project.owner, nextRun);
      });
    const nextStrategy = (await tasks()).find(
      (t) => t.runId === nextRun && t.stepKey === "strategy",
    )!;
    const nextSlots = data(
      (await run((tx) => list(tx, project.owner, "assignment_runs"))).find(
        (row) => row.id === nextRun,
      )!,
    ).slots as Array<{ channel: string; at: string }>;
    mocked.replies.push(() => ({
      output: [message({ briefs: nextSlots.map((slot) => brief(slot)) })],
    }));
    await runAgentTask(worker(), nextStrategy.id);
    expect((await tasks()).find((t) => t.id === nextStrategy.id)!.status).toBe(
      "done",
    );
    expect(listPosts).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(mocked.requests[1].input[0].content).channelHistory.channels,
    ).toHaveLength(1);
  });

  it("runs the strategy without fresh history when the sync fails (C1)", async () => {
    const [first, second] = await slots();
    // The connector has no credential: the sync fails, the strategy goes on.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocked.replies.push(() => ({
      output: [message({ briefs: [brief(first!), brief(second!)] })],
    }));
    try {
      await runAgentTask(worker(), (await strategyTask()).id);
      expect(await task("strategy")).toMatchObject({ status: "done" });
      // Logged by code only.
      expect(error).toHaveBeenCalledWith(
        "Orbit channel history sync failed",
        "POSTIZ_NOT_CONNECTED",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("writes one brief per slot with existing fact keys", async () => {
    const [first, second] = await slots();
    expect(first && second).toBeTruthy();
    // Research finished and is handed over as an unverified lead.
    const strategy = await strategyTask({
      research: {
        findings: [
          {
            claim: "A competitor opened a beta.",
            sourceUrl: "https://news.example.com/beta",
            sourceTitle: "Beta",
            observedAt: "2026-10-18",
          },
        ],
      },
    });
    const briefs = [
      brief(first!),
      brief(second!, {
        topic: "Product teams in the beta",
        factKeys: ["beta.access", "official.link"],
        imageIdea: "A calm dashboard.",
      }),
    ];
    mocked.replies.push(() => ({ output: [message({ briefs })] }));
    await runAgentTask(worker(), strategy.id);

    const stored = await task("strategy");
    expect(stored).toMatchObject({
      status: "done",
      output: { briefs, dropped: [], uncovered: [] },
    });
    const [request] = mocked.requests;
    const input = JSON.parse(request.input[0].content);
    // Only usable facts are offered: the expired one is not.
    expect(input.facts.map((f: any) => f.key).sort()).toEqual([
      "beta.access",
      "official.link",
    ]);
    expect(input.facts.find((f: any) => f.key === "beta.access").value).toBe(
      "open for product teams",
    );
    expect(input.run.slots).toEqual([first, second]);
    expect(input.inputs.research.findings).toHaveLength(1);
    expect(input.inputs.analytics).toBeNull();
    // Research may inspire, never become a claim.
    expect(request.instructions).toMatch(/never become claims/i);
  });

  it("drops a brief with an unknown fact key", async () => {
    const [first, second] = await slots();
    mocked.replies.push(() => ({
      output: [
        message({
          briefs: [
            brief(first!),
            brief(second!, { factKeys: ["beta.access", "made.up"] }),
          ],
        }),
      ],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);

    expect(await task("strategy")).toMatchObject({
      status: "done",
      output: {
        briefs: [brief(first!)],
        dropped: [
          {
            channel: second!.channel,
            slotAt: second!.at,
            code: "AGENT_UNKNOWN_FACT",
          },
        ],
        uncovered: [{ channel: second!.channel, slotAt: second!.at }],
      },
    });
  });

  it("drops a brief with an expired fact, no fact or a slot outside the run", async () => {
    const [first, second] = await slots();
    mocked.replies.push(() => ({
      output: [
        message({
          briefs: [
            brief(first!, { factKeys: ["launch.deadline"] }),
            brief(second!, { factKeys: [] }),
            brief(second!, { channel: TELEGRAM }),
            brief(second!, { slotAt: "2026-10-21T09:00:00.000Z" }),
          ],
        }),
      ],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);

    const output = (await task("strategy")).output;
    expect(output.briefs).toEqual([]);
    expect(output.dropped.map((d: any) => d.code)).toEqual([
      "AGENT_UNKNOWN_FACT",
      "AGENT_FACTS_REQUIRED",
      "AGENT_UNKNOWN_SLOT",
      "AGENT_UNKNOWN_SLOT",
    ]);
    expect(output.uncovered).toHaveLength(2);
  });

  it("keeps one brief per slot", async () => {
    const [first, second] = await slots();
    mocked.replies.push(() => ({
      output: [
        message({
          briefs: [
            brief(first!),
            brief(first!, { topic: "Another try" }),
            brief(second!),
          ],
        }),
      ],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);
    const output = (await task("strategy")).output;
    expect(output.briefs.map((b: any) => b.topic)).toEqual([
      "Beta access for product teams",
      "Beta access for product teams",
    ]);
    expect(output.dropped).toEqual([
      {
        channel: first!.channel,
        slotAt: first!.at,
        code: "AGENT_DUPLICATE_SLOT",
      },
    ]);
  });

  it("passes the last 14 days of channel history to the model", async () => {
    const [first, second] = await slots();
    await post({ remoteId: "orbit-new", text: "Orbit post about the beta" });
    await post({
      remoteId: "external-new",
      source: "external",
      publishedAt: new Date(Date.now() - 10 * DAY).toISOString(),
      text: "<b>External</b> job post".repeat(40),
    });
    await post({
      remoteId: "queued",
      state: "QUEUE",
      publishedAt: new Date(Date.now() + 2 * DAY).toISOString(),
      text: "Already queued",
    });
    await post({
      remoteId: "too-old",
      publishedAt: new Date(Date.now() - 20 * DAY).toISOString(),
      text: "Old news",
    });
    // Another channel of the project that the run does not use.
    await post({ remoteId: "other", channel: "li-int", text: "LinkedIn only" });
    mocked.replies.push(() => ({
      output: [message({ briefs: [brief(first!), brief(second!)] })],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);

    expect(await task("strategy")).toMatchObject({ status: "done" });
    const input = JSON.parse(mocked.requests[0].input[0].content);
    expect(input.channelHistory.days).toBe(14);
    const posts = input.channelHistory.channels.flatMap((c: any) => c.posts);
    expect(posts.map((p: any) => p.text.slice(0, 14))).toEqual([
      "Already queued",
      "Orbit post abo",
      expect.stringContaining("External"),
    ]);
    expect(posts.map((p: any) => [p.source, p.status])).toEqual([
      ["orbit", "scheduled"],
      ["orbit", "published"],
      ["external", "published"],
    ]);
    // Texts are truncated.
    expect(
      Math.max(...posts.map((p: any) => p.text.length)),
    ).toBeLessThanOrEqual(240);
    expect(JSON.stringify(input)).not.toContain("Old news");
    expect(JSON.stringify(input)).not.toContain("LinkedIn only");
    expect(input.channelHistory.channels[0].channelId).toBe(X);
  });

  it("stays within the context limit with a crowded history and fact base", async () => {
    const [first, second] = await slots();
    for (let i = 0; i < 40; i++)
      await post({
        remoteId: `bulk-${i}`,
        publishedAt: new Date(
          Date.now() - (i % 13) * DAY - i * 1000,
        ).toISOString(),
        text: "x".repeat(2000),
      });
    mocked.replies.push(() => ({
      output: [message({ briefs: [brief(first!), brief(second!)] })],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);
    expect(await task("strategy")).toMatchObject({ status: "done" });
    const input = JSON.parse(mocked.requests[0].input[0].content);
    const posts = input.channelHistory.channels.flatMap((c: any) => c.posts);
    expect(posts.length).toBeLessThanOrEqual(10);
  });

  it("offers the most relevant facts within a size budget and checks against all usable keys", async () => {
    const [first, second] = await slots();
    await run(async (tx) => {
      const beta = (await list(tx, project.owner, "facts")).find(
        (row) => data(row).key === "beta.access",
      )!;
      const base = {
        ...data(beta),
        valueType: "text",
        language: "en",
      };
      for (let i = 0; i < 40; i++)
        await create(tx, project.owner, "facts", {
          ...base,
          key: `filler.${String(i).padStart(2, "0")}`,
          value: `Filler statement ${i} `.padEnd(200, "lorem ipsum "),
        });
      // Relevant to the topic frame, but its key sorts after every filler.
      await create(tx, project.owner, "facts", {
        ...base,
        key: "zz.late",
        value: "Product teams get beta access in week one",
      });
    });
    mocked.replies.push(() => ({
      output: [
        message({
          briefs: [
            brief(first!, { factKeys: ["zz.late"] }),
            // A real usable key that was not offered is not unknown.
            brief(second!, { factKeys: ["filler.39"] }),
          ],
        }),
      ],
    }));
    await runAgentTask(worker(), (await strategyTask()).id);

    const input = JSON.parse(mocked.requests[0].input[0].content);
    const keys = input.facts.map((f: any) => f.key);
    // Ranked by overlap with the topic frame, then by key.
    expect(keys.slice(0, 2)).toEqual(["beta.access", "zz.late"]);
    expect(keys).not.toContain("filler.39");
    expect(keys.length).toBeLessThan(43);
    const size = input.facts.reduce(
      (sum: number, f: any) => sum + f.key.length + f.value.length,
      0,
    );
    expect(size).toBeGreaterThanOrEqual(6000);
    expect(size).toBeLessThan(6000 + 300);
    expect(await task("strategy")).toMatchObject({
      status: "done",
      output: {
        briefs: [
          brief(first!, { factKeys: ["zz.late"] }),
          brief(second!, { factKeys: ["filler.39"] }),
        ],
        dropped: [],
        uncovered: [],
      },
    });
  });
});

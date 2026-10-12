import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model call is a mock and GitHub is the in-memory fake; nothing here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  requests: [] as any[],
  replies: [] as Array<(request: any) => Reply | Promise<Reply>>,
  githubFetch: null as null | ((...args: any[]) => Promise<Response>),
}));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    respond: vi.fn(async (request: any) => {
      provider.requests.push(structuredClone(request));
      const next = provider.replies.shift();
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
        responseId: `resp_${provider.requests.length}`,
      };
    }),
  };
});
// The strategy's Postiz history sync reads an empty Postiz; the GitHub client talks to the fake.
vi.mock("../../../packages/connectors/src/index.ts", async (original) => {
  const actual =
    await original<
      typeof import("../../../packages/connectors/src/index.ts")
    >();
  return {
    ...actual,
    createPostizClient: () => ({ listPosts: async () => [] }),
    createGithubClient: (options: any) =>
      actual.createGithubClient({
        ...options,
        fetch: (...args: any[]) => provider.githubFetch!(...args),
      }),
  };
});
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { create, data, encrypt, entity, update } from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { deterministicProblems } from "../src/modules/agents/specialists/review.ts";
import { blogPostOf } from "../src/modules/blog-target.ts";
import { createPackageProject } from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";
import { fakeGithub, OWNER, REPO, TOKEN } from "./support/fake-github.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const TITLE = "Paper Trading Builds Confidence Before Real Orders";
const ARTICLE = {
  seoTitle: "Paper trading builds confidence before real orders",
  description:
    "Why practising strategies with paper trading helps traders review their decisions calmly.",
  excerpt:
    "Paper trading lets traders rehearse a plan, review it and keep every decision their own.",
  category: "Trading desk",
  keywords: ["paper trading", "trading desk", "strategy review"],
  relatedLinks: [
    { label: "Trading desk", href: "/features/trading-desk/" },
    {
      label: "Market intelligence",
      href: "/blog/market-intelligence-context-not-signal/",
    },
  ],
};
const SENTENCE =
  "Paper trading gives a calm place to rehearse a plan and to review each decision before any real order is placed. ";
const SECOND =
  "A written plan makes the later review easier, because every trade can be compared with what was intended at the start. ";
/** A body in the restricted format: six sections of about 220 words, the last with a closing list. */
const articleBody = (extra = "") =>
  Array.from({ length: 6 }, (_, index) => {
    const paragraph = SENTENCE.repeat(5).trim();
    const second = SECOND.repeat(5).trim();
    const list =
      index === 5
        ? "\n\n- Write the plan down first\n- Review every paper trade"
        : "";
    return `## Section ${index + 1} of the review\n\n${paragraph}\n\n${second}${index === 0 ? extra : ""}${list}`;
  }).join("\n\n");

/**
 * Website-ready blog articles (R82): a github_pr run's strategy reads the
 * published articles instead of the channel history, the copywriter writes
 * the article fields for the target profile, and its problems reach the review.
 */
describe.skipIf(!enabled)("Blog article generation for github_pr (R82)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let github = fakeGithub();
  let connectorId: string;
  let body: string;
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));

  /** A confirmed github_pr blog assignment, its planned run and a strategy task ready to run. */
  const strategyTask = async () => {
    await h.makeAssignment({
      name: "Weekly blog article",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
      contentType: "blog",
      channels: [connectorId],
      topicFrame: "Articles about paper trading for uLiquid Desk",
      delivery: "github_pr",
    });
    await h.run((tx) => planAssignmentRuns(tx, project.owner, tomorrow()));
    const research = await h.task("research");
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "agent_tasks", research.id);
      await update(tx, project.owner, row, {
        ...data(row),
        status: "failed",
        output: null,
      });
      await startReadySteps(tx, project.owner, data(row).runId);
    });
    const [run] = await h.rows("assignment_runs");
    return {
      task: await h.task("strategy"),
      slot: (run!.slots as Array<{ channel: string; at: string }>)[0]!,
    };
  };
  const strategyReply = (
    topic: string,
    slot: { channel: string; at: string },
  ) =>
    provider.replies.push(() => ({
      output: [
        message({
          briefs: [
            h.brief(slot, {
              topic,
              angle:
                "Search intent: learn to rehearse a plan. Keywords: paper trading. Outline: five sections.",
              notARepeatBecause: "No published article covers paper trading.",
            }),
          ],
        }),
      ],
    }));
  const tomorrow = () => {
    const today = new Date();
    return new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
        4,
      ),
    );
  };

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_BLOG_GITHUB = "true";
    provider.requests = [];
    provider.replies = [];
    github = fakeGithub();
    provider.githubFetch = (...args) => github.fetch(...(args as [any, any]));
    body = articleBody();
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const draft = generated(body);
      return params.article
        ? {
            ...draft,
            output: { ...draft.output, title: TITLE, article: ARTICLE },
          }
        : draft;
    });
    project = await createPackageProject();
    h = assignmentRun(project, tomorrow());
    const policy = (await h.rows("policies")).find((p) => p.active === true)!;
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      contentTypes: [...policy.contentTypes, "blog"],
    });
    connectorId = (
      await h.run((tx) =>
        create(tx, project.owner, "connectors", {
          provider: "github",
          owner: OWNER,
          repo: REPO,
          baseBranch: "main",
          postsPath: "content/blog/posts",
          siteUrl: "https://uliquid.vip",
          blogPathPrefix: "/blog/",
          profile: "uliquid-blog-json-v1",
          tokenExpiresAt: "2027-01-31",
          encryptedCredential: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
          status: "write_verified",
          capabilities: [],
        }),
      )
    ).id;
    registerAgentSpecialists();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_BLOG_GITHUB;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("gives the strategy the published articles instead of the channel history", async () => {
    const { task, slot } = await strategyTask();
    strategyReply("Paper trading builds confidence", slot);
    await runAgentTask(h.worker(), task.id);
    const input = JSON.parse(provider.requests[0]!.input[0].content);
    expect(input.channelHistory).toBeUndefined();
    expect(input.assignment.delivery).toBe("github_pr");
    expect(
      input.publishedArticles.map((a: { slug: string }) => a.slug).sort(),
    ).toEqual([
      "ai-assisted-trading-keeps-decisions-with-the-user",
      "market-intelligence-context-not-signal",
    ]);
    expect(input.publishedArticles[0]).toEqual({
      slug: expect.any(String),
      title: expect.any(String),
      category: expect.any(String),
      keywords: expect.any(Array),
      publishedAt: expect.any(String),
    });
    expect(provider.requests[0]!.instructions).toContain("publishedArticles");
    const done = await h.task("strategy");
    expect(done.status).toBe("done");
    expect(done.output.briefs).toHaveLength(1);
  });

  it("drops a brief whose slug is already published", async () => {
    const { task, slot } = await strategyTask();
    strategyReply("Market Intelligence: Context, Not Signal", slot);
    await runAgentTask(h.worker(), task.id);
    const done = await h.task("strategy");
    expect(done.output.briefs).toEqual([]);
    expect(done.output.dropped).toEqual([
      { channel: slot.channel, slotAt: slot.at, code: "BLOG_SLUG_EXISTS" },
    ]);
  });

  it("fails the strategy with BLOG_TARGET_UNREACHABLE instead of writing an unchecked brief", async () => {
    const { task } = await strategyTask();
    github = fakeGithub({ outage: 502 });
    await runAgentTask(h.worker(), task.id);
    const failed = await h.task("strategy");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("BLOG_TARGET_UNREACHABLE");
    // No model call was made for it.
    expect(provider.requests).toEqual([]);
  });

  it("writes the article for the target profile with the allowlist in the contract", async () => {
    const { task, slot } = await strategyTask();
    strategyReply("Paper trading builds confidence", slot);
    await runAgentTask(h.worker(), task.id);
    await runAgentTask(h.worker(), (await h.task("copywriter")).id);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.generate.mock.calls[0]![0].article).toBe(true);
    const [contract] = contracts();
    expect(contract.blogTarget).toEqual({
      profile: "uliquid-blog-json-v1",
      allowlist: expect.arrayContaining([
        "/platform/",
        "/features/trading-desk/",
        "/blog/market-intelligence-context-not-signal/",
        "/blog/ai-assisted-trading-keeps-decisions-with-the-user/",
      ]),
      publishedArticles: expect.arrayContaining([
        {
          slug: "market-intelligence-context-not-signal",
          title:
            "Market Intelligence Is Context, Not a Signal: A Better Review Workflow",
        },
      ]),
      words: { min: 1200, max: 1800 },
      sections: { min: 5, max: 8 },
    });
    const [content] = await h.rows("content");
    expect(content).toMatchObject({
      type: "blog",
      channel: connectorId,
      delivery: "github_pr",
      title: TITLE,
      article: ARTICLE,
    });
    const { post, problems } = blogPostOf(content!, "2026-10-20");
    expect(problems).toEqual([]);
    expect(post).toMatchObject({
      slug: "paper-trading-builds-confidence-before-real-orders",
      title: TITLE,
      seoTitle: ARTICLE.seoTitle,
      publishedAt: "2026-10-20",
      updatedAt: "2026-10-20",
      author: "Mario Euchner",
      relatedLinks: ARTICLE.relatedLinks,
    });
    expect(post.sections).toHaveLength(6);
  });

  it("reports a body with a Markdown link to the review as BLOG_BODY_FORMAT", async () => {
    body = articleBody(" See [the desk](https://uliquid.vip/platform/).");
    const { task, slot } = await strategyTask();
    strategyReply("Paper trading builds confidence", slot);
    await runAgentTask(h.worker(), task.id);
    await runAgentTask(h.worker(), (await h.task("copywriter")).id);
    const [content] = await h.rows("content");
    const { problems } = blogPostOf(content!, "2026-10-20");
    expect(problems).toEqual([
      "BLOG_BODY_FORMAT: links and images are not allowed",
    ]);
    const review = await h.task("review");
    const found = await h.run((tx) =>
      deterministicProblems(
        tx,
        project.owner,
        { ...review, id: review.id } as any,
        content!.id,
      ),
    );
    expect(found).toContain(
      "BLOG_BODY_FORMAT: links and images are not allowed",
    );
  });
});

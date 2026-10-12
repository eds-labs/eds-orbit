import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
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
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, encrypt, entity, update } from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { agentReviewAccepted } from "../src/modules/agents/agent-review.ts";
import { preflight } from "../src/modules/policy.ts";
import { blogPostOf } from "../src/modules/blog-target.ts";
import { createPackageProject } from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";
import {
  FIXTURE_POSTS,
  fakeGithub,
  OWNER,
  REPO,
  TOKEN,
} from "./support/fake-github.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const TITLE = "Paper Trading Builds Confidence Before Real Orders";
const SLUG = "paper-trading-builds-confidence-before-real-orders";
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
/** A body in the restricted format: six sections of about 220 words with the profile's CTA once, the last with a closing list. */
const articleBody = (extra = "") =>
  Array.from({ length: 6 }, (_, index) => {
    const paragraph = SENTENCE.repeat(5).trim();
    const second = SECOND.repeat(5).trim();
    const list =
      index === 5
        ? "\n\n- Write the plan down first\n- Review every paper trade"
        : "";
    return `## Section ${index + 1} of the review\n\n${paragraph}\n\n${second}${index === 0 ? ` Learn more.${extra}` : ""}${list}`;
  }).join("\n\n");

/** A recorded review answer with `verdict` for every shown draft. */
const answerAll =
  (verdict: "approve" | "reject") =>
  (request: any): Reply => ({
    output: [
      message({
        decisions: JSON.parse(request.input[0].content).drafts.map(
          (draft: Record<string, any>) => ({
            contentId: draft.contentId,
            verdict,
            reasons: verdict === "approve" ? [] : ["Covers a published topic."],
            revisionInstructions: null,
          }),
        ),
      }),
    ],
  });

describe("blogPostOf fact placeholders (R82)", () => {
  const base = {
    title: TITLE,
    body: articleBody(),
    article: ARTICLE,
    articleAllowlist: [
      "/features/trading-desk/",
      "/blog/market-intelligence-context-not-signal/",
    ],
  };

  it("reports a fact placeholder left in the title or article fields", () => {
    expect(blogPostOf(base, "2026-10-20").problems).toEqual([]);
    const { problems } = blogPostOf(
      {
        ...base,
        title: "Paper Trading With {{fact:abc-1}}",
        article: {
          ...ARTICLE,
          seoTitle: "Paper trading {{ fact:abc-2 }}",
          description: "{{fact:abc-3}} explained.",
          excerpt: "Read why {{fact:abc-4}}.",
          category: "{{fact:abc-5}}",
          keywords: ["paper trading", "{{fact:abc-6}}"],
          relatedLinks: [
            { label: "Desk {{fact:abc-7}}", href: "/features/trading-desk/" },
            ARTICLE.relatedLinks[1],
          ],
        },
      },
      "2026-10-20",
    );
    for (const field of [
      "title",
      "seoTitle",
      "description",
      "excerpt",
      "category",
      "keywords",
      "relatedLinks",
    ])
      expect(problems).toContain(`BLOG_FACT_PLACEHOLDER: ${field}`);
  });
});

/**
 * Review and owner list of website articles (R81, R82, spec B5 and §7): the
 * agent never releases a github_pr article, its validation problems are
 * revised once and then left for the owner, the review judges overlap with
 * the published articles, and the owner list carries the post preview.
 */
describe.skipIf(!enabled)("Blog article review for github_pr (R81)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let cookie = "";
  let ownerId = "";
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let github = fakeGithub();
  let connectorId: string;
  let body: string;
  const origin = () => process.env.APP_ORIGIN!;
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));
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
  const jobsOf = async (kind: string) =>
    (await h.rows("jobs")).filter((job) =>
      String(job.idempotencyKey ?? "").startsWith(`notify:${kind}:`),
    );

  /** A confirmed github_pr blog assignment run up to its review: strategy and copywriter done. */
  const draftedArticle = async () => {
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
    const slot = (run!.slots as Array<{ channel: string; at: string }>)[0]!;
    provider.replies.push(() => ({
      output: [
        message({
          briefs: [
            h.brief(slot, {
              topic: "Paper trading builds confidence",
              angle:
                "Search intent: learn to rehearse a plan. Keywords: paper trading. Outline: five sections.",
              notARepeatBecause: "No published article covers paper trading.",
            }),
          ],
        }),
      ],
    }));
    await runAgentTask(h.worker(), (await h.task("strategy")).id);
    await runAgentTask(h.worker(), (await h.task("copywriter")).id);
    const [content] = await h.rows("content");
    expect(content).toMatchObject({ type: "blog", delivery: "github_pr" });
    // The model calls so far (strategy) are not the review's.
    provider.requests = [];
    return content!;
  };
  const review = async () => {
    await runAgentTask(h.worker(), (await h.task("review")).id);
    return h.task("review");
  };
  const content = async (id: string) =>
    (await h.rows("content")).find((row) => row.id === id)!;

  beforeAll(async () => {
    if (!enabled) return;
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const signedUp = await auth.api.signUpEmail({
      body: { email, name: "Synthetic blog review owner", password },
    });
    ownerId = signedUp.user.id;
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: origin() },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    const cookies = r.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
  });
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
    // The signed-in owner joins the project, as add-member does.
    await authDb.workspaceMember.create({
      data: {
        workspaceId: project.owner.workspaceId,
        userId: ownerId,
        role: "viewer",
      },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        userId: ownerId,
        role: "owner",
      },
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_BLOG_GITHUB;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(async () => {
    if (!enabled) return;
    await authDb.user.deleteMany({ where: { id: ownerId } });
    await app?.close();
    await closeDatabase();
  });

  it("has no scope blocker for a github_pr draft, but for a blog draft on another channel", async () => {
    const draft = await draftedArticle();
    const blockers = async () =>
      (
        await h.run((tx) =>
          preflight(tx, project.owner, draft.id, {
            test: true,
            at: tomorrow(),
            ignoreApproval: true,
          }),
        )
      ).blockers;
    const own = await blockers();
    expect(own).not.toContain("SCOPE_NOT_ALLOWED");
    expect(own).not.toContain("MISSION_SCOPE_NOT_ALLOWED");
    // The same draft on a channel that is neither a policy channel nor its blog target.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", draft.id);
      await update(tx, project.owner, row, {
        ...data(row),
        channel: "random-channel",
      });
    });
    expect(await blockers()).toContain("SCOPE_NOT_ALLOWED");
  });

  it("keeps the blog type rule of the policy for the blog target", async () => {
    const draft = await draftedArticle();
    const policy = (await h.rows("policies")).find((p) => p.active === true)!;
    await h.setPolicy({
      contentTypes: policy.contentTypes.filter((t: string) => t !== "blog"),
    });
    const { blockers } = await h.run((tx) =>
      preflight(tx, project.owner, draft.id, {
        test: true,
        at: tomorrow(),
        ignoreApproval: true,
      }),
    );
    expect(blockers).toContain("SCOPE_NOT_ALLOWED");
  });

  it("leaves an agent-approved article for the owner even with review authority", async () => {
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    await h.connectTelegram();
    const draft = await draftedArticle();
    provider.replies.push(answerAll("approve"));
    const done = await review();
    expect(done.status).toBe("done");
    // The review saw the article and the published articles for overlap.
    expect(provider.requests).toHaveLength(1);
    const input = JSON.parse(provider.requests[0]!.input[0].content);
    expect(
      input.publishedArticles.map((a: { slug: string }) => a.slug).sort(),
    ).toEqual([
      "ai-assisted-trading-keeps-decisions-with-the-user",
      "market-intelligence-context-not-signal",
    ]);
    expect(input.drafts[0]).toMatchObject({
      contentId: draft.id,
      title: TITLE,
      article: ARTICLE,
      body: body,
    });
    expect(provider.requests[0]!.instructions).toContain("publishedArticles");
    const after = await content(draft.id);
    expect(after.status).toBe("needs_review");
    expect(after.agentReview).toBeDefined();
    expect(after.agentReviewDecision).toMatchObject({
      verdict: "approve",
      deterministicProblems: [],
    });
    expect(
      await h.run(async (tx) =>
        agentReviewAccepted(
          tx,
          project.owner,
          data(await entity(tx, project.owner, "content", draft.id)),
        ),
      ),
    ).toBe(false);
    expect(
      (await jobsOf("needs_owner")).map((job) => job.idempotencyKey),
    ).toEqual([`notify:needs_owner:${draft.id}:${done.id}`]);
    // Nothing was scheduled or published.
    expect(await h.rows("publications")).toEqual([]);
  });

  it("revises an article with a validation problem once, keeping title and article, then leaves it for the owner", async () => {
    await h.connectTelegram();
    body = articleBody(" Keep a **written** plan.");
    const draft = await draftedArticle();
    const done = await review();
    expect(done.status).toBe("done");
    // Both rounds were decided by the deterministic checks: no review model call.
    expect(provider.requests).toEqual([]);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    const revision = contracts()[1]!.revision;
    expect(revision.instruction).toContain(
      "BLOG_BODY_FORMAT: emphasis is not allowed",
    );
    expect(revision.previousTitle).toBe(TITLE);
    expect(revision.previousArticle).toEqual(ARTICLE);
    expect(revision.previousBody).toBe(draft.body);
    const original = await content(draft.id);
    expect(original.status).toBe("rejected");
    const revised = await content(original.supersededBy);
    expect(revised.status).toBe("needs_review");
    expect(revised.agentReview).toBeUndefined();
    expect(revised.agentReviewDecision).toMatchObject({
      round: 2,
      verdict: "needs_owner",
      deterministicProblems: ["BLOG_BODY_FORMAT: emphasis is not allowed"],
    });
    expect(
      (await jobsOf("needs_owner")).map((job) => job.idempotencyKey),
    ).toEqual([`notify:needs_owner:${revised.id}:${done.id}`]);
  });

  it("leaves the article for the owner when GitHub is unreachable at review", async () => {
    const draft = await draftedArticle();
    github = fakeGithub({ outage: 502 });
    const done = await review();
    expect(done.status).toBe("done");
    expect(provider.requests).toEqual([]);
    const after = await content(draft.id);
    expect(after.status).toBe("needs_review");
    expect(after.agentReviewDecision).toMatchObject({
      verdict: "needs_owner",
      deterministicProblems: ["BLOG_TARGET_UNREACHABLE"],
    });
  });

  it("lists the article for the owner with its post preview", async () => {
    const draft = await draftedArticle();
    provider.replies.push(answerAll("approve"));
    await review();
    const list = async () => {
      const r = await app.inject({
        method: "GET",
        url: `/api/projects/${project.owner.projectId}/assignment-drafts`,
        headers: { origin: origin(), cookie },
      });
      expect(r.statusCode).toBe(200);
      return r.json().items as Array<Record<string, any>>;
    };
    let [item] = await list();
    expect(item).toMatchObject({
      id: draft.id,
      channel: connectorId,
      delivery: "github_pr",
      agentApproved: true,
      problems: [],
      preview: {
        post: {
          slug: SLUG,
          title: TITLE,
          seoTitle: ARTICLE.seoTitle,
          author: "Mario Euchner",
          relatedLinks: ARTICLE.relatedLinks,
        },
        problems: [],
        liveUrl: `https://uliquid.vip/blog/${SLUG}/`,
        slugTaken: false,
      },
    });
    expect(item!.preview.post.sections).toHaveLength(6);

    // The slug is already a file in the posts directory.
    github = fakeGithub({
      posts: { ...FIXTURE_POSTS, [`${SLUG}.json`]: "{}" },
    });
    // An invalid file still occupies the slug.
    [item] = await list();
    expect(item!.preview.slugTaken).toBe(true);

    // GitHub unreachable: the list still answers.
    github = fakeGithub({ outage: 502 });
    [item] = await list();
    expect(item!.preview).toMatchObject({
      slugTaken: false,
      problems: ["BLOG_TARGET_UNREACHABLE"],
    });
  });

  it("reads the published list once per request", async () => {
    await draftedArticle();
    provider.replies.push(answerAll("approve"));
    await review();
    const before = github.calls.length;
    const r = await app.inject({
      method: "GET",
      url: `/api/projects/${project.owner.projectId}/assignment-drafts`,
      headers: { origin: origin(), cookie },
    });
    expect(r.statusCode).toBe(200);
    const listings = github.calls
      .slice(before)
      .filter((call) => call.endsWith("/contents/content/blog/posts"));
    expect(listings).toHaveLength(1);
  });
});

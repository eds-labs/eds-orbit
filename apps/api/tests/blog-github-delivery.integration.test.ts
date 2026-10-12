import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  replies: [] as Array<(request: any) => Reply | Promise<Reply>>,
  githubFetch: null as null | ((...args: any[]) => Promise<Response>),
  // A live precondition outside this task: an evaluated live index.
  liveIndex: true,
}));
vi.mock("../../../packages/knowledge/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/knowledge/src/index.ts")
    >();
  return {
    ...actual,
    validateActiveIndexEvaluation: async (
      ...args: Parameters<typeof actual.validateActiveIndexEvaluation>
    ) =>
      provider.liveIndex
        ? { valid: true, reasons: [] }
        : actual.validateActiveIndexEvaluation(...args),
  };
});
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    respond: vi.fn(async (request: any) => {
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
        responseId: "resp_review",
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
import { postFileBytes } from "../../../packages/connectors/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import {
  create,
  data,
  DomainError,
  encrypt,
  entity,
  hash,
  update,
} from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { releaseAssignmentDraft } from "../src/modules/agents/owner-release.ts";
import { BLOG_DELIVERY_TOPIC } from "../src/modules/agents/blog-delivery.ts";
import { berlinDate, blogPostOf } from "../src/modules/blog-target.ts";
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
import { ARTICLE, articleBody, SLUG, TITLE } from "./support/blog-article.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const DAY = 86400000;

/** A recorded review answer that approves every shown draft. */
const approveAll = (request: any): Reply => ({
  output: [
    message({
      decisions: JSON.parse(request.input[0].content).drafts.map(
        (draft: Record<string, any>) => ({
          contentId: draft.contentId,
          verdict: "approve",
          reasons: [],
          revisionInstructions: null,
        }),
      ),
    }),
  ],
});

const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.message : String(error);
  }
  return null;
};

/**
 * The owner's release of a website article books its GitHub delivery (R83,
 * spec §7): one `blog_deliveries` row with the exact file bytes and the first
 * worker step, no publication, no Postiz draft and no slot rules. The slug
 * must be free in the repository and not booked by another delivery.
 */
describe.skipIf(!enabled)(
  "Blog delivery booking on owner release (R83)",
  () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let cookie = "";
    let ownerId = "";
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let h: ReturnType<typeof assignmentRun>;
    let github = fakeGithub();
    let connectorId: string;
    const origin = () => process.env.APP_ORIGIN!;
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
    const deliveries = () => h.rows("blog_deliveries");
    const deliveryJobs = async () =>
      (await h.rows("jobs")).filter((job) => job.topic === BLOG_DELIVERY_TOPIC);
    const content = async (id: string) =>
      (await h.rows("content")).find((row) => row.id === id)!;

    /** A confirmed github_pr blog assignment whose article the review approved and left for the owner. */
    const awaitingOwner = async () => {
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
      provider.replies.push(approveAll);
      await runAgentTask(h.worker(), (await h.task("review")).id);
      const [draft] = await h.rows("content");
      expect(draft).toMatchObject({
        type: "blog",
        delivery: "github_pr",
        status: "needs_review",
      });
      return draft!;
    };
    /** `POST /assignment-drafts/:id/release` as the signed-in owner. */
    let savedWrites: string | undefined;
    /** A release that is refused with `code` and books nothing. */
    const refused = async (id: string, version: number, code: string) => {
      const r = await release(id, version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe(code);
      expect(await deliveries()).toEqual([]);
      expect(await deliveryJobs()).toEqual([]);
      expect(await content(id)).toMatchObject({ status: "needs_review" });
    };
    const release = (id: string, version: number) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${project.owner.projectId}/assignment-drafts/${id}/release`,
        headers: { origin: origin(), cookie },
        payload: { version },
      });
    const fileCalls = () =>
      github.calls.filter((call) =>
        call.endsWith(`/contents/content/blog/posts/${SLUG}.json`),
      );
    /** A second draft of the same run with the same article (and slug). */
    const copyOf = (id: string) =>
      h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", id);
        return create(tx, project.owner, "content", { ...data(row) });
      });
    const setMission = (missionId: string, changes: Record<string, unknown>) =>
      h.run(async (tx) => {
        const row = await entity(tx, project.owner, "missions", missionId);
        await update(tx, project.owner, row, { ...data(row), ...changes });
      });

    beforeAll(async () => {
      if (!enabled) return;
      app = await buildServer();
      const auth = makeAuth();
      const password = randomBytes(24).toString("base64url");
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: "Synthetic blog delivery owner", password },
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
      // The merge goes live: the release checks the live gates (R83).
      savedWrites = process.env.ENABLE_EXTERNAL_WRITES;
      process.env.ENABLE_EXTERNAL_WRITES = "true";
      provider.liveIndex = true;
      provider.replies = [];
      github = fakeGithub();
      provider.githubFetch = (...args) => github.fetch(...(args as [any, any]));
      provider.embed.mockReset().mockResolvedValue(embedded());
      provider.generate.mockReset().mockImplementation(async (params: any) => {
        const draft = generated(articleBody());
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
      if (savedWrites === undefined) delete process.env.ENABLE_EXTERNAL_WRITES;
      else process.env.ENABLE_EXTERNAL_WRITES = savedWrites;
      await project.cleanup();
    });
    afterAll(async () => {
      if (!enabled) return;
      await authDb.user.deleteMany({ where: { id: ownerId } });
      await app?.close();
      await closeDatabase();
    });

    it("books one queued delivery with the exact file bytes and its first step", async () => {
      const draft = await awaitingOwner();
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(200);
      const result = r.json();
      expect(result).toMatchObject({
        result: "released",
        delivery: "github_pr",
        publicationId: null,
        postizDraftId: null,
      });
      expect(result.blogDeliveryId).toEqual(expect.any(String));
      // The slug was checked against the base branch before the booking.
      expect(fileCalls()).toEqual([
        `GET /repos/${OWNER}/${REPO}/contents/content/blog/posts/${SLUG}.json`,
      ]);

      const [row] = await deliveries();
      const reviewed = await content(draft.id);
      const { post } = blogPostOf(draft, berlinDate());
      const bytes = postFileBytes(post);
      expect(row).toMatchObject({
        contentId: draft.id,
        assignmentId: draft.assignmentId,
        runId: draft.assignmentRunId,
        connectorId,
        slug: SLUG,
        title: TITLE,
        path: `content/blog/posts/${SLUG}.json`,
        fileBytes: bytes,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        branch: `blog/${SLUG}`,
        status: "queued",
        prNumber: null,
        headSha: null,
        mergeSha: null,
        liveUrl: `https://uliquid.vip/blog/${SLUG}/`,
        attempts: 0,
        error: null,
        bodyHash: hash(draft.body),
        checksSince: null,
        mergedAt: null,
        requestedSlotAt: new Date(
          data(
            await h.run((tx) =>
              entity(tx, project.owner, "missions", draft.missionId),
            ),
          ).plannedSlotAt,
        ).toISOString(),
      });
      // One write: the row starts at version 1.
      expect(
        (
          await h.run((tx) =>
            entity(tx, project.owner, "blog_deliveries", row!.id),
          )
        ).version,
      ).toBe(1);
      expect(post.publishedAt).toBe(berlinDate());
      expect(row!.id).toBe(result.blogDeliveryId);
      // The owner's release is the human content review of this exact text.
      expect(reviewed).toMatchObject({
        status: "reviewed",
        humanReviewedBodyHash: hash(draft.body),
        reviewedBy: ownerId,
      });
      const jobs = await deliveryJobs();
      expect(jobs.map((job) => job.idempotencyKey)).toEqual([
        `blog:${row!.id}:step:1`,
      ]);
      expect(jobs[0]).toMatchObject({ resourceId: row!.id, status: "queued" });
      // Nothing is published or handed to Postiz.
      expect(await h.rows("publications")).toEqual([]);
      expect(await h.rows("postiz_drafts")).toEqual([]);
      const audits = await h.run((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: project.owner.projectId,
            action: "assignment.draft_released",
          },
        }),
      );
      expect(
        audits.map((event) => [
          event.resourceId,
          event.actorId,
          event.metadata,
        ]),
      ).toEqual([
        [
          draft.id,
          ownerId,
          expect.objectContaining({
            blogDeliveryId: row!.id,
            delivery: "github_pr",
          }),
        ],
      ]);

      // Releasing again returns the same delivery and books nothing new.
      const again = await release(draft.id, draft.version);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        result: "already_released",
        delivery: "github_pr",
        blogDeliveryId: row!.id,
      });
      expect(await deliveries()).toHaveLength(1);
      expect(await deliveryJobs()).toHaveLength(1);
    });

    it("refuses a slug that already exists in the repository and books nothing", async () => {
      const draft = await awaitingOwner();
      github = fakeGithub({
        posts: { ...FIXTURE_POSTS, [`${SLUG}.json`]: "{}" },
      });
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("BLOG_SLUG_EXISTS");
      expect(await deliveries()).toEqual([]);
      expect(await deliveryJobs()).toEqual([]);
      expect(await content(draft.id)).toMatchObject({
        status: "needs_review",
        version: draft.version,
      });
    });

    it("refuses a second draft with a slug another active delivery has booked", async () => {
      const draft = await awaitingOwner();
      const second = await copyOf(draft.id);
      expect((await release(draft.id, draft.version)).statusCode).toBe(200);
      const r = await release(second.id, second.version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("BLOG_SLUG_BOOKED");
      expect(await deliveries()).toHaveLength(1);
      expect(await content(second.id)).toMatchObject({
        status: "needs_review",
      });

      // A failed delivery gives its slug back.
      await h.run(async (tx) => {
        const [row] = await tx.entity.findMany({
          where: {
            projectId: project.owner.projectId,
            kind: "blog_deliveries",
          },
        });
        await update(tx, project.owner, row!, {
          ...data(row),
          status: "failed",
          error: "BLOG_HEAD_MOVED",
        });
      });
      const retry = await release(second.id, second.version);
      expect(retry.statusCode).toBe(200);
      expect(await deliveries()).toHaveLength(2);
    });

    it("refuses a draft whose article has problems", async () => {
      const draft = await awaitingOwner();
      const changed = await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", draft.id);
        return update(tx, project.owner, row, {
          ...data(row),
          body: articleBody(" Keep a **written** plan."),
        });
      });
      const r = await release(draft.id, changed.version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("BLOG_POST_INVALID");
      expect(await deliveries()).toEqual([]);
    });

    it("refuses while the flag is off, before asking GitHub", async () => {
      const draft = await awaitingOwner();
      process.env.ORBIT_BLOG_GITHUB = "false";
      const before = github.calls.length;
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("BLOG_GITHUB_DISABLED");
      expect(github.calls.length).toBe(before);
      expect(await deliveries()).toEqual([]);
    });

    it("refuses a connector whose write access is not verified", async () => {
      const draft = await awaitingOwner();
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "connectors", connectorId);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "read_verified",
        });
      });
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("BLOG_TARGET_NOT_VERIFIED");
      expect(await deliveries()).toEqual([]);
    });

    it("refuses editors", async () => {
      const draft = await awaitingOwner();
      expect(
        await code(
          h.run((tx) =>
            releaseAssignmentDraft(tx, project.editor, draft.id, draft.version),
          ),
        ),
      ).toBe("OWNER_REQUIRED");
      expect(await deliveries()).toEqual([]);
    });

    it("releases after the run slot and its mission window passed, up to 30 days", async () => {
      const draft = await awaitingOwner();
      const second = await copyOf(draft.id);
      const missionId = draft.missionId as string;
      // The slot and the mission ended three days ago: no slot rule applies.
      await setMission(missionId, {
        plannedSlotAt: new Date(Date.now() - 3 * DAY).toISOString(),
        endAt: new Date(Date.now() - 3 * DAY + 3600000).toISOString(),
      });
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ delivery: "github_pr" });

      // 31 days after the slot the article can no longer be released.
      await h.run(async (tx) => {
        const [row] = await tx.entity.findMany({
          where: {
            projectId: project.owner.projectId,
            kind: "blog_deliveries",
          },
        });
        await update(tx, project.owner, row!, {
          ...data(row),
          status: "canceled",
        });
      });
      await setMission(missionId, {
        plannedSlotAt: new Date(Date.now() - 31 * DAY).toISOString(),
      });
      const late = await release(second.id, second.version);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe("BLOG_RELEASE_WINDOW_PASSED");
    });

    it("refuses an observe-mode policy, as a live write would be", async () => {
      const draft = await awaitingOwner();
      await h.setPolicy({ mode: "observe" });
      await refused(draft.id, draft.version, "OBSERVE_FORBIDS_EXTERNAL_WRITE");
    });

    it("refuses synthetic content, as a live write would be", async () => {
      const draft = await awaitingOwner();
      const changed = await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", draft.id);
        return update(tx, project.owner, row, {
          ...data(row),
          synthetic: true,
        });
      });
      await refused(
        draft.id,
        changed.version,
        "SYNTHETIC_CONTENT_NO_LIVE_WRITE",
      );
    });

    it("refuses while external writes are off or the live index is not evaluated", async () => {
      const draft = await awaitingOwner();
      process.env.ENABLE_EXTERNAL_WRITES = "false";
      await refused(draft.id, draft.version, "EXTERNAL_WRITES_DISABLED");
      process.env.ENABLE_EXTERNAL_WRITES = "true";
      provider.liveIndex = false;
      await refused(draft.id, draft.version, "LIVE_RAG_EVAL_REQUIRED");
    });

    it("keeps an owner-set calendar block for the blog target", async () => {
      const draft = await awaitingOwner();
      await h.run((tx) =>
        create(tx, project.owner, "calendar_blocks", {
          status: "active",
          channels: [connectorId],
          startAt: new Date(Date.now() - DAY).toISOString(),
          endAt: new Date(Date.now() + DAY).toISOString(),
          reason: "No publishing today",
        }),
      );
      await refused(draft.id, draft.version, "MANUAL_CALENDAR_BLOCK");
    });

    it("maps a refused token at the slug check and marks the connector", async () => {
      const draft = await awaitingOwner();
      github = fakeGithub({ authFail: true });
      await refused(draft.id, draft.version, "GITHUB_TOKEN_INVALID");
      const connector = await h.run((tx) =>
        entity(tx, project.owner, "connectors", connectorId),
      );
      expect(data(connector)).toMatchObject({ status: "configured" });
      expect(data(connector).tokenInvalidAt).toEqual(expect.any(String));
    });

    it("maps a GitHub outage at the slug check", async () => {
      const draft = await awaitingOwner();
      github = fakeGithub({ outage: 502 });
      const r = await release(draft.id, draft.version);
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("BLOG_TARGET_UNREACHABLE");
      expect(await deliveries()).toEqual([]);
      expect(await deliveryJobs()).toEqual([]);
    });
  },
);

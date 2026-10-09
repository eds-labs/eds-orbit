import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Offline only: drafts and review answers are recorded; no provider is called.
const replay = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  shown: [] as string[][],
  recorded: null as null | { verdict: string; reasons: string[] },
}));
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  generate: replay.generate,
  embed: replay.embed,
  respond: vi.fn(async (request: any) => {
    if (!replay.recorded) throw new Error("REPLAY_NOT_CONFIGURED");
    const drafts = JSON.parse(request.input[0].content).drafts as Array<{
      contentId: string;
    }>;
    replay.shown.push(drafts.map((draft) => draft.contentId));
    return {
      output: [
        message({
          decisions: drafts.map((draft) => ({
            contentId: draft.contentId,
            verdict: replay.recorded!.verdict,
            reasons: replay.recorded!.reasons,
            revisionInstructions: null,
          })),
        }),
      ],
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 7,
      },
      responseId: "resp_review",
    };
  }),
}));
import { closeDatabase } from "../../packages/db/src/index.ts";
import { create, data, entity, update } from "../../apps/api/src/shared.ts";
import { runAgentTask } from "../../apps/api/src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../../apps/api/src/modules/agents/specialists/index.ts";
import {
  REVIEW_INSTRUCTIONS,
  reviewStep,
} from "../../apps/api/src/modules/agents/specialists/review.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "../../apps/api/tests/support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "../../apps/api/tests/support/assignment-review.ts";
import {
  CATEGORIES,
  isBareHost,
  parseReviewSet,
  type ReviewCase,
} from "./review-set.ts";
import raw from "./review-v2.json" with { type: "json" };

const dataset = parseReviewSet(raw);
const good = dataset.cases.filter((c) => c.label === "good");
const bad = dataset.cases.filter((c) => c.label === "bad");

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("Review eval set v2", () => {
  it("holds 8 good and 17 bad cases over every failure kind, and the bare host", () => {
    expect(dataset.datasetVersion).toBe("agents-review-v2");
    expect(good.length).toBe(8);
    expect(bad.filter((c) => !isBareHost(c)).length).toBe(17);
    expect(bad.filter(isBareHost).length).toBe(1);
    expect(bad.filter((c) => c.category === "unbacked_claim").length).toBe(5);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(
      dataset.cases.length,
    );
    for (const category of CATEGORIES)
      expect(bad.filter((c) => c.category === category).length).toBeGreaterThan(
        0,
      );
    for (const c of good) expect(c.expected.verdict).toBe("approve");
    for (const c of bad) expect(c.expected.verdict).not.toBe("approve");
    // A blocker case records a wrong approve, so the set proves the model cannot clear it.
    for (const c of bad.filter((c) => c.expected.deterministic.length))
      expect(c.recorded.verdict).toBe("approve");
    // An unbacked claim is the model's to catch; its recorded round-1 answer is reject.
    for (const c of bad.filter((c) => c.category === "unbacked_claim")) {
      expect(c.expected).toEqual({
        verdict: "reject",
        deterministic: [],
        modelSees: true,
      });
      expect(c.recorded.verdict).toBe("reject");
    }
  });

  // The prompt's examples must not be the set's own sentences, or the set would test recall.
  it("quotes no sentence of a case body in the review prompt", () => {
    const sentences = dataset.cases.flatMap((c) =>
      c.body
        .split(/(?<=[.?!])\s+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence && sentence !== "Learn more."),
    );
    expect(sentences.length).toBeGreaterThan(0);
    expect(
      sentences.filter((sentence) => REVIEW_INSTRUCTIONS.includes(sentence)),
    ).toEqual([]);
  });
});

describe.skipIf(!enabled)("Review eval v2 (offline replay)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let template: Record<string, any>;

  beforeAll(async () => {
    process.env.ORBIT_AGENTS = "true";
    // The replay measures what the review would approve with its authority on.
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    replay.embed.mockResolvedValue(embedded());
    replay.generate.mockResolvedValue(
      generated("Beta access is open for product teams today. Learn more."),
    );
    project = await createPackageProject();
    h = assignmentRun(project);
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X, TELEGRAM],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
    await h.connectTelegram();
    await h.makeAssignment({
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    await h.planWithBriefs((slots) => slots.map((slot) => h.brief(slot)));
    await runAgentTask(h.worker(), (await h.task(`copywriter:${X}`)).id);
    const [draft] = await h.rows("content");
    template = draft!;
    // The template is only a shape for the cases; it takes no part in their checks.
    await archive(template.id);
  }, 60_000);
  afterAll(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project?.cleanup();
    await closeDatabase();
  });

  async function archive(contentId: string) {
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", contentId);
      await update(tx, project.owner, row, {
        ...data(row),
        status: "archived",
      });
    });
  }

  /** One case: its draft in the run, its channel history, its own review task; returns the outcome. */
  async function review(c: ReviewCase) {
    const { id: _id, version: _version, ...shape } = template;
    const setup = await h.run(async (tx) => {
      const content = await create(tx, project.owner, "content", {
        ...shape,
        title: c.id,
        body: c.body,
        claims: [{ text: "Learn more.", kind: "style" }],
        jobId: `eval:${c.id}`,
        status: "draft",
      });
      const posts = [];
      for (const [index, text] of (c.channelHistory ?? []).entries())
        posts.push(
          await create(tx, project.owner, "channel_posts", {
            channel: X,
            remoteId: `eval-${c.id}-${index}`,
            publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
            state: "PUBLISHED",
            text,
            source: "external",
            syncedAt: new Date().toISOString(),
          }),
        );
      const task = await create(tx, project.owner, "agent_tasks", {
        runId: template.assignmentRunId,
        stepKey: "review",
        role: "review",
        assignmentId: template.assignmentId,
        assignmentVersion: 1,
        ceilingMicros: 1_000_000,
        input: {
          inputs: {
            [`copywriter:${X}`]: { contentIds: [content.id], failed: [] },
          },
        },
        output: null,
        status: "running",
        errorCode: null,
        costMicros: 0,
      });
      return { contentId: content.id, task, posts };
    });
    replay.recorded = c.recorded;
    replay.shown = [];
    const output = (await reviewStep(h.worker(), {
      id: setup.task.id,
      ...(data(setup.task) as any),
    })) as { decisions: Array<{ contentId: string; verdict: string }> };
    const content = (await h.rows("content")).find(
      (row) => row.id === setup.contentId,
    )!;
    await archive(setup.contentId);
    await h.run(async (tx) => {
      for (const post of setup.posts)
        await tx.entity.delete({ where: { id: post.id } });
    });
    return {
      verdict: output.decisions.find((d) => d.contentId === setup.contentId)
        ?.verdict,
      content,
      modelSaw: replay.shown.flat().includes(setup.contentId),
    };
  }

  it("approves every good case of review-v2", async () => {
    const failures: string[] = [];
    for (const c of good) {
      const outcome = await review(c);
      if (
        outcome.verdict !== "approve" ||
        outcome.content.status !== "reviewed" ||
        !outcome.content.agentReview ||
        !outcome.modelSaw
      )
        failures.push(
          `${c.id}: ${outcome.verdict} ${outcome.content.status} ${JSON.stringify(outcome.content.agentReviewDecision?.deterministicProblems ?? [])}`,
        );
    }
    expect(failures).toEqual([]);
  }, 120_000);

  // A bad case is never approved: rejected, or left for the owner where the set expects that.
  it("rejects every bad case of review-v2", async () => {
    const failures: string[] = [];
    for (const c of bad) {
      const outcome = await review(c);
      const problems = (outcome.content.agentReviewDecision
        ?.deterministicProblems ?? []) as string[];
      const owner = c.expected.verdict === "owner";
      if (
        outcome.verdict !== (owner ? "needs_owner" : "reject") ||
        outcome.content.status !== (owner ? "needs_review" : "rejected") ||
        outcome.content.agentReview ||
        outcome.modelSaw !== c.expected.modelSees ||
        c.expected.deterministic.some((code) => !problems.includes(code))
      )
        failures.push(
          `${c.id}: ${outcome.verdict} ${outcome.content.status} saw=${outcome.modelSaw} ${JSON.stringify(problems)}`,
        );
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

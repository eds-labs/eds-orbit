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
import { z } from "zod";
import { closeDatabase } from "../../packages/db/src/index.ts";
import { create, data, entity, update } from "../../apps/api/src/shared.ts";
import { runAgentTask } from "../../apps/api/src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../../apps/api/src/modules/agents/specialists/index.ts";
import { reviewStep } from "../../apps/api/src/modules/agents/specialists/review.ts";
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
import raw from "./review-v1.json" with { type: "json" };

const CATEGORIES = [
  "wrong_number",
  "profit_promise",
  "investment_advice",
  "disallowed_link",
  "off_brand_tone",
  "repeated_post",
] as const;
const reviewCase = z
  .object({
    id: z.string().min(1),
    label: z.enum(["good", "bad"]),
    category: z.enum(["good", ...CATEGORIES]),
    body: z.string().min(1).max(280),
    channelHistory: z.array(z.string().min(1)).optional(),
    recorded: z
      .object({
        verdict: z.enum(["approve", "revise", "reject"]),
        reasons: z.array(z.string()),
      })
      .strict(),
    expected: z
      .object({
        verdict: z.enum(["approve", "reject"]),
        deterministic: z.array(z.string()),
        modelSees: z.boolean(),
      })
      .strict(),
  })
  .strict();
const dataset = z
  .object({
    datasetVersion: z.literal("agents-review-v1"),
    description: z.string().min(1),
    cases: z.array(reviewCase).min(20),
  })
  .strict()
  .parse(raw);
type ReviewCase = z.infer<typeof reviewCase>;
const good = dataset.cases.filter((c) => c.label === "good");
const bad = dataset.cases.filter((c) => c.label === "bad");

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("Review eval set v1", () => {
  it("holds at least 8 good and 12 bad cases over every failure kind", () => {
    expect(good.length).toBeGreaterThanOrEqual(8);
    expect(bad.length).toBeGreaterThanOrEqual(12);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(
      dataset.cases.length,
    );
    for (const category of CATEGORIES)
      expect(bad.filter((c) => c.category === category).length).toBeGreaterThan(
        0,
      );
    for (const c of good) expect(c.expected.verdict).toBe("approve");
    for (const c of bad) expect(c.expected.verdict).toBe("reject");
    // A blocker case records a wrong approve, so the set proves the model cannot clear it.
    for (const c of bad.filter((c) => c.expected.deterministic.length))
      expect(c.recorded.verdict).toBe("approve");
  });
});

describe.skipIf(!enabled)("Review eval v1 (offline replay)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let template: Record<string, any>;

  beforeAll(async () => {
    process.env.ORBIT_AGENTS = "true";
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

  it("approves every good case of review-v1", async () => {
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

  it("rejects every bad case of review-v1", async () => {
    const failures: string[] = [];
    for (const c of bad) {
      const outcome = await review(c);
      const problems = (outcome.content.agentReviewDecision
        ?.deterministicProblems ?? []) as string[];
      if (
        outcome.verdict !== "reject" ||
        outcome.content.status !== "rejected" ||
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

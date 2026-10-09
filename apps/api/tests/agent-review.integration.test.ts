import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model call is a recorded reply; nothing here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  saveDraftDocument: vi.fn(),
  requests: [] as any[],
  // A revision fails like a provider outage when set.
  failRevision: false,
  replies: [] as Array<(request: any) => Reply>,
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
      const reply = next(request);
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
vi.mock("../src/modules/google-drive.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/google-drive.ts")>();
  return { ...actual, saveDraftDocument: provider.saveDraftDocument };
});
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { data, entity, hash, update } from "../src/shared.ts";
import {
  setAssignmentStatus,
  updateAssignment,
} from "../src/modules/agents/assignments.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { reviewStep } from "../src/modules/agents/specialists/review.ts";
import { agentReviewAccepted } from "../src/modules/agents/agent-review.ts";
import { checkClaims, preflight } from "../src/modules/policy.ts";
import { reviewContent } from "../src/modules/workflow.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";
import {
  assignmentRun,
  BLOG,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
const HUMAN = "HUMAN_CONTENT_REVIEW_REQUIRED";

type Verdict = {
  verdict: "approve" | "revise" | "reject";
  reasons?: string[];
  revisionInstructions?: string | null;
};

/** The drafts a review request showed the model. */
const shown = (request: any): Array<Record<string, any>> =>
  JSON.parse(request.input[0].content).drafts;

/** A recorded review answer: a verdict per shown draft (by body), plus decisions for `extraIds`. */
const answer =
  (decide: (draft: Record<string, any>) => Verdict, extraIds: string[] = []) =>
  (request: any): Reply => ({
    output: [
      message({
        decisions: [
          ...shown(request).map((draft) => ({
            contentId: draft.contentId,
            reasons: [],
            revisionInstructions: null,
            ...decide(draft),
          })),
          ...extraIds.map((contentId) => ({
            contentId,
            verdict: "approve",
            reasons: [],
            revisionInstructions: null,
          })),
        ],
      }),
    ],
  });

describe.skipIf(!enabled)("Review agent and agent review authority", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      String(a.briefKey).localeCompare(String(b.briefKey)),
    );
  const blockers = async (contentId: string) => {
    const content = await h.run((tx) =>
      entity(tx, project.owner, "content", contentId),
    );
    const mission = await h.run((tx) =>
      entity(tx, project.owner, "missions", data(content).missionId),
    );
    return (
      await h.run((tx) =>
        preflight(tx, project.owner, contentId, {
          test: true,
          at: new Date(data(mission).plannedSlotAt),
          ignoreApproval: true,
        }),
      )
    ).blockers;
  };
  /** Plans a run with one brief per slot, writes the drafts and returns the review task. */
  const drafted = async (
    briefChanges: (slot: {
      channel: string;
      at: string;
    }) => Record<string, unknown> = () => ({}),
  ) => {
    await h.planWithBriefs((slots) =>
      slots.map((slot) => h.brief(slot, briefChanges(slot))),
    );
    for (const copy of (await h.rows("agent_tasks")).filter(
      (t) => t.role === "copywriter",
    ))
      await runAgentTask(h.worker(), copy.id);
    return h.task("review");
  };
  /** Runs the review task's handler again, as a worker restart would. */
  const reviewAgain = async (taskId: string) => {
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "agent_tasks", taskId);
      await update(tx, project.owner, row, { ...data(row), status: "running" });
    });
    const task = (await h.rows("agent_tasks")).find((t) => t.id === taskId)!;
    return reviewStep(h.worker(), task as any);
  };

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    // Agent approval counts only behind its own gate (R70); these tests turn it on explicitly.
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    provider.requests = [];
    provider.replies = [];
    provider.failRevision = false;
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      if (contract.revision && provider.failRevision)
        throw new Error("synthetic provider outage");
      if (contract.revision)
        return generated(
          `Beta access is open for product teams, ready on day one (${topic}). Learn more.`,
        );
      if (topic.includes("BARELINK"))
        return generated(
          `Beta access is open, sign up at beta-signup.example/teams (${topic}). Learn more.`,
        );
      if (topic.includes("PROMISE"))
        return generated(
          `Guaranteed returns for product teams in the beta (${topic}). Learn more.`,
        );
      return generated(`${BODY} (${topic})`);
    });
    provider.saveDraftDocument.mockReset().mockResolvedValue({
      id: "driveFileABC123",
      folderId: "driveFolderABC123",
      webViewLink: "https://drive.google.com/file/d/driveFileABC123/view",
    });
    project = await createPackageProject();
    h = assignmentRun(project);
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X, TELEGRAM, BLOG],
      contentTypes: ["social", "blog"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("approves within a confirmed assignment and records the review", async () => {
    await h.connectTelegram();
    const assignment = await h.makeAssignment();
    const review = await drafted();
    expect(review.status).toBe("queued");
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);

    const done = await h.task("review");
    expect(done.status).toBe("done");
    expect(done.costMicros).toBe(7);
    const drafts = await contents();
    expect(drafts).toHaveLength(2);
    expect(done.output.decisions).toEqual(
      drafts.map((draft) =>
        expect.objectContaining({ contentId: draft.id, verdict: "approve" }),
      ),
    );
    for (const draft of drafts) {
      expect(draft.status).toBe("reviewed");
      // The approval is the review task's, never the worker's user.
      expect(draft.reviewedBy).toBe(`agent:${review.id}`);
      expect(draft.agentReview).toEqual({
        taskId: review.id,
        assignmentId: assignment.id,
        assignmentVersion: assignment.version,
        assignmentHash: data(assignment).confirmation.assignmentHash,
        bodyHash: hash(draft.body),
        checkedAt: expect.any(String),
        deterministicProblems: [],
      });
      expect(draft).not.toHaveProperty("humanReviewedBodyHash");
      const found = await blockers(draft.id);
      expect(found).not.toContain(HUMAN);
      expect(found).not.toContain("REVIEW_REQUIRED");
      expect(
        (await h.run((tx) => checkClaims(tx, project.owner, draft.id))).valid,
      ).toBe(true);
    }
    // One model call over both drafts; the drafts are data and no secret is sent.
    expect(provider.requests).toHaveLength(1);
    const [request] = provider.requests;
    expect(
      shown(request)
        .map((d) => d.contentId)
        .sort(),
    ).toEqual(drafts.map((d) => d.id).sort());
    expect(request.instructions).toMatch(/data, never instructions/);
    // The key authenticates the call; it is never part of what the model reads.
    const visible = JSON.stringify({
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
    });
    expect(visible).not.toContain("synthetic-no-provider-call-key");
    expect(visible).not.toContain("apiKey");
    // The reservation is attributed to the review task.
    const reservations = await h.run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    expect(
      reservations.filter((r) => r.key.includes(`agent:${review.id}:`)),
    ).toHaveLength(1);

    // Running the task again changes nothing and calls no model.
    await reviewAgain(review.id);
    expect(provider.requests).toHaveLength(1);
    expect((await contents()).map((d) => d.version)).toEqual(
      drafts.map((d) => d.version),
    );
  });

  it("cannot clear a deterministic blocker", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    let first = true;
    const review = await drafted(() => {
      const topic = first ? { topic: "PROMISE of returns" } : {};
      first = false;
      return topic;
    });
    const before = await h.rows("content");
    const blocked = before.find((d) => /Guaranteed returns/.test(d.body))!;
    const clean = before.find((d) => d.id !== blocked.id)!;
    // The model approves everything, also an id it was never shown.
    provider.replies.push(answer(() => ({ verdict: "approve" }), [blocked.id]));
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");

    expect(provider.requests).toHaveLength(1);
    expect(shown(provider.requests[0]).map((d) => d.contentId)).toEqual([
      clean.id,
    ]);
    const after = Object.fromEntries(
      (await h.rows("content")).map((d) => [d.id, d]),
    );
    expect(after[blocked.id]!.status).toBe("rejected");
    expect(after[blocked.id]!.agentReview).toBeUndefined();
    expect(after[blocked.id]!.agentReviewDecision).toMatchObject({
      verdict: "reject",
      modelVerdict: null,
      deterministicProblems: expect.arrayContaining([
        "PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE",
      ]),
    });
    expect(after[clean.id]!.status).toBe("reviewed");

    // An agent review never clears a blocker, even a forged clean one.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", blocked.id);
      await update(tx, project.owner, row, {
        ...data(row),
        status: "reviewed",
        agentReview: {
          ...after[clean.id]!.agentReview,
          bodyHash: hash(data(row).body),
        },
      });
    });
    expect(await blockers(blocked.id)).toContain(
      "PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE",
    );
    // A review that recorded a deterministic problem does not count.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", clean.id);
      await update(tx, project.owner, row, {
        ...data(row),
        agentReview: {
          ...data(row).agentReview,
          deterministicProblems: ["CHANNEL_LIMIT_EXCEEDED"],
        },
      });
    });
    expect(await blockers(clean.id)).toContain(HUMAN);
  });

  it("revises once, then rejects", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const review = await drafted();
    const [first, second] = await contents();
    // Round 1: the first draft needs a change, the second is fine.
    provider.replies.push(
      answer((draft) =>
        draft.contentId === first!.id
          ? {
              verdict: "revise",
              reasons: ["The opening is vague."],
              revisionInstructions: "Name what teams can do on day one.",
            }
          : { verdict: "approve" },
      ),
    );
    // Round 2: the revision still is not right.
    provider.replies.push(
      answer(() => ({
        verdict: "revise",
        reasons: ["Still vague."],
        revisionInstructions: "Try again.",
      })),
    );
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");

    // Two drafts plus exactly one revision; two review calls.
    expect(provider.generate).toHaveBeenCalledTimes(3);
    const revisionContract = JSON.parse(
      provider.generate.mock.calls[2]![0].goal,
    );
    expect(revisionContract.revision.instruction).toBe(
      "Name what teams can do on day one.",
    );
    expect(provider.requests).toHaveLength(2);
    const all = Object.fromEntries(
      (await h.rows("content")).map((d) => [d.id, d]),
    );
    const revisedId = all[first!.id]!.supersededBy as string;
    expect(revisedId).toBeTruthy();
    expect(shown(provider.requests[1]).map((d) => d.contentId)).toEqual([
      revisedId,
    ]);
    expect(all[first!.id]!.status).toBe("rejected");
    expect(all[first!.id]!.agentReviewDecision).toMatchObject({
      verdict: "revise",
      revisedTo: revisedId,
    });
    expect(all[revisedId]!.status).toBe("rejected");
    expect(all[revisedId]!.agentReview).toBeUndefined();
    expect(all[revisedId]!.agentReviewDecision).toMatchObject({
      round: 2,
      modelVerdict: "revise",
      verdict: "reject",
    });
    expect(all[second!.id]!.status).toBe("reviewed");
    expect((await h.task("review")).output.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contentId: revisedId, verdict: "reject" }),
        expect.objectContaining({ contentId: second!.id, verdict: "approve" }),
      ]),
    );

    // A second pass revises nothing again and calls no model.
    await reviewAgain(review.id);
    expect(provider.generate).toHaveBeenCalledTimes(3);
    expect(provider.requests).toHaveLength(2);
  });

  it("approves a revised draft in the second review", async () => {
    await h.connectTelegram();
    await h.makeAssignment({
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    const review = await drafted();
    provider.replies.push(
      answer(() => ({
        verdict: "revise",
        reasons: ["Too generic."],
        revisionInstructions: "Lead with day one.",
      })),
    );
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const all = await h.rows("content");
    expect(all).toHaveLength(2);
    const original = all.find((d) => d.supersededBy)!;
    const revised = all.find((d) => d.id === original.supersededBy)!;
    expect(original.status).toBe("rejected");
    expect(revised.status).toBe("reviewed");
    expect(revised.agentReview.bodyHash).toBe(hash(revised.body));
    expect(await blockers(revised.id)).not.toContain(HUMAN);
  });

  it("refuses agent-approved content of an outdated assignment version", async () => {
    await h.connectTelegram();
    const assignment = await h.makeAssignment();
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    // Pausing stops it; resuming the same confirmed content restores it (R43).
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    expect(await blockers(draft!.id)).toContain(HUMAN);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "active"),
    );
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    // Moving the confirmed times keeps the assignment active, but the review covered the old hash.
    const current = (await h.rows("assignments"))[0]!;
    await h.run((tx) =>
      updateAssignment(tx, project.owner, assignment.id, current.version, {
        schedule: { ...current.schedule, times: ["11:00", "17:00"] },
      }),
    );
    const moved = (await h.rows("assignments"))[0]!;
    expect(moved.status).toBe("active");
    expect(moved.confirmation.assignmentHash).not.toBe(
      draft!.agentReview.assignmentHash,
    );
    expect(await blockers(draft!.id)).toContain(HUMAN);

    // A content change returns the assignment to draft: refused as well.
    await h.run((tx) =>
      updateAssignment(tx, project.owner, assignment.id, moved.version, {
        topicFrame: "Longer updates about beta access for product teams",
      }),
    );
    expect((await h.rows("assignments"))[0]!.status).toBe("draft");
    expect(await blockers(draft!.id)).toContain(HUMAN);
  });

  it("accepts an agent review only inside the confirmation and with Orbit Agents on", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    process.env.ORBIT_AGENTS = "false";
    expect(await blockers(draft!.id)).toContain(HUMAN);
    process.env.ORBIT_AGENTS = "true";

    // A channel outside the confirmed assignment (X only).
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", draft!.id);
      await update(tx, project.owner, row, { ...data(row), channel: TELEGRAM });
    });
    expect(await blockers(draft!.id)).toContain(HUMAN);
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", draft!.id);
      await update(tx, project.owner, row, { ...data(row), channel: X });
    });
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    // A chat linked without a recorded time, or linked after the review, does not count (R50).
    const [connection] = await h.rows("telegram_connections");
    const setLinkedAt = (linkedAt: string | undefined) =>
      h.run(async (tx) => {
        const row = await entity(
          tx,
          project.owner,
          "telegram_connections",
          connection!.id,
        );
        const { linkedAt: _old, ...rest } = data(row);
        await update(tx, project.owner, row, {
          ...rest,
          ...(linkedAt ? { linkedAt } : {}),
        });
      });
    await setLinkedAt(undefined);
    expect(await blockers(draft!.id)).toContain(HUMAN);
    await setLinkedAt(new Date(Date.now() + 60_000).toISOString());
    expect(await blockers(draft!.id)).toContain(HUMAN);
    await setLinkedAt(connection!.linkedAt);
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    // A changed text is no longer the reviewed one.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "content", draft!.id);
      await update(tx, project.owner, row, {
        ...data(row),
        body: `${data(row).body} `,
      });
    });
    expect(await blockers(draft!.id)).toContain(HUMAN);
  });

  it("accepts an agent review only while ORBIT_AGENT_REVIEW_AUTHORITY is on (R70)", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    // A fully valid review: accepted with the gate on.
    expect(await blockers(draft!.id)).not.toContain(HUMAN);
    expect(
      await h.run((tx) => agentReviewAccepted(tx, project.owner, draft!)),
    ).toBe(true);

    // Off by default and when set to false: the post waits for the owner.
    for (const value of [undefined, "false"]) {
      if (value === undefined) delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
      else process.env.ORBIT_AGENT_REVIEW_AUTHORITY = value;
      expect(await blockers(draft!.id)).toContain(HUMAN);
      expect(
        await h.run((tx) => agentReviewAccepted(tx, project.owner, draft!)),
      ).toBe(false);
    }
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    expect(await blockers(draft!.id)).not.toContain(HUMAN);
  });

  it("loses agent approval when the bot's linked user is no longer an owner", async () => {
    // The bot is bound to a project member who is owner by project role (R61).
    const member = project.editor.userId;
    const role = (value: "owner" | "editor" | null) =>
      value
        ? authDb.projectMember.update({
            where: {
              projectId_userId: {
                projectId: project.owner.projectId,
                userId: member,
              },
            },
            data: { role: value },
          })
        : authDb.projectMember.delete({
            where: {
              projectId_userId: {
                projectId: project.owner.projectId,
                userId: member,
              },
            },
          });
    await role("owner");
    const connection = await h.connectTelegram();
    await h.run(async (tx) => {
      const row = await entity(
        tx,
        project.owner,
        "telegram_connections",
        connection.id,
      );
      await update(tx, project.owner, row, {
        ...data(row),
        linkedUserId: member,
      });
    });
    await h.makeAssignment();
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    const accepted = () =>
      h.run((tx) => agentReviewAccepted(tx, project.owner, draft!));
    expect(await accepted()).toBe(true);
    expect(await blockers(draft!.id)).not.toContain(HUMAN);

    await role("editor");
    expect(await accepted()).toBe(false);
    expect(await blockers(draft!.id)).toContain(HUMAN);

    await role(null);
    expect(await accepted()).toBe(false);
    expect(await blockers(draft!.id)).toContain(HUMAN);
  });

  it("requires owner review when no Telegram bot is connected", async () => {
    // A connection that is not linked does not count.
    await h.connectTelegram("pending");
    await h.makeAssignment();
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    // The approval is recorded, but the post waits for the owner.
    expect(draft!.agentReview.bodyHash).toBe(hash(draft!.body));
    expect(draft!.status).toBe("needs_review");
    expect(await blockers(draft!.id)).toContain(HUMAN);

    // Linking the bot later does not turn the earlier review into an approval (R50).
    await h.connectTelegram();
    expect(await blockers(draft!.id)).toContain(HUMAN);

    // The owner review works exactly as before.
    const reviewed = await h.run((tx) =>
      reviewContent(tx, project.owner, draft!.id, draft!.version, true),
    );
    expect(data(reviewed).status).toBe("reviewed");
    expect(await blockers(draft!.id)).not.toContain(HUMAN);
  });

  it("saves an agent-approved blog draft to Drive and publishes nothing", async () => {
    await h.makeAssignment({
      name: "Daily article",
      contentType: "blog",
      channels: [BLOG],
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    const review = await drafted();
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    expect(draft!.agentReview.bodyHash).toBe(hash(draft!.body));
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
    expect(provider.saveDraftDocument.mock.calls[0]![1]).toMatchObject({
      contentId: draft!.id,
      category: "Blog",
    });
    expect(draft!.driveDraft).toMatchObject({ bodyHash: hash(draft!.body) });
    expect(await h.rows("publications")).toEqual([]);
    // Once per approved text.
    await reviewAgain(review.id);
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
  });
  it("leaves a draft for the owner when the project is paused", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const review = await drafted();
    await h.run((tx) =>
      tx.project.update({
        where: { id: project.owner.projectId },
        data: { paused: true },
      }),
    );
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    // A project state is no fault of the draft: it waits for the owner, unjudged.
    expect(provider.requests).toHaveLength(0);
    for (const draft of await contents()) {
      expect(draft.status).toBe("needs_review");
      expect(draft.agentReview).toBeUndefined();
      expect(draft.agentReviewDecision).toMatchObject({
        verdict: "needs_owner",
        modelVerdict: null,
        deterministicProblems: ["PROJECT_PAUSED"],
      });
    }
    expect((await h.task("review")).output.decisions).toEqual([
      expect.objectContaining({ verdict: "needs_owner" }),
      expect.objectContaining({ verdict: "needs_owner" }),
    ]);
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: project.owner.projectId,
          action: "content.agent_review_left_for_owner",
        },
      }),
    );
    expect(audits).toHaveLength(2);
  });

  it("leaves a draft with an unverified bare link for the owner", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    let first = true;
    const review = await drafted(() => {
      const topic = first ? { topic: "BARELINK teams" } : {};
      first = false;
      return topic;
    });
    const linked = (await h.rows("content")).find((d) =>
      /beta-signup\.example/.test(d.body),
    )!;
    provider.replies.push(answer(() => ({ verdict: "approve" })));
    await runAgentTask(h.worker(), review.id);
    expect(shown(provider.requests[0]).map((d) => d.contentId)).not.toContain(
      linked.id,
    );
    const after = (await h.rows("content")).find((d) => d.id === linked.id)!;
    expect(after.status).toBe("needs_review");
    expect(after.agentReview).toBeUndefined();
    expect(after.agentReviewDecision.deterministicProblems).toEqual([
      "LINK_UNVERIFIED",
    ]);
  });

  it("leaves the original for the owner when a revision fails for a provider reason", async () => {
    await h.connectTelegram();
    await h.makeAssignment({
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    const review = await drafted();
    provider.failRevision = true;
    provider.replies.push(
      answer(() => ({
        verdict: "revise",
        reasons: ["Too generic."],
        revisionInstructions: "Lead with day one.",
      })),
    );
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    const all = await h.rows("content");
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("needs_review");
    expect(all[0]!.supersededBy).toBeUndefined();
    expect(all[0]!.agentReview).toBeUndefined();
    expect(all[0]!.agentReviewDecision).toMatchObject({
      verdict: "needs_owner",
      modelVerdict: "revise",
      revisionError: "MODEL_OUTCOME_OR_COST_UNKNOWN",
    });
  });

  it("raises a used-up month again when the review runs again", async () => {
    await h.connectTelegram();
    const assignment = await h.makeAssignment({
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    const review = await drafted();
    // The first review answer uses up the assignment's month.
    provider.replies.push((request) => ({
      ...answer(() => ({
        verdict: "revise",
        reasons: ["Too generic."],
        revisionInstructions: "Lead with day one.",
      }))(request),
      costMicros: 30_000_000,
    }));
    await runAgentTask(h.worker(), review.id);
    const failed = await h.task("review");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("ASSIGNMENT_BUDGET_EXHAUSTED");
    expect(
      (await h.rows("assignments")).find((a) => a.id === assignment.id)!.status,
    ).toBe("budget_exhausted");
    const [original] = await h.rows("content");
    expect(original!.status).toBe("rejected");
    expect(original!.agentReviewDecision.revisionError).toBe(
      "ASSIGNMENT_BUDGET_EXHAUSTED",
    );
    // Running it again neither revises nor forgets the used-up month.
    await expect(reviewAgain(review.id)).rejects.toMatchObject({
      code: "ASSIGNMENT_BUDGET_EXHAUSTED",
    });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(1);
  });
});

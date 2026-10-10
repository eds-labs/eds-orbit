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
        responseId: "resp_review",
      };
    }),
  };
});
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import {
  create,
  data,
  DomainError,
  encrypt,
  entity,
  list,
  update,
} from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { releaseAssignmentDraft } from "../src/modules/agents/owner-release.ts";
import {
  assignmentHash,
  assignmentInput,
  confirmAssignment,
  proposeAssignment,
  setAssignmentStatus,
  updateAssignment,
} from "../src/modules/agents/assignments.ts";
import { planAssignmentRuns } from "../src/modules/agents/assignment-runs.ts";
import {
  channelSlots,
  slotContext,
  slotStatus,
} from "../src/modules/agents/scheduling.ts";
import { preflight } from "../src/modules/policy.ts";
import {
  deliverPostizDraft,
  markPostizDraftOutcomeUnknown,
  requeuePostizDrafts,
} from "../src/modules/agents/draft-delivery.ts";
import {
  runDeliverables,
  scheduleApproved,
} from "../src/modules/agents/veto.ts";
import {
  draftsAwaitingOwner,
  listAssignments,
  upcomingAssignmentPosts,
} from "../src/modules/agents/assignment-overview.ts";
import { sendNotification } from "../src/modules/agents/notification-sender.ts";
import {
  notify,
  planDailyReport,
} from "../src/modules/agents/notifications.ts";
import {
  handoffPostizDraft,
  resolvePostizDraft,
} from "../src/modules/postiz-draft.ts";
import { publishIntent } from "../src/modules/workflow.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
  tomorrowMorning,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
// Synthetic token in Telegram's shape; the fake transport below is the only "Telegram".
const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0123456";
const CHAT = "4711";

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

/** A fake Postiz client: records every call; `answer` decides each createPost. */
function fakePostiz(
  answer: (input: any) => Promise<any> = async () => ({
    remotePosts: [{ postId: `remote-${Math.random()}`, integration: X }],
    state: "accepted",
    requestedType: "draft",
  }),
  upload: () => Promise<any> = async () => ({ id: "media-1", path: "/m/1" }),
) {
  const posts: any[] = [];
  const uploads: any[] = [];
  return {
    posts,
    uploads,
    deps: {
      createClient: (() => ({
        uploadMedia: async (input: any) => {
          uploads.push(input);
          return upload();
        },
        createPost: async (input: any) => {
          posts.push(input);
          return answer(input);
        },
      })) as any,
      readAsset: async () => null,
    },
  };
}

/**
 * Delivery "Postiz draft" of assignment posts (R73): approved drafts are
 * only created as drafts in Postiz at their slot, never published by Orbit.
 */
describe.skipIf(!enabled)("Assignment delivery as Postiz drafts", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      String(a.briefKey).localeCompare(String(b.briefKey)),
    );
  const handoffs = async () =>
    (await h.rows("postiz_drafts")).sort((a, b) =>
      String(a.slotAt).localeCompare(String(b.slotAt)),
    );
  const jobs = async (topic: string) =>
    (await h.rows("jobs")).filter((job) => job.topic === topic);
  const notices = async (kind: string) =>
    (await h.rows("jobs")).filter((job) =>
      String(job.idempotencyKey ?? "").startsWith(`notify:${kind}:`),
    );
  /** Plans the run with one brief per slot and writes the drafts. */
  const drafted = async () => {
    const planned = await h.planWithBriefs((slots) =>
      slots.map((slot) => h.brief(slot)),
    );
    for (const copy of (await h.rows("agent_tasks")).filter(
      (t) => t.role === "copywriter",
    ))
      await runAgentTask(h.worker(), copy.id);
    return { review: await h.task("review"), ...planned };
  };
  /** Runs the review step: every draft approved; scheduling books what counts as approved. */
  const reviewed = async () => {
    const planned = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), planned.review.id);
    expect((await h.task("review")).status).toBe("done");
    return planned;
  };
  /** A bot bound to the owner, linked before the review (R50). */
  const linkBot = () =>
    h.run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status: "linked",
        encryptedToken: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
        chatId: CHAT,
        telegramUserId: CHAT,
        linkedUserId: project.owner.userId,
        linkedAt: new Date().toISOString(),
      }),
    );
  const deliver = (id: string, client = fakePostiz()) =>
    deliverPostizDraft(h.worker(), id, client.deps);

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    provider.replies = [];
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      return generated(`${BODY} (${String(contract.brief?.topic ?? "")})`);
    });
    project = await createPackageProject();
    h = assignmentRun(project);
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X],
      contentTypes: ["social"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    // A Postiz connector with a (synthetic) credential, as a draft handoff needs.
    await h.run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        baseUrl: "https://postiz.example.invalid",
        encryptedCredential: encrypt(
          "synthetic-token",
          process.env.CREDENTIAL_KEY!,
        ),
      });
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("books an agent-approved draft as one Postiz draft at its slot and publishes nothing", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    const { runId, slots } = await reviewed();
    const drafts = await contents();
    expect(drafts.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);

    // No publication, no publisher job, no preview: two booked drafts.
    expect(await h.rows("publications")).toEqual([]);
    expect(await jobs("publishing")).toEqual([]);
    expect(await notices("preview")).toEqual([]);
    const booked = await handoffs();
    expect(booked).toHaveLength(2);
    expect(booked[0]).toMatchObject({
      status: "queued",
      source: "assignment",
      contentId: drafts[0]!.id,
      contentVersion: drafts[0]!.version,
      integrationId: X,
      slotAt: slots[0]!.at,
      assignmentId: assignment.id,
      assignmentRunId: runId,
      approvedBy: "agent",
    });
    expect((await jobs("postiz_draft")).map((j) => j.idempotencyKey)).toEqual(
      expect.arrayContaining(booked.map((row) => `postiz_draft:${row.id}`)),
    );
    // The run's slots stay held by the drafts.
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots).toEqual([
      expect.objectContaining({
        at: slots[0]!.at,
        postizDraftId: booked[0]!.id,
      }),
      expect.objectContaining({
        at: slots[1]!.at,
        postizDraftId: booked[1]!.id,
      }),
    ]);
    expect(run!.slots.some((slot: any) => slot.releasedAt)).toBe(false);
    expect(run!.scheduling).toMatchObject({
      publicationIds: [],
      postizDraftIds: expect.arrayContaining(booked.map((row) => row.id)),
      dropped: [],
    });
    // The worker sends each once: type "draft", dated at the slot, on its channel.
    const client = fakePostiz();
    for (const row of booked) await deliver(row.id, client);
    expect(client.posts).toHaveLength(2);
    for (const [index, post] of client.posts.entries()) {
      expect(post.type).toBe("draft");
      expect(post.date).toBe(slots[index]!.at);
      expect(post.posts[0].integration).toEqual({ id: X });
      expect(post.posts[0].value[0].content).toContain(BODY);
    }
    expect(client.posts.map((post) => post.type)).not.toContain("now");
    expect(client.posts.map((post) => post.type)).not.toContain("schedule");
    const sent = await handoffs();
    expect(sent.map((row) => row.status)).toEqual(["accepted", "accepted"]);
    expect(sent[0]).toMatchObject({
      remoteType: "draft",
      remoteDate: slots[0]!.at,
    });
    // One notice per draft, without a Stop.
    expect(
      (await notices("postiz_draft")).map((j) => j.idempotencyKey).sort(),
    ).toEqual(sent.map((row) => `notify:postiz_draft:${row.id}`).sort());

    // Again: no second Postiz call, no second booking, still no publication.
    for (const row of sent) await deliver(row.id, client);
    await h.run((tx) => scheduleApproved(tx, project.owner, runId));
    expect(client.posts).toHaveLength(2);
    expect(await handoffs()).toHaveLength(2);
    expect(await h.rows("publications")).toEqual([]);
    // Every automatic approval is audited.
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: project.owner.projectId,
          action: "assignment.postiz_draft_booked",
        },
      }),
    );
    expect(audits).toHaveLength(2);
    // run_status sees the drafts in Postiz.
    const result = await h.run(async (tx) =>
      runDeliverables(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", runId),
      ),
    );
    expect(result.deliverables.map((d) => d.outcome)).toEqual([
      "postiz_draft",
      "postiz_draft",
    ]);
  });

  it("refuses to publish a draft-delivery assignment's content", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await contents();
    expect(
      await code(
        h.run((tx) =>
          publishIntent(tx, project.owner, {
            contentId: first!.id,
            version: first!.version,
          }),
        ),
      ),
    ).toMatch(/ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS/);
  });

  it("books the owner's release as a Postiz draft without a publish right", async () => {
    // Authority off: the agent's approval does not count; the drafts wait for the owner.
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { slots, runId } = await reviewed();
    const drafts = await contents();
    expect(drafts.map((c) => c.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
    expect(await handoffs()).toEqual([]);
    expect(
      await h.run((tx) => scheduleApproved(tx, project.owner, runId)),
    ).toEqual([]);
    const waiting = await h.run((tx) => draftsAwaitingOwner(tx, project.owner));
    expect(waiting.map((item) => item.delivery)).toEqual([
      "postiz_draft",
      "postiz_draft",
    ]);

    const released = await h.run((tx) =>
      releaseAssignmentDraft(
        tx,
        project.owner,
        drafts[0]!.id,
        drafts[0]!.version,
      ),
    );
    expect(released).toMatchObject({
      result: "released",
      delivery: "postiz_draft",
      publicationId: null,
      postizDraftId: expect.any(String),
      scheduledAt: slots[0]!.at,
    });
    // Released again: the same handoff.
    const current = (await contents())[0]!;
    expect(
      await h.run((tx) =>
        releaseAssignmentDraft(tx, project.owner, current.id, current.version),
      ),
    ).toMatchObject({
      result: "already_released",
      postizDraftId: released.postizDraftId,
    });
    expect(await h.rows("publications")).toEqual([]);
    expect(await jobs("publishing")).toEqual([]);
    // No publish right for the draft-only mission.
    const mission = await h.run(async (tx) =>
      data(await entity(tx, project.owner, "missions", drafts[0]!.missionId)),
    );
    expect(mission.allowedActions).toEqual(["draft"]);
    expect(mission.publishAuthorizedBy).toBeUndefined();
    const [handoff] = await handoffs();
    expect(handoff).toMatchObject({
      id: released.postizDraftId,
      status: "queued",
      approvedBy: "owner",
      slotAt: slots[0]!.at,
    });
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({ postizDraftId: handoff!.id });

    const client = fakePostiz();
    await deliver(handoff!.id, client);
    await deliver(handoff!.id, client);
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]).toMatchObject({
      type: "draft",
      date: slots[0]!.at,
    });
    expect((await handoffs())[0]!.status).toBe("accepted");

    // The upcoming posts list it as a draft in Postiz (no Stop).
    const upcoming = await h.run((tx) =>
      upcomingAssignmentPosts(tx, project.owner),
    );
    expect(upcoming).toEqual([
      expect.objectContaining({
        id: handoff!.id,
        delivery: "postiz_draft",
        status: "accepted",
        scheduledAt: slots[0]!.at,
        vetoDeadline: null,
        ownerReleased: true,
      }),
    ]);
  });

  it("records an unclear Postiz answer as outcome_unknown and never sends it again", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    const client = fakePostiz(async () => {
      throw new ConnectorError("TIMEOUT", "unknown");
    });
    await deliver(first!.id, client);
    expect((await handoffs())[0]).toMatchObject({
      status: "outcome_unknown",
      error: "TIMEOUT",
      failedStep: "create_post",
    });
    expect(
      (await h.rows("exceptions")).some(
        (row) =>
          row.code === "POSTIZ_DRAFT_OUTCOME_UNKNOWN" ||
          JSON.stringify(row).includes("POSTIZ_DRAFT_OUTCOME_UNKNOWN"),
      ),
    ).toBe(true);
    expect(
      (await notices("postiz_error")).map((j) => j.idempotencyKey),
    ).toContain(`notify:postiz_error:${first!.id}`);
    // No retry: neither the job again nor the sweep.
    await deliver(first!.id, client);
    const before = (await jobs("postiz_draft")).length;
    await h.run((tx) => requeuePostizDrafts(tx, project.owner));
    expect(client.posts).toHaveLength(1);
    // The sweep queues no new job for it.
    expect(await jobs("postiz_draft")).toHaveLength(before);
    // The slot stays held: the draft may exist in Postiz.
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({ postizDraftId: first!.id });
    expect(run!.slots[0].releasedAt).toBeUndefined();
    // The owner resolves it with the existing action.
    const resolved = await h.run((tx) =>
      resolvePostizDraft(tx, project.owner, {
        handoffId: first!.id,
        resolution: "exists",
        confirmCheckedInPostiz: true,
      }),
    );
    expect(data(resolved).status).toBe("accepted");
  });

  it("marks a send interrupted by a crash unclear without calling Postiz", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "postiz_drafts", first!.id);
      await update(tx, project.owner, row, { ...data(row), status: "sending" });
    });
    const client = fakePostiz();
    await deliver(first!.id, client);
    expect(client.posts).toEqual([]);
    expect((await handoffs())[0]!.status).toBe("outcome_unknown");
    // The worker's lease recovery does the same for a handoff left sending.
    const second = (await handoffs())[1]!;
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "postiz_drafts", second.id);
      await update(tx, project.owner, row, { ...data(row), status: "sending" });
      await markPostizDraftOutcomeUnknown(tx, h.worker(), second.id);
    });
    expect((await handoffs())[1]!.status).toBe("outcome_unknown");
  });

  it("drops a draft after a clear rejection and gives its slot back", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { slots } = await reviewed();
    const [first] = await handoffs();
    const client = fakePostiz(async () => {
      throw new ConnectorError("HTTP_400", "rejected");
    });
    await deliver(first!.id, client);
    expect((await handoffs())[0]).toMatchObject({
      status: "failed",
      error: "HTTP_400",
    });
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({
      postizDraftId: first!.id,
      releasedAt: expect.any(String),
      releaseReason: "HTTP_400",
    });
    expect(run!.scheduling.dropped).toEqual([
      expect.objectContaining({
        contentId: first!.contentId,
        code: "HTTP_400",
        requestedAt: slots[0]!.at,
      }),
    ]);
    expect((await notices("dropped")).map((j) => j.idempotencyKey)).toEqual([
      `notify:dropped:${first!.contentId}`,
    ]);
    // Not sent again.
    await deliver(first!.id, client);
    expect(client.posts).toHaveLength(1);
  });

  it("sends the draft without its image when the image fails, and records it", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    const client = fakePostiz(undefined, async () => {
      throw new ConnectorError("PROVIDER_REJECTED", "unknown", false, 500);
    });
    client.deps.readAsset = (async () => ({
      bytes: Buffer.from("png"),
      mime: "image/png",
    })) as any;
    await deliver(first!.id, client);
    expect(client.uploads).toHaveLength(1);
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].posts[0].value[0].image).toEqual([]);
    expect((await handoffs())[0]).toMatchObject({
      status: "accepted",
      withoutImage: true,
      imageError: "PROVIDER_REJECTED",
    });
  });

  it("withdraws booked drafts that were not sent when the assignment pauses", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first, second] = await handoffs();
    await deliver(first!.id);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    const after = await handoffs();
    // The one in Postiz stays (withdrawn there); the queued one is canceled.
    expect(after.map((row) => row.status)).toEqual(["accepted", "canceled"]);
    expect(after[1]!.reason).toBe("ASSIGNMENT_PAUSED");
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[1]).toMatchObject({
      postizDraftId: second!.id,
      releasedAt: expect.any(String),
    });
    expect(run!.slots[0].releasedAt).toBeUndefined();
    const client = fakePostiz();
    await deliver(second!.id, client);
    expect(client.posts).toEqual([]);
  });

  it("queues a draft held back by a project pause again after the resume", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    // The worker blocked the first job while the project was paused.
    await h.run(async (tx) => {
      for (const job of (await list(tx, project.owner, "jobs")).filter(
        (row) => data(row).resourceId === first!.id,
      ))
        await update(tx, project.owner, job, {
          ...data(job),
          status: "blocked_dependency",
          error: "PROJECT_PAUSED",
        });
    });
    const before = (await jobs("postiz_draft")).length;
    expect(
      await h.run((tx) => requeuePostizDrafts(tx, project.owner)),
    ).toMatchObject({ requeued: 1, unknown: 0, expired: 0 });
    expect(
      (await jobs("postiz_draft")).filter(
        (job) => job.resourceId === first!.id && job.status === "queued",
      ),
    ).toHaveLength(1);
    expect(await jobs("postiz_draft")).toHaveLength(before + 1);
    // Once is enough: no further job.
    expect(
      await h.run((tx) => requeuePostizDrafts(tx, project.owner)),
    ).toMatchObject({ requeued: 0 });
    expect(await jobs("postiz_draft")).toHaveLength(before + 1);
  });

  it("drops the drafts with a notice when Postiz drafts are switched off at run time", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    // Switched off after the run was planned and drafted.
    const planned = await drafted();
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), planned.review.id);
    const runId = planned.runId;
    expect(await handoffs()).toEqual([]);
    expect(await h.rows("publications")).toEqual([]);
    const [run] = await h.rows("assignment_runs");
    expect(run!.scheduling.dropped.map((entry: any) => entry.code)).toEqual([
      "POSTIZ_DRAFTS_DISABLED",
      "POSTIZ_DRAFTS_DISABLED",
    ]);
    expect(run!.slots.every((slot: any) => slot.releasedAt)).toBe(true);
    expect(await notices("dropped")).toHaveLength(2);
    expect(run!.id).toBe(runId);
  });

  it("drops a booked draft whose send finds Postiz drafts switched off", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
    const client = fakePostiz();
    await deliver(first!.id, client);
    expect(client.posts).toEqual([]);
    expect((await handoffs())[0]).toMatchObject({
      status: "failed",
      error: "POSTIZ_DRAFTS_DISABLED",
    });
    expect((await notices("dropped")).map((j) => j.idempotencyKey)).toEqual([
      `notify:dropped:${first!.contentId}`,
    ]);
  });

  it("refuses draft delivery at proposal and confirmation while Postiz drafts are off", async () => {
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
    const thread = await createConversation(project.editor);
    const input = {
      name: "Drafts only",
      kind: "standing",
      schedule: { rhythm: "daily", weekdays: [], times: ["10:00"] },
      contentType: "social",
      channels: [X],
      topicFrame: "Short updates about beta access for product teams",
      image: false,
      styleAssetIds: [],
      monthlyBudgetMicros: 10_000_000,
      delivery: "postiz_draft",
    };
    expect(
      await code(proposeAssignment(project.editor, thread.id, input)),
    ).toBe("POSTIZ_DRAFTS_DISABLED");
    // Proposed while on, confirmed while off.
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    const { assignment } = await proposeAssignment(
      project.editor,
      thread.id,
      input,
    );
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
    expect(
      await code(
        h.run((tx) =>
          confirmAssignment(
            tx,
            project.owner,
            assignment.id,
            assignment.version,
          ),
        ),
      ),
    ).toBe("POSTIZ_DRAFTS_DISABLED");
    // Publishing assignments are not affected.
    expect(
      await code(
        proposeAssignment(project.editor, thread.id, {
          ...input,
          delivery: "publish",
        }),
      ),
    ).toBeNull();
    // Only social posts can be drafts.
    expect(
      assignmentInput.safeParse({ ...input, contentType: "blog" }).success,
    ).toBe(false);
  });

  it("covers the delivery in the confirmation hash; publish keeps the old hash", async () => {
    const content = {
      name: "Two posts a day",
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
    };
    const legacy = assignmentHash(content);
    expect(assignmentHash({ ...content, delivery: "publish" })).toBe(legacy);
    expect(assignmentHash({ ...content, delivery: "postiz_draft" })).not.toBe(
      legacy,
    );
    // A row from before R73 counts as publish on the assignments page.
    await h.makeAssignment();
    await h.makeAssignment({ name: "Drafts", delivery: "postiz_draft" });
    const listed = await h.run((tx) => listAssignments(tx, project.owner));
    expect(
      listed.items.map((item) => [item.name, item.delivery]).sort(),
    ).toEqual([
      ["Drafts", "postiz_draft"],
      ["Two posts a day", "publish"],
    ]);
  });

  it("sends the Telegram notice of a draft in Postiz without a Stop, and the daily report counts it", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { slots } = await reviewed();
    const [first] = await handoffs();
    await deliver(first!.id);
    const job = (await notices("postiz_draft"))[0]!;
    const calls: Array<{ method: string; body: Record<string, any> }> = [];
    const fetch = async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        method: String(url).split("/").pop()!,
        body: JSON.parse(String(init.body ?? "{}")),
      });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: calls.length } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await sendNotification(h.worker(), job.id, {
      fetch,
      sleep: async () => {},
    });
    const sent = calls.filter((call) => call.method.startsWith("send"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!.body.text);
    expect(text).toMatch(/^Entwurf in Postiz angelegt: Synthetic X, /);
    expect(text).toContain(
      new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(slots[0]!.at)),
    );
    expect(text).toContain(BODY);
    expect(JSON.stringify(sent[0]!.body)).not.toContain("Stop");

    // The daily report of today counts the draft.
    vi.useFakeTimers({ toFake: ["Date"] });
    const evening = new Date();
    evening.setUTCHours(21, 0, 0, 0);
    vi.setSystemTime(evening);
    await h.run((tx) => planDailyReport(tx, project.owner, evening));
    const report = (await notices("daily_report"))[0]!;
    vi.useRealTimers();
    calls.length = 0;
    await sendNotification(h.worker(), report.id, {
      fetch,
      sleep: async () => {},
    });
    expect(String(calls[0]!.body.text)).toContain("Entwürfe an Postiz: 1");
  });

  // ---- Fix round (review findings I1–I3, M1–M8) ----

  /** The text of one notification job as the fake Telegram receives it. */
  const telegramText = async (jobId: string) => {
    const calls: Array<{ method: string; body: Record<string, any> }> = [];
    const fetch = async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        method: String(url).split("/").pop()!,
        body: JSON.parse(String(init.body ?? "{}")),
      });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: calls.length } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await sendNotification(h.worker(), jobId, {
      fetch,
      sleep: async () => {},
    });
    return calls
      .filter((call) => call.method.startsWith("send"))
      .map((call) => String(call.body.text ?? call.body.caption ?? ""))
      .join("\n");
  };
  const handoffOf = async (id: string) =>
    (await handoffs()).find((row) => row.id === id)!;
  const blockersOf = (contentId: string) =>
    h.run(
      async (tx) =>
        (
          await preflight(tx, project.owner, contentId, {
            test: true,
            ignoreApproval: true,
          })
        ).blockers,
    );
  /** Drafts left for the owner (authority off), the first one released by the owner. */
  const releasedByOwner = async (delivery: "publish" | "postiz_draft") => {
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await linkBot();
    const assignment = await h.makeAssignment({ delivery });
    const planned = await reviewed();
    const drafts = await contents();
    const released = await h.run((tx) =>
      releaseAssignmentDraft(
        tx,
        project.owner,
        drafts[0]!.id,
        drafts[0]!.version,
      ),
    );
    return { assignment, drafts, released, ...planned };
  };
  const assignmentRow = (id: string) =>
    h.run((tx) => entity(tx, project.owner, "assignments", id));

  it("stamps the confirmed delivery on the drafts' missions and contents (I1)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await drafted();
    for (const draft of await contents()) {
      expect(draft.delivery).toBe("postiz_draft");
      const mission = await h.run(async (tx) =>
        data(await entity(tx, project.owner, "missions", draft.missionId)),
      );
      expect(mission.delivery).toBe("postiz_draft");
    }
  });

  it("blocks by the confirmed delivery: an unconfirmed switch to drafts neither blocks nor withdraws, the confirmed one does (I1)", async () => {
    const { assignment, drafts, released } = await releasedByOwner("publish");
    expect(released.delivery).toBe("publish");
    expect(drafts[0]!.delivery).toBe("publish");
    expect(await blockersOf(drafts[0]!.id)).not.toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    // Unconfirmed: the live row says drafts, nothing changes for the released post.
    const row = await assignmentRow(assignment.id);
    await h.run((tx) =>
      updateAssignment(tx, project.editor, assignment.id, row.version, {
        delivery: "postiz_draft",
      }),
    );
    expect(await blockersOf(drafts[0]!.id)).not.toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    const [pub] = await h.rows("publications");
    expect(pub!.status).toBe("intent_created");
    // Confirmed: the released post is withdrawn with a notice, and blocked.
    const draftRow = await assignmentRow(assignment.id);
    const confirmed = await h.run((tx) =>
      confirmAssignment(tx, project.owner, assignment.id, draftRow.version),
    );
    expect(data(confirmed).confirmation.delivery).toBe("postiz_draft");
    expect((await h.rows("publications"))[0]).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_DELIVERY_CHANGED",
    });
    expect(await blockersOf(drafts[0]!.id)).toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    const [notice] = await notices("delivery_changed");
    expect(notice!.idempotencyKey).toBe(
      `notify:delivery_changed:${assignment.id}:${confirmed.version}`,
    );
    expect(await telegramText(notice!.id)).toContain("1 Beitrag zurückgezogen");
  });

  it("keeps the drafts' block on an unconfirmed switch to publishing and cancels the booked draft once confirmed (I1)", async () => {
    const { assignment, drafts, released } =
      await releasedByOwner("postiz_draft");
    expect(released.delivery).toBe("postiz_draft");
    expect(await blockersOf(drafts[0]!.id)).toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    const row = await assignmentRow(assignment.id);
    await h.run((tx) =>
      updateAssignment(tx, project.editor, assignment.id, row.version, {
        delivery: "publish",
      }),
    );
    // Unconfirmed: the stamp keeps blocking; the owner-released draft stays booked (R71).
    expect(await blockersOf(drafts[0]!.id)).toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    expect((await handoffOf(released.postizDraftId!)).status).toBe("queued");
    const draftRow = await assignmentRow(assignment.id);
    const confirmed = await h.run((tx) =>
      confirmAssignment(tx, project.owner, assignment.id, draftRow.version),
    );
    expect(data(confirmed).confirmation.delivery).toBe("publish");
    expect(await handoffOf(released.postizDraftId!)).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_DELIVERY_CHANGED",
    });
    // A text approved for drafts only is never published, also after the switch.
    expect(await blockersOf(drafts[0]!.id)).toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
    const [notice] = await notices("delivery_changed");
    expect(await telegramText(notice!.id)).toContain("1 Beitrag zurückgezogen");
  });

  it("leaves content of no assignment alone (I1)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await drafted();
    const [draft] = await contents();
    const {
      id: _id,
      version: _version,
      assignmentId: _a,
      assignmentRunId: _r,
      delivery: _d,
      briefKey: _b,
      ...rest
    } = draft!;
    const unrelated = await h.run((tx) =>
      create(tx, project.owner, "content", rest),
    );
    expect(await blockersOf(unrelated.id)).not.toContain(
      "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS",
    );
  });

  it("keeps a draft-held slot from other assignments and packages (I3)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { slots } = await reviewed();
    expect(await handoffs()).toHaveLength(2);
    // Slot rules see the run's draft at the slot.
    const status = await h.run(async (tx) =>
      slotStatus(
        await slotContext(tx, project.owner),
        X,
        new Date(slots[1]!.at),
      ),
    );
    expect(status.free).toBe(false);
    expect(status.occupiedBy).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "run" })]),
    );
    // A package does not get the 17:00 slot.
    const packages = await h.run((tx) =>
      channelSlots(tx, project.owner, { channels: [X], days: 3 }),
    );
    expect(
      packages.channels[0]!.slots.find((slot) => slot.at === slots[1]!.at)!
        .free,
    ).toBe(false);
    // Another assignment with the same times gets no slot that day, so no run (R75).
    const other = await h.makeAssignment({ name: "Second assignment" });
    await h.run((tx) =>
      planAssignmentRuns(tx, project.owner, tomorrowMorning()),
    );
    expect(
      (await h.rows("assignment_runs")).some(
        (run) => run.assignmentId === other.id,
      ),
    ).toBe(false);
    const skip = await h.run((tx) =>
      tx.auditEvent.findFirst({
        where: {
          projectId: project.owner.projectId,
          action: "assignment.day_skipped",
          resourceId: { startsWith: `${other.id}:` },
        },
      }),
    );
    expect(
      ((skip!.metadata as any).entries as any[]).map(
        (entry) => entry.requestedAt,
      ),
    ).toEqual(slots.map((slot) => slot.at));
  });

  it("cancels booked drafts when the assignment ends or its content changes (I3)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const row = await assignmentRow(assignment.id);
    await h.run((tx) =>
      updateAssignment(tx, project.editor, assignment.id, row.version, {
        topicFrame: "Weekly deep dives on beta access for teams",
      }),
    );
    expect((await handoffs()).map((h) => [h.status, h.reason])).toEqual([
      ["canceled", "ASSIGNMENT_CHANGED"],
      ["canceled", "ASSIGNMENT_CHANGED"],
    ]);
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots.every((slot: any) => slot.releasedAt)).toBe(true);
  });

  it("cancels booked drafts when the assignment ends (I3)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "ended"),
    );
    expect((await handoffs()).map((h) => h.reason)).toEqual([
      "ASSIGNMENT_ENDED",
      "ASSIGNMENT_ENDED",
    ]);
  });

  it("cancels booked drafts on a time change and counts them in the notice (I3, M4)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const row = await assignmentRow(assignment.id);
    const saved = await h.run((tx) =>
      updateAssignment(tx, project.owner, assignment.id, row.version, {
        schedule: { ...data(row).schedule, times: ["11:00", "18:00"] },
      }),
    );
    expect((await handoffs()).map((h) => h.reason)).toEqual([
      "ASSIGNMENT_RETIMED",
      "ASSIGNMENT_RETIMED",
    ]);
    const [notice] = await notices("retimed");
    expect(notice!.idempotencyKey).toBe(
      `notify:retimed:${assignment.id}:${saved.version}`,
    );
    expect(await telegramText(notice!.id)).toContain(
      "2 geplante Beiträge zurückgezogen",
    );
  });

  it("cancels booked drafts when the budget is used up and counts them in the notice (I3, M4)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const saved = await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "budget_exhausted"),
    );
    expect((await handoffs()).map((h) => h.reason)).toEqual([
      "ASSIGNMENT_PAUSED",
      "ASSIGNMENT_PAUSED",
    ]);
    const job = await h.run((tx) =>
      notify(
        tx,
        project.owner,
        "budget_paused",
        `${assignment.id}:${saved.version}`,
      ),
    );
    expect(await telegramText(job!.id)).toContain(
      "2 geplante Beiträge zurückgezogen",
    );
  });

  it("keeps an owner-released draft on a content change and cancels it on pause (I3, R71)", async () => {
    const { assignment, released } = await releasedByOwner("postiz_draft");
    const row = await assignmentRow(assignment.id);
    await h.run((tx) =>
      updateAssignment(tx, project.editor, assignment.id, row.version, {
        topicFrame: "Weekly deep dives on beta access for teams",
      }),
    );
    expect((await handoffOf(released.postizDraftId!)).status).toBe("queued");
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "ended"),
    );
    expect(await handoffOf(released.postizDraftId!)).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_ENDED",
    });
  });

  describe("send-time checks", () => {
    const booked = async () => {
      await linkBot();
      const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
      const planned = await reviewed();
      const [first] = await handoffs();
      return { assignment, first: first!, ...planned };
    };

    it("withdraws a booked draft when Orbit Agents is off", async () => {
      const { first } = await booked();
      delete process.env.ORBIT_AGENTS;
      const client = fakePostiz();
      await deliver(first.id, client);
      process.env.ORBIT_AGENTS = "true";
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "canceled",
        reason: "AGENTS_DISABLED",
      });
    });

    it("withdraws a booked draft whose assignment is no longer confirmed", async () => {
      const { assignment, first } = await booked();
      await h.run(async (tx) => {
        const row = await entity(
          tx,
          project.owner,
          "assignments",
          assignment.id,
        );
        await update(tx, project.owner, row, {
          ...data(row),
          confirmation: { ...data(row).confirmation, assignmentHash: "other" },
        });
      });
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "canceled",
        reason: "ASSIGNMENT_NOT_CONFIRMED",
      });
    });

    it("withdraws a booked draft of a canceled run", async () => {
      const { first, runId } = await booked();
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "assignment_runs", runId);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "canceled",
        });
      });
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect((await handoffOf(first.id)).reason).toBe("RUN_CANCELED");
    });

    it("drops a booked draft whose slot has passed", async () => {
      const { first, slots } = await booked();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.parse(slots[0]!.at) + 60000));
      const client = fakePostiz();
      await deliver(first.id, client);
      vi.useRealTimers();
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "failed",
        error: "SLOT_UNAVAILABLE",
      });
      expect((await notices("dropped")).map((j) => j.idempotencyKey)).toEqual([
        `notify:dropped:${first.contentId}`,
      ]);
    });

    it("drops a booked draft that a deterministic blocker stops at send", async () => {
      const { first } = await booked();
      await h.setPolicy({ allowedOrigins: [] });
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({ status: "failed" });
      expect((await handoffOf(first.id)).error).toMatch(/LINK_NOT_ALLOWED/);
    });

    it("withdraws an agent-approved draft with a notice when the agent review no longer counts (M2)", async () => {
      const { first } = await booked();
      delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "canceled",
        reason: "AGENT_REVIEW_NOT_ACCEPTED",
      });
      const [notice] = await notices("dropped");
      expect(notice!.idempotencyKey).toBe(`notify:dropped:${first.contentId}`);
      expect(await telegramText(notice!.id)).toContain("Agenten-Freigabe");
    });

    it("fails a draft whose send cannot be prepared instead of leaving it queued (I2c)", async () => {
      const { first } = await booked();
      await h.run(async (tx) => {
        const connector = (await list(tx, project.owner, "connectors")).find(
          (row) => data(row).provider === "postiz",
        )!;
        await update(tx, project.owner, connector, {
          ...data(connector),
          encryptedCredential: "not-a-credential",
        });
      });
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "failed",
        // The credential cannot be read: a clear failure, nothing was sent.
        error: "INVALID_ENCRYPTED_CREDENTIAL",
      });
    });

    it("records the draft the owner already handed over as existing and keeps the slot (M8)", async () => {
      const { first, runId } = await booked();
      const manual = await h.run((tx) =>
        create(tx, project.owner, "postiz_drafts", {
          contentId: first.contentId,
          contentVersion: first.contentVersion,
          integrationId: X,
          status: "accepted",
          remoteId: "manual-draft",
          remoteType: "draft",
          remoteDate: first.slotAt,
        }),
      );
      const client = fakePostiz();
      await deliver(first.id, client);
      expect(client.posts).toEqual([]);
      expect(await handoffOf(first.id)).toMatchObject({
        status: "accepted",
        alreadyInPostiz: true,
        existingHandoffId: manual.id,
        remoteId: "manual-draft",
      });
      const [run] = await h.rows("assignment_runs");
      expect(run!.slots[0].releasedAt).toBeUndefined();
      expect(run!.scheduling.dropped).toEqual([]);
      const result = await h.run(async (tx) =>
        runDeliverables(
          tx,
          project.owner,
          await entity(tx, project.owner, "assignment_runs", runId),
        ),
      );
      expect(
        result.deliverables.find((d) => d.contentId === first.contentId),
      ).toMatchObject({
        outcome: "postiz_draft",
        reason: "POSTIZ_DRAFT_EXISTS",
      });
    });

    it("keeps an unclear outcome when the HTTP answer comes late (M7)", async () => {
      const { first } = await booked();
      const client = fakePostiz(async () => {
        // Meanwhile the send was declared unclear (lease recovery).
        await h.run(async (tx) => {
          await markPostizDraftOutcomeUnknown(tx, h.worker(), first.id);
        });
        return {
          remotePosts: [{ postId: "late-draft", integration: X }],
          state: "accepted",
          requestedType: "draft",
        };
      });
      await deliver(first.id, client);
      const row = await handoffOf(first.id);
      expect(row).toMatchObject({
        status: "outcome_unknown",
        lateResult: { status: "accepted", remoteId: "late-draft" },
      });
      expect(await notices("postiz_draft")).toEqual([]);
      expect(
        (await h.rows("exceptions")).some(
          (e) =>
            JSON.stringify(e).includes("POSTIZ_DRAFT_OUTCOME_UNKNOWN") &&
            e.status === "open",
        ),
      ).toBe(true);
    });
  });

  it("marks a send whose job is gone unclear in the sweep (I2a)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [first] = await handoffs();
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "postiz_drafts", first!.id);
      await update(tx, project.owner, row, { ...data(row), status: "sending" });
      for (const job of (await list(tx, project.owner, "jobs")).filter(
        (job) => data(job).resourceId === first!.id,
      ))
        await update(tx, project.owner, job, {
          ...data(job),
          status: "succeeded",
        });
    });
    const before = (await jobs("postiz_draft")).length;
    expect(
      await h.run((tx) => requeuePostizDrafts(tx, project.owner)),
    ).toMatchObject({ unknown: 1, requeued: 0 });
    expect((await handoffOf(first!.id)).status).toBe("outcome_unknown");
    expect(
      (await notices("postiz_error")).map((j) => j.idempotencyKey),
    ).toContain(`notify:postiz_error:${first!.id}`);
    expect(
      (await h.rows("exceptions")).some((e) =>
        JSON.stringify(e).includes("POSTIZ_DRAFT_OUTCOME_UNKNOWN"),
      ),
    ).toBe(true);
    expect(await jobs("postiz_draft")).toHaveLength(before);
  });

  it("ends queued drafts whose slot passed in the sweep (I2b)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { slots } = await reviewed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(slots[0]!.at) + 60000));
    const result = await h.run((tx) => requeuePostizDrafts(tx, project.owner));
    vi.useRealTimers();
    expect(result).toMatchObject({ expired: 1 });
    const [first, second] = await handoffs();
    expect(first).toMatchObject({
      status: "failed",
      error: "SLOT_UNAVAILABLE",
    });
    expect(second!.status).toBe("queued");
    expect((await notices("dropped")).map((j) => j.idempotencyKey)).toEqual([
      `notify:dropped:${first!.contentId}`,
    ]);
  });

  it("refuses the owner's own handoff of a draft the assignment has queued (M1)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    await reviewed();
    const [draft] = await contents();
    expect(
      await code(
        handoffPostizDraft(
          project.owner,
          {
            contentId: draft!.id,
            version: draft!.version,
            confirmDraftOnly: true,
          },
          fakePostiz().deps,
        ),
      ),
    ).toBe("POSTIZ_DRAFT_QUEUED");
  });

  it("plans no run while Postiz drafts are off and says so once a day (M3)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ delivery: "postiz_draft" });
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
    for (let i = 0; i < 2; i++)
      await h.run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
    expect(await h.rows("assignment_runs")).toEqual([]);
    expect(await h.rows("agent_tasks")).toEqual([]);
    const sent = await notices("drafts_disabled");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toMatch(
      new RegExp(
        `^notify:drafts_disabled:${assignment.id}:\\d{4}-\\d{2}-\\d{2}$`,
      ),
    );
    expect(
      await h.run((tx) =>
        tx.budgetReservation.count({
          where: { projectId: project.owner.projectId },
        }),
      ),
    ).toBe(0);
    expect(await telegramText(sent[0]!.id)).toContain(
      "Entwürfe an Postiz sind ausgeschaltet",
    );
  });

  it("frees the slot of a draft resolved as not created and counts one resolved as existing (M5)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { runId } = await reviewed();
    const [first, second] = await handoffs();
    const unclear = fakePostiz(async () => {
      throw new ConnectorError("TIMEOUT", "unknown");
    });
    await deliver(first!.id, unclear);
    await deliver(second!.id, unclear);
    await h.run((tx) =>
      resolvePostizDraft(tx, project.owner, {
        handoffId: first!.id,
        resolution: "not_created",
        confirmCheckedInPostiz: true,
      }),
    );
    await h.run((tx) =>
      resolvePostizDraft(tx, project.owner, {
        handoffId: second!.id,
        resolution: "exists",
        confirmCheckedInPostiz: true,
      }),
    );
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({
      postizDraftId: first!.id,
      releasedAt: expect.any(String),
    });
    expect(run!.slots[1].releasedAt).toBeUndefined();
    expect(run!.scheduling.dropped).toEqual([
      expect.objectContaining({
        contentId: first!.contentId,
        code: "POSTIZ_DRAFT_NOT_CREATED",
      }),
    ]);
    const result = await h.run(async (tx) =>
      runDeliverables(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", runId),
      ),
    );
    expect(result.deliverables.map((d) => [d.contentId, d.outcome])).toEqual([
      [first!.contentId, "postiz_draft_failed"],
      [second!.contentId, "postiz_draft"],
    ]);
    const accepted = await h.run((tx) =>
      tx.auditEvent.count({
        where: {
          projectId: project.owner.projectId,
          action: "postiz_draft.accepted",
          resourceId: second!.id,
        },
      }),
    );
    expect(accepted).toBe(1);
  });

  it("reports a draft that failed in Postiz as failed in run_status (M5)", async () => {
    await linkBot();
    await h.makeAssignment({ delivery: "postiz_draft" });
    const { runId } = await reviewed();
    const [first] = await handoffs();
    await deliver(
      first!.id,
      fakePostiz(async () => {
        throw new ConnectorError("HTTP_400", "rejected");
      }),
    );
    const result = await h.run(async (tx) =>
      runDeliverables(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", runId),
      ),
    );
    expect(
      result.deliverables.find((d) => d.contentId === first!.contentId),
    ).toMatchObject({ outcome: "postiz_draft_failed", reason: "HTTP_400" });
  });
});

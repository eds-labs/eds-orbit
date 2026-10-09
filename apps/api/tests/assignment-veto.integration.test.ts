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
  requests: [] as any[],
  replies: [] as Array<(request: any) => Reply>,
  // A slot lookup fails after `after` good ones, in JavaScript or in the database (R54, R58).
  slotFailure: null as null | { after: number; kind: "js" | "sql" },
  // Live preconditions outside this task: an evaluated live index and a Postiz client.
  liveIndex: false,
  createPost: vi.fn(),
}));
vi.mock("../src/modules/agents/scheduling.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/modules/agents/scheduling.ts")
    >();
  return {
    ...actual,
    slotContext: async (...args: Parameters<typeof actual.slotContext>) => {
      const failure = provider.slotFailure;
      if (failure && failure.after > 0) failure.after--;
      else if (failure) {
        provider.slotFailure = null;
        // A real Postgres error: it aborts the surrounding transaction.
        if (failure.kind === "sql") await args[0].$queryRaw`SELECT 1/0`;
        throw new Error("synthetic scheduling outage");
      }
      return actual.slotContext(...args);
    },
  };
});
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
vi.mock("../../../packages/connectors/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/connectors/src/index.ts")
    >();
  return {
    ...actual,
    createPostizClient: (...args: any[]) =>
      provider.liveIndex
        ? { createPost: provider.createPost, uploadMedia: vi.fn() }
        : (actual.createPostizClient as any)(...args),
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
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  create,
  data,
  DomainError,
  encrypt,
  entity,
  list,
  update,
} from "../src/shared.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { setAssignmentStatus } from "../src/modules/agents/assignments.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import {
  scheduleApproved,
  vetoPublication,
} from "../src/modules/agents/veto.ts";
import { preflight } from "../src/modules/policy.ts";
import { dispatchPublication } from "../src/modules/publisher.ts";
import {
  claimPublication,
  finishPublication,
  publishIntent,
  reviewContent,
} from "../src/modules/workflow.ts";
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
  tomorrowMorning,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
const MINUTE = 60000;

type Verdict = { verdict: "approve" | "reject"; reasons?: string[] };

/** The drafts a review request showed the model. */
const shown = (request: any): Array<Record<string, any>> =>
  JSON.parse(request.input[0].content).drafts;

/** A recorded review answer: one verdict per shown draft. */
const answer =
  (decide: (draft: Record<string, any>) => Verdict) =>
  (request: any): Reply => ({
    output: [
      message({
        decisions: shown(request).map((draft) => ({
          contentId: draft.contentId,
          reasons: [],
          revisionInstructions: null,
          ...decide(draft),
        })),
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

describe.skipIf(!enabled)("Scheduling with the veto window", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  /** Drafts of the run, in slot order (brief key = channel@slot). */
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      String(a.briefKey).localeCompare(String(b.briefKey)),
    );
  const publications = async () =>
    (await h.rows("publications")).sort((a, b) =>
      String(a.scheduledAt).localeCompare(String(b.scheduledAt)),
    );
  const previews = async () =>
    (await h.rows("jobs")).filter(
      (job) => job.topic === "telegram_notification",
    );
  /** Plans a run with one brief per slot and writes the drafts; returns the review task and slots. */
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
  /** Runs the review task with the given verdicts; the run then schedules what was approved. */
  const reviewed = async (
    taskId: string,
    decide: (draft: Record<string, any>) => Verdict = () => ({
      verdict: "approve",
    }),
  ) => {
    provider.replies.push(answer(decide));
    await runAgentTask(h.worker(), taskId);
    expect((await h.task("review")).status).toBe("done");
  };
  /** A confirmed assignment whose run's drafts were approved and scheduled. */
  const scheduled = async () => {
    await h.connectTelegram();
    const assignment = await h.makeAssignment();
    const planned = await drafted();
    await reviewed(planned.review.id);
    return { assignment, ...planned, pubs: await publications() };
  };
  const at = (iso: string, minutes = 0) =>
    new Date(Date.parse(iso) + minutes * MINUTE);

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    provider.requests = [];
    provider.replies = [];
    provider.slotFailure = null;
    provider.liveIndex = false;
    provider.createPost.mockReset();
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
      channels: [X, TELEGRAM, BLOG],
      contentTypes: ["social", "blog"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("schedules approved drafts with a veto deadline and a preview", async () => {
    await h.connectTelegram();
    const assignment = await h.makeAssignment();
    const { review, runId, slots } = await drafted();
    const [first, second] = await contents();
    await reviewed(review.id, (draft) =>
      draft.contentId === first!.id
        ? { verdict: "reject", reasons: ["Off brand."] }
        : { verdict: "approve" },
    );

    // One publication, for the approved draft only, at its slot.
    const pubs = await publications();
    expect(pubs).toHaveLength(1);
    const [pub] = pubs;
    const approved = (await contents())[1]!;
    expect(approved.id).toBe(second!.id);
    expect(pub).toMatchObject({
      contentId: approved.id,
      contentVersion: approved.version,
      channel: X,
      status: "intent_created",
      scheduledAt: slots[1]!.at,
      vetoDeadline: at(slots[1]!.at, -180).toISOString(),
      vetoedAt: null,
      assignmentId: assignment.id,
      assignmentRunId: runId,
      test: true,
    });
    expect(approved.scheduledAt).toBe(slots[1]!.at);
    // The publisher job waits for the slot; the preview goes out right away.
    const jobs = await h.rows("jobs");
    expect(jobs.find((job) => job.topic === "publishing")!.availableAt).toBe(
      slots[1]!.at,
    );
    expect(await previews()).toEqual([
      expect.objectContaining({
        resourceId: pub!.id,
        idempotencyKey: `notify:preview:${pub!.id}`,
        status: "queued",
      }),
    ]);
    expect(
      await h.run((tx) =>
        tx.outbox.count({
          where: {
            projectId: project.owner.projectId,
            topic: "telegram_notification",
          },
        }),
      ),
    ).toBe(1);
    // The run's slot now counts as the publication; the rejected one is free again.
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots).toEqual([
      expect.objectContaining({
        channel: X,
        at: slots[0]!.at,
        releasedAt: expect.any(String),
      }),
      expect.objectContaining({
        channel: X,
        at: slots[1]!.at,
        publicationId: pub!.id,
      }),
    ]);
    expect(run!.scheduling).toMatchObject({
      publicationIds: [pub!.id],
      dropped: [],
    });
    expect(run!.scheduledAt).toEqual(expect.any(String));
    // The automatic approval is audited with version, review task and deadline.
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: project.owner.projectId,
          action: "publication.agent_scheduled",
        },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      contentId: approved.id,
      assignmentVersion: assignment.version,
      reviewTaskId: review.id,
      vetoDeadline: pub!.vetoDeadline,
      deterministicProblems: [],
    });

    // Scheduling again creates nothing new.
    const again = await h.run((tx) =>
      scheduleApproved(tx, project.owner, runId),
    );
    expect(again.map((row) => row.id)).toEqual([pub!.id]);
    expect(await h.rows("publications")).toHaveLength(1);
    expect(await previews()).toHaveLength(1);
  });

  it("schedules nothing the owner has to review", async () => {
    // Without a linked bot the agent review does not count: the drafts wait for the owner.
    await h.makeAssignment();
    const { review, runId } = await drafted();
    await reviewed(review.id);
    expect((await contents()).map((c) => c.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
    expect(await h.rows("publications")).toEqual([]);
    expect(
      await h.run((tx) => scheduleApproved(tx, project.owner, runId)),
    ).toEqual([]);
    expect(await previews()).toEqual([]);
  });

  it("moves a late deliverable so the veto window stays complete", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const { review, slots } = await drafted();
    // The review ends 150 minutes before the first slot: 30 minutes into its 180-minute window.
    const now = at(slots[0]!.at, -150);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await reviewed(review.id);

    const pubs = await publications();
    expect(pubs).toHaveLength(2);
    // The first post moves to the next half hour that leaves the full window.
    const moved = at(slots[0]!.at, 30).toISOString();
    expect(pubs[0]).toMatchObject({
      scheduledAt: moved,
      vetoDeadline: now.toISOString(),
    });
    // The second was on time and keeps its slot.
    expect(pubs[1]).toMatchObject({
      scheduledAt: slots[1]!.at,
      vetoDeadline: at(slots[1]!.at, -180).toISOString(),
    });
    for (const pub of pubs)
      expect(Date.parse(pub.scheduledAt) - Date.parse(pub.vetoDeadline)).toBe(
        180 * MINUTE,
      );
    const drafts = await contents();
    expect(drafts[0]!.scheduledAt).toBe(moved);
    // The mission's slot follows, so its window still covers the post.
    const mission = await h.run((tx) =>
      entity(tx, project.owner, "missions", drafts[0]!.missionId),
    );
    expect(data(mission).plannedSlotAt).toBe(moved);
    expect(Date.parse(data(mission).endAt)).toBeGreaterThan(Date.parse(moved));
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({
      at: moved,
      requestedAt: slots[0]!.at,
      publicationId: pubs[0]!.id,
    });
  });

  it("drops a late deliverable when no slot is free that day", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const { review, slots, runId } = await drafted();
    // Another post fills the day's quota (2) together with the run's second slot.
    await h.run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: "synthetic-other-post",
        channel: X,
        status: "intent_created",
        scheduledAt: at(slots[0]!.at, 120).toISOString(),
        test: true,
      }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(slots[0]!.at, -150));
    await reviewed(review.id);

    const drafts = await contents();
    const pubs = (await publications()).filter(
      (pub) => pub.assignmentRunId === runId,
    );
    // Only the second post is scheduled; the first is dropped with a reason.
    expect(pubs.map((pub) => pub.contentId)).toEqual([drafts[1]!.id]);
    expect(pubs[0]!.scheduledAt).toBe(slots[1]!.at);
    const [run] = await h.rows("assignment_runs");
    expect(run!.scheduling.dropped).toEqual([
      expect.objectContaining({
        contentId: drafts[0]!.id,
        code: "SLOT_UNAVAILABLE",
      }),
    ]);
    expect(run!.slots[0]).toMatchObject({ releasedAt: expect.any(String) });
    // Never two posts in one slot.
    const all = (await publications()).map(
      (pub) => `${pub.channel}@${pub.scheduledAt}`,
    );
    expect(new Set(all).size).toBe(all.length);
    // A second pass keeps the drop and creates nothing.
    await h.run((tx) => scheduleApproved(tx, project.owner, runId));
    expect(
      (await publications()).filter((pub) => pub.assignmentRunId === runId),
    ).toHaveLength(1);
  });

  it("withdraws a vetoed post before handoff", async () => {
    const { pubs } = await scheduled();
    const [pub, other] = pubs;
    expect(
      await code(
        h.run((tx) =>
          vetoPublication(tx, project.viewer, pub!.id, pub!.version, "orbit"),
        ),
      ),
    ).toBe("EDITOR_REQUIRED");
    expect(
      await code(
        h.run((tx) =>
          vetoPublication(
            tx,
            project.owner,
            other!.id,
            other!.version + 1,
            "orbit",
          ),
        ),
      ),
    ).toBe("VERSION_CONFLICT");

    const result = await h.run((tx) =>
      vetoPublication(
        tx,
        project.owner,
        pub!.id,
        pub!.version,
        "telegram",
        "Too much like yesterday's post.",
      ),
    );
    expect(result).toEqual({ result: "vetoed" });
    const [vetoed, untouched] = await publications();
    expect(vetoed).toMatchObject({
      status: "canceled",
      reason: "VETOED",
      vetoSource: "telegram",
      vetoedBy: project.owner.userId,
      vetoedAt: expect.any(String),
    });
    expect(untouched).toMatchObject({ status: "intent_created" });
    const job = (await h.rows("jobs")).find(
      (row) => row.topic === "publishing" && row.resourceId === pub!.id,
    );
    expect(job).toMatchObject({
      status: "canceled",
      error: "PUBLICATION_VETOED",
    });
    // The reason is kept as a proposed preference for the owner.
    const preferences = await h.rows("preferences");
    expect(preferences).toEqual([
      expect.objectContaining({
        rule: "Too much like yesterday's post.",
        status: "proposed",
        source: "veto",
        publicationId: pub!.id,
      }),
    ]);

    // A repeated stop with the same version changes nothing.
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.owner,
          pub!.id,
          pub!.version,
          "telegram",
          "Too much like yesterday's post.",
        ),
      ),
    ).toEqual({ result: "vetoed" });
    expect((await publications())[0]!.version).toBe(vetoed!.version);
    expect(await h.rows("preferences")).toHaveLength(1);
    const withdrawn = await h.run((tx) =>
      tx.auditEvent.count({
        where: { resourceId: pub!.id, action: "publication.withdrawn" },
      }),
    );
    expect(withdrawn).toBe(1);
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.owner,
          "00000000-0000-4000-8000-000000000000",
          1,
          "orbit",
        ),
      ),
    ).toEqual({ result: "not_found" });
    // The vetoed post is never handed over, even after its slot.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(pub!.scheduledAt, 1));
    expect(
      (await h.run((tx) => claimPublication(tx, project.owner, pub!.id))).send,
    ).toBe(false);
  });

  it("reports a post already handed over and changes nothing", async () => {
    const { pubs } = await scheduled();
    const [pub] = pubs;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(pub!.scheduledAt, 1));
    const claim = await h.run((tx) =>
      claimPublication(tx, project.owner, pub!.id),
    );
    expect(claim.send).toBe(true);
    const sending = (await publications())[0]!;
    expect(
      await h.run((tx) =>
        vetoPublication(tx, project.owner, pub!.id, sending.version, "orbit"),
      ),
    ).toEqual({ result: "already_handed_over" });
    expect((await publications())[0]).toEqual(sending);
    await h.run((tx) =>
      finishPublication(tx, project.owner, pub!.id, data(claim.pub).fence, {
        status: "published_test",
        remoteId: "test-" + pub!.id,
      }),
    );
    const published = (await publications())[0]!;
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.owner,
          pub!.id,
          published.version,
          "telegram",
          "Stop it.",
        ),
      ),
    ).toEqual({ result: "already_handed_over" });
    expect((await publications())[0]).toEqual(published);
    expect(await h.rows("preferences")).toEqual([]);

    // Postiz holds the post (R56): every status but the withdrawable ones answers honestly.
    const other = pubs[1]!;
    const forge = (changes: Record<string, unknown>) =>
      h.run(async (tx) => {
        const row = await entity(tx, project.owner, "publications", other.id);
        const { remoteId, handoffCompletedAt, handoffAt, ...rest } = data(row);
        void remoteId;
        void handoffCompletedAt;
        void handoffAt;
        return update(tx, project.owner, row, { ...rest, ...changes });
      });
    for (const status of [
      "scheduled_remote",
      "reconciliation_required",
      "cancellation_required",
      "sending",
      "outcome_unknown",
    ]) {
      const forged = await forge({
        status,
        remoteId: "remote-synthetic",
        handoffCompletedAt: new Date().toISOString(),
      });
      expect(
        await h.run((tx) =>
          vetoPublication(tx, project.owner, other.id, forged.version, "orbit"),
        ),
      ).toEqual({ result: "already_handed_over" });
      expect((await publications())[1]!.version).toBe(forged.version);
      expect((await publications())[1]!.status).toBe(status);
    }
    // Blocked after a handoff to Postiz: still with Postiz.
    const blockedRemote = await forge({
      status: "blocked_dependency",
      remoteId: "remote-synthetic",
    });
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.owner,
          other.id,
          blockedRemote.version,
          "orbit",
        ),
      ),
    ).toEqual({ result: "already_handed_over" });
    // Blocked while in flight (e.g. its content changed during the send): it was claimed for Postiz.
    const blockedInFlight = await forge({
      status: "blocked_dependency",
      handoffAt: new Date().toISOString(),
    });
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.owner,
          other.id,
          blockedInFlight.version,
          "orbit",
        ),
      ),
    ).toEqual({ result: "already_handed_over" });
    expect((await publications())[1]!.version).toBe(blockedInFlight.version);
    // Blocked before anything was sent: Orbit still holds it and stops it.
    const blocked = await forge({ status: "blocked_dependency" });
    expect(
      await h.run((tx) =>
        vetoPublication(tx, project.owner, other.id, blocked.version, "orbit"),
      ),
    ).toEqual({ result: "vetoed" });
    expect((await publications())[1]).toMatchObject({
      status: "canceled",
      reason: "VETOED",
    });
  });

  it("does not hand over before the veto deadline", async () => {
    const { pubs } = await scheduled();
    const [pub, second] = pubs;
    // Before the slot nothing is due.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(pub!.vetoDeadline, -1));
    expect(
      await code(h.run((tx) => claimPublication(tx, project.owner, pub!.id))),
    ).toBe("NOT_DUE");
    // A due post whose deadline lies ahead is refused at handoff.
    vi.setSystemTime(at(pub!.scheduledAt, 1));
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "publications", pub!.id);
      await update(tx, project.owner, row, {
        ...data(row),
        vetoDeadline: at(pub!.scheduledAt, 10).toISOString(),
      });
    });
    const early = await h.run((tx) =>
      claimPublication(tx, project.owner, pub!.id),
    );
    expect(early.send).toBe(false);
    expect(data(early.pub)).toMatchObject({
      status: "blocked_dependency",
      blockers: ["VETO_WINDOW_OPEN"],
    });
    // A stop recorded on the publication blocks it as well.
    vi.setSystemTime(at(second!.scheduledAt, 1));
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "publications", second!.id);
      await update(tx, project.owner, row, {
        ...data(row),
        vetoedAt: new Date().toISOString(),
      });
    });
    const stopped = await h.run((tx) =>
      claimPublication(tx, project.owner, second!.id),
    );
    expect(stopped.send).toBe(false);
    expect(data(stopped.pub).blockers).toEqual(["VETOED"]);
    // Agent-reviewed content without a veto window is never handed over.
    const forged = await h.run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: second!.contentId,
        contentVersion: second!.contentVersion,
        channel: X,
        status: "intent_created",
        packageHash: second!.packageHash,
        scheduledAt: second!.scheduledAt,
        test: true,
      }),
    );
    const refused = await h.run((tx) =>
      claimPublication(tx, project.owner, forged.id),
    );
    expect(refused.send).toBe(false);
    expect(data(refused.pub).blockers).toEqual(["VETO_DEADLINE_REQUIRED"]);
  });

  it("publishes after the deadline without a veto (test execution)", async () => {
    // Assisted mode: the confirmed assignment and the passed window stand in for a package approval (R52).
    await h.setPolicy({ mode: "assisted" });
    const { pubs } = await scheduled();
    expect(pubs).toHaveLength(2);
    const [pub] = pubs;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(pub!.scheduledAt, 1));
    await dispatchPublication(project.owner, pub!.id);
    expect((await publications())[0]).toMatchObject({
      status: "published_test",
      remoteId: "test-" + pub!.id,
    });
  });

  it("keeps approval and mission permission for every other publication (R52)", async () => {
    await h.setPolicy({ mode: "assisted" });
    // No bot: the agent review does not count; the owner reviews the drafts himself.
    await h.makeAssignment();
    const { review } = await drafted();
    await reviewed(review.id);
    const [draft] = await contents();
    const owned = await h.run((tx) =>
      reviewContent(tx, project.owner, draft!.id, draft!.version, true),
    );
    expect(data(owned).status).toBe("reviewed");
    const blockers = (
      (await code(
        h.run((tx) =>
          publishIntent(tx, project.owner, {
            contentId: owned.id,
            version: owned.version,
          }),
        ),
      )) ?? ""
    ).split(",");
    expect(blockers).toEqual(
      expect.arrayContaining([
        "APPROVAL_REQUIRED",
        "MISSION_TEST_WRITE_NOT_AUTHORIZED",
      ]),
    );
    // A veto deadline does not release content the agent review does not cover.
    const deadline = new Date(Date.now() - MINUTE).toISOString();
    const checked = await h.run((tx) =>
      preflight(tx, project.owner, owned.id, {
        test: true,
        veto: {
          deadline,
          vetoedAt: null,
          assignmentRunId: data(owned).assignmentRunId,
          handoff: true,
        },
      }),
    );
    expect(checked.blockers).toEqual(
      expect.arrayContaining([
        "APPROVAL_REQUIRED",
        "MISSION_TEST_WRITE_NOT_AUTHORIZED",
      ]),
    );
    expect(
      await code(
        h.run((tx) =>
          publishIntent(tx, project.owner, {
            contentId: owned.id,
            version: owned.version,
            vetoDeadline: deadline,
          }),
        ),
      ),
    ).toMatch(/APPROVAL_REQUIRED|INVALID_VETO_DEADLINE/);
  });

  it("keeps the codes for agent content before the deadline or after a stop (R52)", async () => {
    await h.setPolicy({ mode: "assisted" });
    const { pubs } = await scheduled();
    const [pub] = pubs;
    const check = (veto: Record<string, unknown>) =>
      h.run((tx) =>
        preflight(tx, project.owner, pub!.contentId, {
          test: true,
          veto: {
            deadline: pub!.vetoDeadline,
            vetoedAt: null,
            assignmentRunId: pub!.assignmentRunId,
            handoff: true,
            ...veto,
          } as any,
        }),
      );
    const held = ["APPROVAL_REQUIRED", "MISSION_TEST_WRITE_NOT_AUTHORIZED"];
    // Window still open.
    expect((await check({})).blockers).toEqual(expect.arrayContaining(held));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(pub!.vetoDeadline, 1));
    const passed = await check({});
    expect(passed.blockers).not.toContain("APPROVAL_REQUIRED");
    expect(passed.blockers).not.toContain("MISSION_TEST_WRITE_NOT_AUTHORIZED");
    // Stopped, or bound to another run.
    expect(
      (await check({ vetoedAt: new Date().toISOString() })).blockers,
    ).toEqual(expect.arrayContaining(held));
    expect((await check({ assignmentRunId: "another-run" })).blockers).toEqual(
      expect.arrayContaining(held),
    );
    // Without the veto option (any other publication) nothing is relaxed.
    expect(
      (
        await h.run((tx) =>
          preflight(tx, project.owner, pub!.contentId, { test: true }),
        )
      ).blockers,
    ).toEqual(expect.arrayContaining(held));
  });

  it("hands a live post to Postiz only after its deadline and without a stop (R53)", async () => {
    const saved = {
      EXECUTION_MODE: process.env.EXECUTION_MODE,
      ENABLE_EXTERNAL_WRITES: process.env.ENABLE_EXTERNAL_WRITES,
      PUBLISHER_INSTANCE_ID: process.env.PUBLISHER_INSTANCE_ID,
    };
    try {
      process.env.EXECUTION_MODE = "live";
      process.env.ENABLE_EXTERNAL_WRITES = "true";
      process.env.PUBLISHER_INSTANCE_ID = "synthetic-publisher";
      provider.liveIndex = true;
      provider.createPost.mockResolvedValue({
        remotePosts: [{ postId: "remote-synthetic-1" }],
      });
      await h.setPolicy({ maxPerDay: 3 });
      await h.run(async (tx) => {
        const row = (await list(tx, project.owner, "connectors"))[0]!;
        await update(tx, project.owner, row, {
          ...data(row),
          status: "write_verified",
          baseUrl: "https://postiz.example.invalid",
          // A synthetic token, sealed with the test environment's key like the fixture's OpenAI key.
          encryptedCredential: encrypt(
            "synthetic-token",
            process.env.CREDENTIAL_KEY!,
          ),
          writeVerifiedIntegrationIds: [X],
          writeVerifiedInstanceId: "synthetic-publisher",
        });
      });
      await h.connectTelegram();
      await h.makeAssignment({
        schedule: {
          rhythm: "daily",
          weekdays: [],
          times: ["10:00", "13:00", "17:00"],
          leadMinutes: 360,
        },
      });
      const { review } = await drafted();
      await reviewed(review.id);
      const pubs = await publications();
      expect(pubs).toHaveLength(3);
      expect(pubs.every((pub) => pub.test === false)).toBe(true);
      const [sent, early, stopped] = pubs;
      const dispatch = (id: string) => dispatchPublication(project.owner, id);
      vi.useFakeTimers({ toFake: ["Date"] });

      // Inside the window and before the slot nothing goes out.
      vi.setSystemTime(at(sent!.vetoDeadline, -1));
      expect(await code(dispatch(sent!.id))).toBe("NOT_DUE");
      expect(provider.createPost).not.toHaveBeenCalled();

      // A due post whose deadline lies ahead is blocked at handoff.
      vi.setSystemTime(at(early!.scheduledAt, 1));
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "publications", early!.id);
        await update(tx, project.owner, row, {
          ...data(row),
          vetoDeadline: at(early!.scheduledAt, 10).toISOString(),
        });
      });
      await dispatch(early!.id);
      expect((await publications())[1]).toMatchObject({
        status: "blocked_dependency",
        blockers: ["VETO_WINDOW_OPEN"],
      });
      expect(provider.createPost).not.toHaveBeenCalled();

      // A stopped post stays home after its slot.
      vi.setSystemTime(at(stopped!.vetoDeadline, -30));
      expect(
        await h.run((tx) =>
          vetoPublication(
            tx,
            project.owner,
            stopped!.id,
            stopped!.version,
            "telegram",
          ),
        ),
      ).toEqual({ result: "vetoed" });
      vi.setSystemTime(at(stopped!.scheduledAt, 1));
      await dispatch(stopped!.id);
      expect((await publications())[2]).toMatchObject({ status: "canceled" });
      expect(provider.createPost).not.toHaveBeenCalled();

      // After the deadline without a stop the post goes to Postiz.
      vi.setSystemTime(at(sent!.scheduledAt, 1));
      await dispatch(sent!.id);
      expect(provider.createPost).toHaveBeenCalledTimes(1);
      expect(provider.createPost.mock.calls[0]![0].posts[0]).toMatchObject({
        integration: { id: X },
      });
      const handed = (await publications())[0]!;
      expect(handed).toMatchObject({
        status: "scheduled_remote",
        remoteId: "remote-synthetic-1",
      });
      // From now on a stop changes nothing (C1).
      expect(
        await h.run((tx) =>
          vetoPublication(tx, project.owner, sent!.id, handed.version, "orbit"),
        ),
      ).toEqual({ result: "already_handed_over" });
      expect((await publications())[0]).toEqual(handed);
      // The assignment's mission stays draft-only.
      const mission = await h.run(async (tx) =>
        entity(
          tx,
          project.owner,
          "missions",
          data(await entity(tx, project.owner, "content", sent!.contentId))
            .missionId,
        ),
      );
      expect(data(mission).allowedActions).toEqual(["draft"]);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });

  it("schedules on the next sweep when scheduling failed after the review (R54)", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const { review, runId } = await drafted();
    provider.slotFailure = { after: 0, kind: "js" };
    // The review's result is saved even though its scheduling fails.
    await reviewed(review.id);
    expect(await h.rows("publications")).toEqual([]);
    const runOf = async () =>
      (await h.rows("assignment_runs")).find((row) => row.id === runId)!;
    expect(["done", "partial"]).toContain((await runOf()).status);
    expect((await runOf()).scheduledAt).toBeUndefined();

    await h.run((tx) => sweepProject(tx, h.worker(), tomorrowMorning()));
    expect(await h.rows("publications")).toHaveLength(2);
    expect(await previews()).toHaveLength(2);
    const marked = await runOf();
    expect(marked.scheduledAt).toEqual(expect.any(String));
    // A further sweep leaves the scheduled run alone.
    await h.run((tx) => sweepProject(tx, h.worker(), tomorrowMorning()));
    expect((await runOf()).version).toBe(marked.version);
    expect(await h.rows("publications")).toHaveLength(2);
  });

  it("isolates each run's scheduling in the sweep (R58)", async () => {
    await h.connectTelegram();
    await h.makeAssignment();
    const { review, runId } = await drafted();
    provider.slotFailure = { after: 0, kind: "js" };
    await reviewed(review.id);
    expect(await h.rows("publications")).toEqual([]);
    const runOf = async () =>
      (await h.rows("assignment_runs")).find((row) => row.id === runId)!;
    const telegramEvents = () =>
      h.run((tx) =>
        tx.outbox.count({
          where: {
            projectId: project.owner.projectId,
            topic: "telegram_notification",
          },
        }),
      );
    // Another duty of the same sweep: a ready mission past its end expires.
    const stale = () =>
      h.run((tx) =>
        create(tx, project.owner, "missions", {
          title: "Synthetic stale mission",
          status: "ready",
          startAt: new Date(Date.now() - 2 * 3600000).toISOString(),
          endAt: new Date(Date.now() - 3600000).toISOString(),
        }),
      );
    const statusOf = async (id: string) =>
      data(await h.run((tx) => entity(tx, project.owner, "missions", id)))
        .status;

    for (const kind of ["sql", "js"] as const) {
      const mission = await stale();
      // Scheduling breaks on the run's second draft, after the first was booked.
      provider.slotFailure = { after: 1, kind };
      await h.run((tx) => sweepProject(tx, h.worker(), tomorrowMorning()));
      expect(provider.slotFailure).toBeNull();
      // Nothing of the first draft is left behind.
      expect(await h.rows("publications")).toEqual([]);
      expect(await previews()).toEqual([]);
      expect(await telegramEvents()).toBe(0);
      expect(
        (await h.rows("jobs")).filter((job) => job.topic === "publishing"),
      ).toEqual([]);
      const run = await runOf();
      expect(run.scheduledAt).toBeUndefined();
      expect(run.slots.every((slot: any) => !slot.publicationId)).toBe(true);
      // The rest of the sweep went on.
      expect(await statusOf(mission.id)).toBe("expired");
    }

    // A later sweep schedules both drafts.
    await h.run((tx) => sweepProject(tx, h.worker(), tomorrowMorning()));
    const pubs = await publications();
    expect(pubs).toHaveLength(2);
    expect(await previews()).toHaveLength(2);
    expect(await telegramEvents()).toBe(2);
    const run = await runOf();
    expect(run.scheduledAt).toEqual(expect.any(String));
    expect(run.slots.map((slot: any) => slot.publicationId)).toEqual(
      pubs.map((pub) => pub.id),
    );
  });

  it("withdraws scheduled posts when the assignment is paused (R20)", async () => {
    const { assignment, pubs } = await scheduled();
    const [first, second] = pubs;
    // The first post is already with the publisher.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(first!.scheduledAt, 1));
    expect(
      (await h.run((tx) => claimPublication(tx, project.owner, first!.id)))
        .send,
    ).toBe(true);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.editor, assignment.id, "paused"),
    );
    const after = await publications();
    expect(after[0]).toMatchObject({ status: "sending" });
    expect(after[1]).toMatchObject({
      id: second!.id,
      status: "canceled",
      reason: "ASSIGNMENT_PAUSED",
    });
    expect(
      (await h.rows("jobs")).find(
        (job) => job.topic === "publishing" && job.resourceId === second!.id,
      ),
    ).toMatchObject({ status: "canceled" });
    // Resuming brings nothing back.
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "active"),
    );
    expect((await publications())[1]).toMatchObject({ status: "canceled" });
  });

  it("withdraws scheduled posts when the assignment ends (R20)", async () => {
    const { assignment } = await scheduled();
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "ended"),
    );
    expect(await publications()).toEqual([
      expect.objectContaining({
        status: "canceled",
        reason: "ASSIGNMENT_ENDED",
      }),
      expect.objectContaining({
        status: "canceled",
        reason: "ASSIGNMENT_ENDED",
      }),
    ]);
  });
});

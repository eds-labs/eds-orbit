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
import {
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
} from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { releaseAssignmentDraft } from "../src/modules/agents/owner-release.ts";
import {
  draftsAwaitingOwner,
  upcomingAssignmentPosts,
} from "../src/modules/agents/assignment-overview.ts";
import {
  vetoPublication,
  withdrawAssignmentPublications,
} from "../src/modules/agents/veto.ts";
import { setAssignmentStatus } from "../src/modules/agents/assignments.ts";
import { preflight } from "../src/modules/policy.ts";
import { dispatchPublication } from "../src/modules/publisher.ts";
import { publishIntent, reviewContent } from "../src/modules/workflow.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
const MINUTE = 60000;

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
 * The owner's release of assignment drafts left for them (R70, I1): the
 * review left them `needs_review`, no bot is linked, or agent review
 * authority is off. The owner's review stands in for the agent's, the
 * mission may publish exactly that post and the publisher path does the rest.
 */
describe.skipIf(!enabled)("Owner release of assignment drafts", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  /** Drafts of the run, in slot order (brief key = channel@slot). */
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      String(a.briefKey).localeCompare(String(b.briefKey)),
    );
  const publications = () => h.rows("publications");
  const at = (iso: string, minutes = 0) =>
    new Date(Date.parse(iso) + minutes * MINUTE);
  /** A confirmed assignment whose run's drafts the review approved but left for the owner. */
  const leftForOwner = async () => {
    const assignment = await h.makeAssignment();
    const planned = await h.planWithBriefs((slots) =>
      slots.map((slot) => h.brief(slot)),
    );
    for (const copy of (await h.rows("agent_tasks")).filter(
      (t) => t.role === "copywriter",
    ))
      await runAgentTask(h.worker(), copy.id);
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), (await h.task("review")).id);
    expect((await h.task("review")).status).toBe("done");
    const drafts = await contents();
    expect(drafts.map((c) => c.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
    expect(await publications()).toEqual([]);
    return { assignment, drafts, ...planned };
  };
  const release = (
    scope: typeof project.owner,
    draft: Record<string, any>,
    version = draft.version as number,
  ) => h.run((tx) => releaseAssignmentDraft(tx, scope, draft.id, version));
  const mission = (id: string) =>
    h.run(async (tx) => data(await entity(tx, project.owner, "missions", id)));

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
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
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("releases a draft left for the owner without a bot and publishes it on the publisher path", async () => {
    // Assisted mode: the release also records the owner's package approval.
    await h.setPolicy({ mode: "assisted" });
    const { assignment, drafts, runId, slots } = await leftForOwner();
    const [first] = drafts;
    const listed = await h.run((tx) => draftsAwaitingOwner(tx, project.owner));
    expect(listed.map((item) => item.id).sort()).toEqual(
      drafts.map((d) => d.id).sort(),
    );
    expect(listed.find((item) => item.id === first!.id)).toMatchObject({
      version: first!.version,
      channel: X,
      channelName: "Synthetic X",
      slotAt: slots[0]!.at,
      assignmentId: assignment.id,
      assignmentName: "Two posts a day",
      agentApproved: true,
      problems: [],
    });

    const released = await release(project.owner, first!);
    expect(released).toMatchObject({
      result: "released",
      scheduledAt: slots[0]!.at,
      requestedAt: slots[0]!.at,
    });
    const [pub] = await publications();
    expect(pub).toMatchObject({
      id: released.publicationId,
      contentId: first!.id,
      channel: X,
      status: "intent_created",
      scheduledAt: slots[0]!.at,
      test: true,
      assignmentId: assignment.id,
      assignmentRunId: runId,
      ownerReleasedBy: project.owner.userId,
      ownerReleasedAt: expect.any(String),
    });
    // The owner approved it: no veto window.
    expect(pub!.vetoDeadline).toBeUndefined();
    // The owner's review of exactly this text.
    const reviewed = (await contents())[0]!;
    expect(reviewed).toMatchObject({
      status: "reviewed",
      humanReviewedBodyHash: hash(reviewed.body),
      reviewedBy: project.owner.userId,
    });
    // The draft-only mission may publish exactly this post.
    expect(await mission(first!.missionId)).toMatchObject({
      allowedActions: ["draft", "publish_test"],
      publishAuthorizedBy: {
        contentId: first!.id,
        releasedBy: project.owner.userId,
      },
    });
    // The run counts the slot as this publication.
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({
      channel: X,
      at: slots[0]!.at,
      publicationId: pub!.id,
    });
    expect(run!.scheduling.publicationIds).toEqual([pub!.id]);
    // The released draft leaves the list; the other still waits.
    expect(
      (await h.run((tx) => draftsAwaitingOwner(tx, project.owner))).map(
        (item) => item.id,
      ),
    ).toEqual([drafts[1]!.id]);
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: project.owner.projectId,
          action: {
            in: ["assignment.draft_released", "mission.publish_authorized"],
          },
        },
      }),
    );
    expect(audits.map((event) => [event.action, event.actorId]).sort()).toEqual(
      [
        ["assignment.draft_released", project.owner.userId],
        ["mission.publish_authorized", project.owner.userId],
      ],
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(slots[0]!.at, 1));
    await dispatchPublication(project.owner, pub!.id);
    expect((await publications())[0]).toMatchObject({
      status: "published_test",
      remoteId: "test-" + pub!.id,
    });
  });

  it("releases a draft the agent approved while agent review authority is off", async () => {
    await h.connectTelegram();
    const { drafts, slots } = await leftForOwner();
    const released = await release(project.owner, drafts[1]!);
    expect(released).toMatchObject({
      result: "released",
      scheduledAt: slots[1]!.at,
    });
    const [pub] = await publications();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(slots[1]!.at, 1));
    await dispatchPublication(project.owner, pub!.id);
    expect((await publications())[0]!.status).toBe("published_test");
  });

  it("refuses editors and viewers", async () => {
    const { drafts } = await leftForOwner();
    for (const scope of [project.editor, project.viewer])
      expect(await code(release(scope, drafts[0]!))).toBe("OWNER_REQUIRED");
    expect(await publications()).toEqual([]);
    expect((await contents())[0]).toMatchObject({
      status: "needs_review",
      version: drafts[0]!.version,
    });
  });

  it("keeps a draft with a deterministic blocker blocked and changes nothing", async () => {
    const { drafts } = await leftForOwner();
    const [first] = drafts;
    expect(first!.targetUrl).toBeTruthy();
    // The link is no longer allowed by the policy: a blocker the owner cannot clear.
    await h.setPolicy({ allowedOrigins: [] });
    expect(await code(release(project.owner, first!))).toMatch(
      /LINK_NOT_ALLOWED/,
    );
    expect(await publications()).toEqual([]);
    expect((await contents())[0]).toMatchObject({
      status: "needs_review",
      version: first!.version,
    });
    expect((await contents())[0]!.humanReviewedBodyHash).toBeUndefined();
    expect((await mission(first!.missionId)).allowedActions).toEqual(["draft"]);
  });

  it("grants the publish right for the released post only", async () => {
    const { drafts } = await leftForOwner();
    const [first, second] = drafts;
    await release(project.owner, first!);
    // Another draft of the same run, even reviewed by the owner, still may not publish.
    const owned = await h.run((tx) =>
      reviewContent(tx, project.owner, second!.id, second!.version, true),
    );
    expect(data(owned).status).toBe("reviewed");
    expect(
      (
        (await code(
          h.run((tx) =>
            publishIntent(tx, project.owner, {
              contentId: owned.id,
              version: owned.version,
            }),
          ),
        )) ?? ""
      ).split(","),
    ).toContain("MISSION_TEST_WRITE_NOT_AUTHORIZED");
    expect((await mission(second!.missionId)).allowedActions).toEqual([
      "draft",
    ]);
    // Another text on the released draft's own mission does not get it either.
    const forged = await h.run(async (tx) => {
      const source = await entity(tx, project.owner, "content", first!.id);
      const body = `${BODY} Another text on the same mission.`;
      return create(tx, project.owner, "content", {
        ...data(source),
        body,
        humanReviewedBodyHash: hash(body),
        status: "reviewed",
      });
    });
    const check = (id: string) =>
      h.run((tx) =>
        preflight(tx, project.owner, id, {
          test: true,
          at: new Date(Date.parse(data(forged).scheduledAt)),
        }),
      );
    expect((await check(forged.id)).blockers).toContain(
      "MISSION_TEST_WRITE_NOT_AUTHORIZED",
    );
    expect((await check(first!.id)).blockers).not.toContain(
      "MISSION_TEST_WRITE_NOT_AUTHORIZED",
    );
  });

  it("releases once: a second release answers with the same publication", async () => {
    const { drafts } = await leftForOwner();
    const first = await release(project.owner, drafts[0]!);
    // The second click still carries the version the owner saw.
    const again = await release(project.owner, drafts[0]!);
    expect(again).toMatchObject({
      result: "already_released",
      publicationId: first.publicationId,
      scheduledAt: first.scheduledAt,
    });
    expect(await publications()).toHaveLength(1);
    expect(
      (await h.rows("jobs")).filter((job) => job.topic === "publishing"),
    ).toHaveLength(1);
  });

  it("moves to the next free slot of the day when the run slot is taken or passed", async () => {
    await h.setPolicy({ maxPerDay: 3 });
    const { drafts, slots } = await leftForOwner();
    // Another post sits on the first slot.
    await h.run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: "synthetic-other-post",
        channel: X,
        status: "intent_created",
        scheduledAt: slots[0]!.at,
        test: true,
      }),
    );
    const moved = await release(project.owner, drafts[0]!);
    // Spacing is 120 minutes: two hours after the other post.
    expect(moved).toMatchObject({
      result: "released",
      scheduledAt: at(slots[0]!.at, 120).toISOString(),
      requestedAt: slots[0]!.at,
    });
    expect((await contents())[0]!.scheduledAt).toBe(moved.scheduledAt);
    expect((await mission(drafts[0]!.missionId)).plannedSlotAt).toBe(
      moved.scheduledAt,
    );
    const [run] = await h.rows("assignment_runs");
    expect(run!.slots[0]).toMatchObject({
      at: moved.scheduledAt,
      requestedAt: slots[0]!.at,
      publicationId: moved.publicationId,
    });
    // A slot that has passed moves to the next half hour still ahead.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(slots[1]!.at, 10));
    const late = await release(project.owner, drafts[1]!);
    expect(late).toMatchObject({
      result: "released",
      scheduledAt: at(slots[1]!.at, 30).toISOString(),
      requestedAt: slots[1]!.at,
    });
  });

  it("refuses with SLOT_UNAVAILABLE when the day has no free slot", async () => {
    const { drafts } = await leftForOwner();
    // Now one post a day, and the run's other slot still holds it.
    await h.setPolicy({ maxPerDay: 1 });
    expect(await code(release(project.owner, drafts[0]!))).toBe(
      "SLOT_UNAVAILABLE",
    );
    expect(await publications()).toEqual([]);
    expect((await contents())[0]!.status).toBe("needs_review");
  });

  it("checks the assignment through its confirmation: a completed one-off works, one ended by a person does not", async () => {
    const { assignment, drafts } = await leftForOwner();
    // A one-off that ended because its run was over (M2) keeps its confirmation.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", assignment.id);
      await update(tx, project.owner, row, {
        ...data(row),
        status: "ended",
        completedAt: new Date().toISOString(),
      });
    });
    expect((await release(project.owner, drafts[0]!)).result).toBe("released");
    // Ended by a person: nothing more is released.
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "ended"),
    );
    const second = (await contents())[1]!;
    expect(await code(release(project.owner, second))).toBe(
      "ASSIGNMENT_NOT_CONFIRMED",
    );
  });

  it("lists a released post under the upcoming posts and lets Orbit's Stop take it back", async () => {
    const { drafts, slots } = await leftForOwner();
    const { publicationId } = await release(project.owner, drafts[0]!);
    const [item] = await h.run((tx) =>
      upcomingAssignmentPosts(tx, project.owner),
    );
    expect(item).toMatchObject({
      id: publicationId,
      scheduledAt: slots[0]!.at,
      vetoDeadline: null,
      ownerReleased: true,
    });
    expect(
      await h.run((tx) =>
        vetoPublication(
          tx,
          project.editor,
          publicationId,
          item!.version,
          "orbit",
        ),
      ),
    ).toEqual({ result: "vetoed" });
    expect((await publications())[0]).toMatchObject({
      status: "canceled",
      reason: "VETOED",
    });
    expect(
      await h.run((tx) => upcomingAssignmentPosts(tx, project.owner)),
    ).toEqual([]);
  });

  it("withdraws a released post when the assignment is paused", async () => {
    const { assignment, drafts } = await leftForOwner();
    await release(project.owner, drafts[0]!);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    expect((await publications())[0]).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_PAUSED",
    });
  });

  /** What an editor's later publish of the released draft's text is refused with. */
  const republishBlockers = async (draftId: string) => {
    const content = await h.run(async (tx) =>
      entity(tx, project.owner, "content", draftId),
    );
    return (
      (await code(
        h.run((tx) =>
          publishIntent(tx, project.owner, {
            contentId: content.id,
            version: content.version,
          }),
        ),
      )) ?? ""
    ).split(",");
  };
  const expectRevoked = async (missionId: string) => {
    const revoked = await mission(missionId);
    expect(revoked.allowedActions).toEqual(["draft"]);
    expect(revoked.publishAuthorizedBy).toBeUndefined();
  };

  it("revokes the mission's publish right when Orbit's Stop withdraws the released post (N2)", async () => {
    const { drafts } = await leftForOwner();
    const [first, second] = drafts;
    await release(project.owner, first!);
    await release(project.owner, second!);
    const [item] = (await publications()).filter(
      (p) => p.contentId === first!.id,
    );
    expect(await mission(first!.missionId)).toMatchObject({
      allowedActions: ["draft", "publish_test"],
      publishAuthorizedBy: { contentId: first!.id },
    });
    await h.run((tx) =>
      vetoPublication(tx, project.editor, item!.id, item!.version, "orbit"),
    );
    expect((await publications()).find((p) => p.id === item!.id)).toMatchObject(
      { status: "canceled", reason: "VETOED" },
    );
    await expectRevoked(first!.missionId);
    // A later publish of the draft needs a new decision: the mission refuses it.
    expect(await republishBlockers(first!.id)).toContain(
      "MISSION_TEST_WRITE_NOT_AUTHORIZED",
    );
    // The other released post is not touched.
    expect(await mission(second!.missionId)).toMatchObject({
      allowedActions: ["draft", "publish_test"],
      publishAuthorizedBy: { contentId: second!.id },
    });
  });

  it("revokes the publish right of every withdrawn released post when the assignment is paused (N2)", async () => {
    const { assignment, drafts } = await leftForOwner();
    await release(project.owner, drafts[0]!);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    expect((await publications())[0]).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_PAUSED",
    });
    await expectRevoked(drafts[0]!.missionId);
    expect(await republishBlockers(drafts[0]!.id)).toContain(
      "MISSION_TEST_WRITE_NOT_AUTHORIZED",
    );
    // The draft that was never released has no right to lose.
    expect((await mission(drafts[1]!.missionId)).allowedActions).toEqual([
      "draft",
    ]);
  });

  it("revokes the publish right when the assignment ends (N2)", async () => {
    const { assignment, drafts } = await leftForOwner();
    await release(project.owner, drafts[0]!);
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "ended"),
    );
    expect((await publications())[0]).toMatchObject({
      status: "canceled",
      reason: "ASSIGNMENT_ENDED",
    });
    await expectRevoked(drafts[0]!.missionId);
  });

  it("keeps the right of a released post that a content change does not withdraw (N2)", async () => {
    const { drafts } = await leftForOwner();
    await release(project.owner, drafts[0]!);
    const before = await mission(drafts[0]!.missionId);
    // Changed or retimed assignments do not withdraw released posts (veto.ts).
    await h.run((tx) =>
      withdrawAssignmentPublications(
        tx,
        project.owner,
        drafts[0]!.assignmentId,
        "ASSIGNMENT_CHANGED",
      ),
    );
    expect((await publications())[0]!.status).toBe("intent_created");
    expect(await mission(drafts[0]!.missionId)).toEqual(before);
  });

  it("leaves a veto-window post's mission alone when it is withdrawn (N2)", async () => {
    const { assignment, drafts } = await leftForOwner();
    const [first] = drafts;
    // A window post is not owner-released: its mission carries no release marker.
    const windowPost = await h.run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: first!.id,
        channel: X,
        status: "intent_created",
        scheduledAt: first!.scheduledAt,
        test: true,
        assignmentId: assignment.id,
        assignmentRunId: first!.assignmentRunId,
        vetoDeadline: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    // Some other release marker on the mission must survive the window post's withdrawal.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "missions", first!.missionId);
      await update(tx, project.owner, row, {
        ...data(row),
        allowedActions: ["draft", "publish_test"],
        publishAuthorizedBy: { contentId: first!.id, releasedBy: "someone" },
      });
    });
    const before = await mission(first!.missionId);
    await h.run((tx) =>
      withdrawAssignmentPublications(
        tx,
        project.owner,
        assignment.id,
        "ASSIGNMENT_CHANGED",
      ),
    );
    expect(
      (await publications()).find((p) => p.id === windowPost.id)!.status,
    ).toBe("canceled");
    expect(await mission(first!.missionId)).toEqual(before);
  });

  it("answers 404 while Orbit Agents is off", async () => {
    const { drafts } = await leftForOwner();
    delete process.env.ORBIT_AGENTS;
    expect(await code(release(project.owner, drafts[0]!))).toBe("NOT_FOUND");
    expect(await h.run((tx) => draftsAwaitingOwner(tx, project.owner))).toEqual(
      [],
    );
    expect(
      await h.run((tx) => list(tx, project.owner, "publications")),
    ).toEqual([]);
  });
});

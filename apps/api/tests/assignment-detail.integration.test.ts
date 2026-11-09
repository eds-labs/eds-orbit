import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { buildWorkPlan } from "../src/modules/agents/assignment-runs.ts";
import { chatScoped, createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { proposeAssignment } from "../src/modules/agents/assignments.ts";
import { runBudgetKey } from "../src/modules/agents/specialists/runner.ts";
import {
  assignmentCardOf,
  assignmentTools,
} from "../src/modules/agents/tools/assignment-tools.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** The assignment detail read (G7): settings, runs, deliverable states and Social links. */
describe.skipIf(!enabled)("Assignment detail", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const origin = () => process.env.APP_ORIGIN!;
  const people = {} as Record<
    "owner" | "editor" | "viewer",
    { id: string; cookie: string }
  >;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const get = (who: keyof typeof people, id: string) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${project.owner.projectId}/assignments/${id}/detail`,
      headers: { origin: origin(), cookie: people[who].cookie },
    });
  const confirmed = async (changes: Record<string, unknown> = {}) => {
    const thread = await createConversation(project.editor);
    const { assignment, actionRequest } = await proposeAssignment(
      project.editor,
      thread.id,
      {
        name: "Daily product post",
        kind: "standing" as const,
        schedule: { rhythm: "daily" as const, weekdays: [], times: ["09:00"] },
        contentType: "social" as const,
        channels: [X],
        topicFrame: "Short updates about beta access for product teams",
        image: false,
        styleAssetIds: [],
        monthlyBudgetMicros: 30_000_000,
        ...changes,
      },
    );
    await run(async (tx) => {
      const row = await entity(
        tx,
        project.owner,
        "action_requests",
        actionRequest.id,
      );
      await decideActionRequest(tx, project.owner, row.id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
      });
    });
    return run((tx) => entity(tx, project.owner, "assignments", assignment.id));
  };
  const hours = (n: number) => new Date(Date.now() + n * 3600000).toISOString();
  /** A run with one social draft; extras shape the content and the handoff. */
  const deliverable = (
    assignmentId: string,
    runId: string,
    content: Record<string, unknown>,
    publication?: Record<string, unknown>,
    slotAt = hours(2),
  ) =>
    run(async (tx) => {
      const mission = await create(tx, project.owner, "missions", {
        plannedSlotAt: slotAt,
      });
      const row = await create(tx, project.owner, "content", {
        title: "Beta post",
        type: "social",
        channel: X,
        status: "needs_review",
        body: "Beta access is open for product teams.",
        assignmentId,
        assignmentRunId: runId,
        missionId: mission.id,
        scheduledAt: slotAt,
        ...content,
      });
      const pub = publication
        ? await create(tx, project.owner, "publications", {
            contentId: row.id,
            channel: X,
            assignmentId,
            assignmentRunId: runId,
            ...publication,
          })
        : null;
      return { content: row, publication: pub };
    });
  const makeRun = (assignmentId: string, extra: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "assignment_runs", {
        assignmentId,
        date: new Date().toISOString().slice(0, 10),
        status: "done",
        slots: [],
        unavailable: [],
        steps: [],
        costMicros: 0,
        ...extra,
      }),
    );

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    for (const role of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: `Synthetic detail ${role}`, password },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: origin() },
        payload: { email, password },
      });
      const cookies = r.headers["set-cookie"];
      people[role] = {
        id: signedUp.user.id,
        cookie: (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; "),
      };
    }
  });
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    project = await createPackageProject();
    for (const role of ["owner", "editor", "viewer"] as const) {
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          userId: people[role].id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: people[role].id,
          role,
        },
      });
    }
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(async () => {
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((p) => p.id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("shows settings, the next run and today's deliverables with state per platform", async () => {
    const confirmedRow = await confirmed();
    const assignment = await run((tx) =>
      update(tx, project.owner, confirmedRow, {
        ...data(confirmedRow),
        image: true,
      }),
    );
    const runRow = await makeRun(assignment.id);
    const published = await deliverable(
      assignment.id,
      runRow.id,
      { status: "reviewed", assetId: "11111111-1111-4111-8111-111111111111" },
      {
        status: "published",
        publishingBackend: "social",
        remoteId: "22222222-2222-4222-8222-222222222222",
        releaseUrl: "https://x.com/example/status/1",
      },
      hours(-1),
    );
    const awaiting = await deliverable(assignment.id, runRow.id, {});
    const res = await get("viewer", assignment.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assignment).toMatchObject({
      id: assignment.id,
      name: "Daily product post",
      status: "active",
      image: "plain",
      historyDays: 14,
      monthlyBudgetMicros: 30_000_000,
      monthSpentMicros: 0,
      schedule: { rhythm: "daily", times: ["09:00"], leadMinutes: 360 },
      channels: [
        { id: X, name: expect.any(String), platform: expect.any(String) },
      ],
    });
    expect(typeof body.nextRunAt === "string" || body.nextRunAt === null).toBe(
      true,
    );
    const [first] = body.runs;
    expect(first.id).toBe(runRow.id);
    const byContent = Object.fromEntries(
      first.deliverables.map((d: any) => [d.contentId, d]),
    );
    expect(byContent[published.content.id]).toMatchObject({
      state: "published",
      assetId: "11111111-1111-4111-8111-111111111111",
      publication: {
        id: published.publication!.id,
        status: "published",
        permalink: "https://x.com/example/status/1",
        socialPostId: "22222222-2222-4222-8222-222222222222",
        errorCode: null,
      },
    });
    expect(byContent[awaiting.content.id]).toMatchObject({
      state: "awaiting_release",
      publication: null,
      excerpt: "Beta access is open for product teams.",
    });
  });

  it("an unreleased passed draft is expired; a failed run lists its step error and is retryable before the slot", async () => {
    const assignment = await confirmed();
    const passed = await makeRun(assignment.id, { date: "2020-01-01" });
    const expired = await deliverable(
      assignment.id,
      passed.id,
      {},
      undefined,
      hours(-3),
    );
    const failedPub = await deliverable(
      assignment.id,
      passed.id,
      {},
      { status: "blocked_dependency", reason: "HANDOFF_DEPENDENCY_CHANGED" },
      hours(-3),
    );
    const slot = hours(3);
    const tz = (
      await run((tx) =>
        tx.project.findUniqueOrThrow({
          where: { id: project.owner.projectId },
        }),
      )
    ).timezone;
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(slot));
    const task = await run((tx) =>
      create(tx, project.owner, "agent_tasks", {
        runId: "pending",
        status: "failed",
        errorCode: "AGENT_OUTPUT_INVALID",
      }),
    );
    const failed = await makeRun(assignment.id, {
      date: local,
      status: "failed",
      slots: [{ channel: X, at: slot }],
      steps: [
        {
          key: "strategy",
          role: "strategy",
          status: "failed",
          taskId: task.id,
        },
      ],
    });
    await run((tx) =>
      update(tx, project.owner, task, { ...data(task), runId: failed.id }),
    );
    const body = (await get("owner", assignment.id)).json();
    const runs = Object.fromEntries(body.runs.map((r: any) => [r.id, r]));
    const states = Object.fromEntries(
      runs[passed.id].deliverables.map((d: any) => [d.contentId, d]),
    );
    expect(states[expired.content.id].state).toBe("expired");
    expect(states[failedPub.content.id]).toMatchObject({
      state: "failed",
      publication: { errorCode: "HANDOFF_DEPENDENCY_CHANGED" },
    });
    expect(runs[passed.id].retryable).toBe(false);
    expect(runs[failed.id].errors).toContainEqual({
      step: "strategy",
      code: "AGENT_OUTPUT_INVALID",
    });
    expect(runs[failed.id].retryable).toBe(true);
    // Newest first.
    expect(body.runs[0].id).toBe(failed.id);
    expect(runs[failed.id]).toMatchObject({
      retiredAt: null,
      retriedByRunId: null,
    });
  });

  it("names a retried run's new run instead of showing an open failure", async () => {
    const assignment = await confirmed();
    const retiredAt = new Date().toISOString();
    const retired = await makeRun(assignment.id, {
      status: "failed",
      retiredAt,
      retriedByRunId: "33333333-3333-4333-8333-333333333333",
    });
    const body = (await get("owner", assignment.id)).json();
    const row = body.runs.find((r: any) => r.id === retired.id);
    expect(row).toMatchObject({
      status: "failed",
      retiredAt,
      retriedByRunId: "33333333-3333-4333-8333-333333333333",
      retryable: false,
    });
  });

  it("marks dropped, canceled and released deliverables", async () => {
    const assignment = await confirmed();
    const runRow = await makeRun(assignment.id);
    const dropped = await deliverable(assignment.id, runRow.id, {});
    const canceled = await deliverable(assignment.id, runRow.id, {
      status: "reviewed",
      supersededBy: randomUUID(),
    });
    const released = await deliverable(
      assignment.id,
      runRow.id,
      { status: "reviewed" },
      {
        status: "scheduled_remote",
        publishingBackend: "social",
        remoteId: randomUUID(),
      },
    );
    await run((tx) =>
      update(tx, project.owner, runRow, {
        ...data(runRow),
        scheduling: {
          at: new Date().toISOString(),
          publicationIds: [],
          dropped: [
            { contentId: dropped.content.id, code: "SLOT_UNAVAILABLE" },
          ],
        },
      }),
    );
    const [r] = (await get("editor", assignment.id)).json().runs;
    const states = Object.fromEntries(
      r.deliverables.map((d: any) => [d.contentId, d.state]),
    );
    expect(states).toEqual({
      [dropped.content.id]: "dropped",
      [canceled.content.id]: "canceled",
      [released.content.id]: "released",
    });
  });

  it("viewers may read; another project's assignment is 404; 404 while the flag is off", async () => {
    const assignment = await confirmed();
    expect((await get("viewer", assignment.id)).statusCode).toBe(200);
    expect((await get("owner", randomUUID())).statusCode).toBe(404);
    const other = await createPackageProject();
    try {
      const foreign = await scoped(
        other.owner.workspaceId,
        other.owner.projectId,
        (tx) =>
          create(tx, other.owner, "assignments", {
            name: "Foreign",
            status: "active",
            channels: [],
            schedule: { rhythm: "daily", times: ["09:00"], weekdays: [] },
          }),
      );
      expect((await get("owner", foreign.id)).statusCode).toBe(404);
    } finally {
      await other.cleanup();
    }
    delete process.env.ORBIT_AGENTS;
    expect((await get("owner", assignment.id)).statusCode).toBe(404);
  });
});

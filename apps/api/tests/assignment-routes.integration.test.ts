import { randomBytes, randomUUID } from "node:crypto";
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
import { create, data, entity } from "../src/shared.ts";
import { chatScoped, createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { proposeAssignment } from "../src/modules/agents/assignments.ts";
import { configureAutopilot } from "../src/modules/autopilot.ts";
import { runBudgetKey } from "../src/modules/agents/specialists/runner.ts";
import {
  assignmentCardOf,
  assignmentTools,
} from "../src/modules/agents/tools/assignment-tools.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The Orbit Agents web routes: the assignments list and its status changes,
 * the upcoming assignment posts with their Stop, and the role rules and the
 * flag around them.
 */
describe.skipIf(!enabled)("Orbit Agents routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const origin = () => process.env.APP_ORIGIN!;
  const people = {} as Record<
    "owner" | "editor" | "viewer",
    { id: string; cookie: string }
  >;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const base = {
    name: "Daily product post",
    kind: "standing" as const,
    schedule: { rhythm: "daily" as const, weekdays: [], times: ["09:00"] },
    contentType: "social" as const,
    channels: [X],
    topicFrame: "Short updates about beta access for product teams",
    image: false,
    styleAssetIds: [],
    monthlyBudgetMicros: 30_000_000,
  };
  const propose = async (changes: Record<string, unknown> = {}) => {
    const thread = await createConversation(project.editor);
    return proposeAssignment(project.editor, thread.id, {
      ...base,
      ...changes,
    });
  };
  const confirmed = async (changes: Record<string, unknown> = {}) => {
    const { assignment, actionRequest } = await propose(changes);
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
  const request = (
    who: keyof typeof people,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project.owner.projectId}/${path}`,
      headers: { origin: origin(), cookie: people[who].cookie },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  /** An assignment post as scheduleApproved leaves it, with its draft. */
  const assignmentPost = (
    assignmentId: string,
    status = "intent_created",
    extra: Record<string, unknown> = {},
  ) =>
    run(async (tx) => {
      const content = await create(tx, project.owner, "content", {
        title: "Beta post",
        type: "social",
        channel: X,
        status: "reviewed",
        body: `Beta access is open for product teams. ${"More detail. ".repeat(40)}`,
      });
      return create(tx, project.owner, "publications", {
        status,
        contentId: content.id,
        channel: X,
        scheduledAt: new Date(Date.now() + 4 * 3600000).toISOString(),
        vetoDeadline: new Date(Date.now() + 3600000).toISOString(),
        vetoedAt: null,
        assignmentId,
        assignmentRunId: randomUUID(),
        remoteId: null,
        ...extra,
      });
    });

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    for (const role of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: `Synthetic routes ${role}`, password },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: origin() },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
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
    // The signed-in people join the project with their role, as add-member does.
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

  it("reports one month cost in the chat tool and the list while a call is held", async () => {
    const active = await confirmed();
    await run(async (tx) => {
      // The run's own cost field lags behind: only the settled call is in it.
      const runRow = await create(tx, project.owner, "assignment_runs", {
        assignmentId: active.id,
        date: new Date().toISOString().slice(0, 10),
        status: "running",
        costMicros: 1_250_000,
      });
      const reservation = (state: string, amount: bigint, settled?: bigint) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            key: `synthetic:${randomUUID()}`,
            amountMicros: amount,
            ...(settled === undefined ? {} : { settledMicros: settled }),
            category: "model",
            state,
          },
        });
      const settled = await reservation("settled", 2_000_000n, 1_250_000n);
      const held = await reservation("reserved", 700_000n);
      await create(tx, project.owner, "budget_runs", {
        runKey: runBudgetKey(runRow.id),
        reservationIds: [settled.id, held.id],
      });
    });
    const listed = (await request("viewer", "GET", "assignments")).json()
      .items as Array<Record<string, any>>;
    const tool = assignmentTools.find((t) => t.name === "assignment_list")!;
    const output = (
      await tool.execute(
        {
          scope: project.viewer,
          runId: "run",
          conversationId: "conversation",
          callIndex: 1,
        },
        {},
      )
    ).output as { assignments: Array<Record<string, any>> };
    const fromList = listed.find((item) => item.id === active.id)!;
    const fromTool = output.assignments.find((item) => item.id === active.id)!;
    expect(fromList.monthCostMicros).toBe(1_950_000);
    expect(fromTool.monthCostMicros).toBe(fromList.monthCostMicros);
  });

  it("keeps runs and agent tasks out of the generic collection read", async () => {
    await confirmed();
    for (const flag of ["true", undefined]) {
      if (flag) process.env.ORBIT_AGENTS = flag;
      else delete process.env.ORBIT_AGENTS;
      for (const kind of ["assignment_runs", "agent_tasks"]) {
        const r = await request("owner", "GET", kind);
        expect([flag, kind, r.statusCode]).toEqual([flag, kind, 400]);
      }
    }
  });

  it("lists assignments with next run, month cost and the open confirmation", async () => {
    const active = await confirmed();
    const draft = await propose({ name: "Weekly recap", image: true });
    // One settled paid call of a run of the active assignment this month.
    await run(async (tx) => {
      const runRow = await create(tx, project.owner, "assignment_runs", {
        assignmentId: active.id,
        date: new Date().toISOString().slice(0, 10),
        status: "done",
        costMicros: 1_250_000,
      });
      const reservation = await tx.budgetReservation.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          key: `synthetic:${randomUUID()}`,
          amountMicros: 2_000_000n,
          settledMicros: 1_250_000n,
          category: "model",
          state: "settled",
        },
      });
      await create(tx, project.owner, "budget_runs", {
        runKey: runBudgetKey(runRow.id),
        reservationIds: [reservation.id],
      });
    });

    const r = await request("viewer", "GET", "assignments");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<Record<string, any>>;
    const listed = items.find((item) => item.id === active.id)!;
    expect(listed).toMatchObject({
      version: active.version,
      name: "Daily product post",
      status: "active",
      kind: "standing",
      contentType: "social",
      channels: [X],
      channelNames: { [X]: "Synthetic X" },
      schedule: { rhythm: "daily", times: ["09:00"] },
      monthCostMicros: 1_250_000,
      monthlyBudgetMicros: 30_000_000,
      actionRequestId: null,
    });
    expect(Date.parse(listed.nextRunAt)).toBeGreaterThan(Date.now());
    const pending = items.find((item) => item.id === draft.assignment.id)!;
    expect(pending).toMatchObject({
      status: "draft",
      image: true,
      nextRunAt: null,
      monthCostMicros: 0,
      actionRequestId: draft.actionRequest.id,
    });
    // Nothing internal leaves the server.
    expect(JSON.stringify(items)).not.toContain("conversationId");
  });

  it("lets editors pause and end, only the owner resume, and no viewer change anything", async () => {
    const row = await confirmed();
    const status = (who: keyof typeof people, next: string, version: number) =>
      request(who, "POST", `assignments/${row.id}/status`, {
        status: next,
        version,
      });

    expect((await status("viewer", "paused", row.version)).statusCode).toBe(
      403,
    );
    const paused = await status("editor", "paused", row.version);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      id: row.id,
      status: "paused",
      version: row.version + 1,
    });
    const resumeByEditor = await status("editor", "active", row.version + 1);
    expect(resumeByEditor.statusCode).toBe(403);
    expect(resumeByEditor.json().error.code).toBe("OWNER_REQUIRED");
    // The version binds the change to the state the person saw.
    const stale = await status("owner", "active", row.version);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
    const resumed = await status("owner", "active", row.version + 1);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe("active");
    const ended = await status("editor", "ended", row.version + 2);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().status).toBe("ended");
    expect((await status("editor", "draft", row.version + 3)).statusCode).toBe(
      400,
    );
  });

  it("lists the upcoming assignment posts and stops one", async () => {
    const assignment = await confirmed();
    const upcoming = await assignmentPost(assignment.id);
    const blocked = await assignmentPost(assignment.id, "blocked_dependency");
    // Handed over, claimed or without a veto window: not Orbit's to stop.
    await assignmentPost(assignment.id, "scheduled_remote", {
      remoteId: "remote-1",
    });
    await assignmentPost(assignment.id, "blocked_dependency", {
      handoffAt: new Date().toISOString(),
    });
    await assignmentPost(assignment.id, "intent_created", {
      vetoDeadline: undefined,
      assignmentId: undefined,
    });

    const r = await request("viewer", "GET", "assignment-posts");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<Record<string, any>>;
    expect(items.map((item) => item.id).sort()).toEqual(
      [upcoming.id, blocked.id].sort(),
    );
    const item = items.find((entry) => entry.id === upcoming.id)!;
    expect(item).toMatchObject({
      version: upcoming.version,
      status: "intent_created",
      channel: X,
      channelName: "Synthetic X",
      scheduledAt: data(upcoming).scheduledAt,
      vetoDeadline: data(upcoming).vetoDeadline,
      assignmentId: assignment.id,
      assignmentName: "Daily product post",
    });
    expect(item.excerpt.startsWith("Beta access is open")).toBe(true);
    expect(item.excerpt.length).toBeLessThanOrEqual(281);

    const viewerStop = await request(
      "viewer",
      "POST",
      `publications/${upcoming.id}/veto`,
      { version: upcoming.version },
    );
    expect(viewerStop.statusCode).toBe(403);
    const stopped = await request(
      "editor",
      "POST",
      `publications/${upcoming.id}/veto`,
      { version: upcoming.version, reason: "Not this week" },
    );
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ result: "vetoed" });
    const saved = await run((tx) =>
      entity(tx, project.owner, "publications", upcoming.id),
    );
    expect(data(saved)).toMatchObject({
      status: "canceled",
      vetoSource: "orbit",
      vetoedBy: people.editor.id,
    });
    const after = await request("viewer", "GET", "assignment-posts");
    expect(
      (after.json().items as Array<{ id: string }>).map((entry) => entry.id),
    ).toEqual([blocked.id]);
  });

  it("answers already_handed_over for a post Postiz already has", async () => {
    const assignment = await confirmed();
    const handed = await assignmentPost(assignment.id, "scheduled_remote", {
      remoteId: "remote-2",
    });
    const r = await request("owner", "POST", `publications/${handed.id}/veto`, {
      version: handed.version,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ result: "already_handed_over" });
    const unchanged = await run((tx) =>
      entity(tx, project.owner, "publications", handed.id),
    );
    expect(unchanged.version).toBe(handed.version);
    expect(data(unchanged).status).toBe("scheduled_remote");
  });

  it("returns assignment cards with their live state and confirms only with image consent", async () => {
    const { assignment, actionRequest } = await propose({ image: true });
    const thread = (
      await request("owner", "POST", "chat/conversations", {})
    ).json() as { id: string };
    // A reply of Orbit Core with the confirmation card, as assignment_propose returns it.
    await chatScoped({ ...project.owner, userId: people.owner.id }, (tx) =>
      tx.chatMessage.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: people.owner.id,
          conversationId: thread.id,
          sequence: 1,
          role: "assistant",
          text: "Please confirm the assignment.",
          cards: [
            {
              kind: "assignment",
              label: "Assignment awaiting confirmation: Daily product post",
              status: "confirmation_required",
              assignment: assignmentCardOf(assignment),
            },
          ],
        },
      }),
    );
    const detail = async () =>
      (
        await request("owner", "GET", `chat/conversations/${thread.id}`)
      ).json() as { assignments: Array<Record<string, any>> };
    const before = (await detail()).assignments;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      id: assignment.id,
      status: "draft",
      image: true,
      channelNames: { [X]: "Synthetic X" },
      actionRequest: {
        id: actionRequest.id,
        version: actionRequest.version,
        packageHash: data(actionRequest).packageHash,
        status: "pending",
      },
    });

    const decide = (extra: Record<string, unknown>) =>
      request("owner", "POST", `action-requests/${actionRequest.id}/decide`, {
        version: actionRequest.version,
        packageHash: data(actionRequest).packageHash,
        decision: "approve",
        ...extra,
      });
    const withoutConsent = await decide({});
    expect(withoutConsent.statusCode).toBe(409);
    expect(withoutConsent.json().error.code).toBe(
      "IMAGE_RIGHTS_CONSENT_REQUIRED",
    );
    // The approvals inbox shows the owner the same fields to decide on.
    const inbox = (await request("owner", "GET", "action-requests")).json()
      .items as Array<Record<string, any>>;
    expect(
      inbox.find((item) => item.id === actionRequest.id)?.summary.assignment,
    ).toMatchObject({
      id: assignment.id,
      name: "Daily product post",
      image: true,
      channelNames: { [X]: "Synthetic X" },
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
    });
    expect((await decide({ imageRightsConsent: true })).statusCode).toBe(200);
    const after = (await detail()).assignments[0]!;
    expect(after.status).toBe("active");
    expect(after.actionRequest.status).toBe("approved");
  });

  it("shows the Telegram connection to the owner only", async () => {
    expect((await request("viewer", "GET", "telegram")).statusCode).toBe(403);
    expect((await request("editor", "GET", "telegram")).statusCode).toBe(403);
    const r = await request("owner", "GET", "telegram");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "none", linkedAt: null });
  });

  it("offers the saved autopilot as a draft assignment and proposes it once", async () => {
    let r = await request("viewer", "GET", "assignments/autopilot-migration");
    expect(r.json()).toEqual({
      proposal: null,
      channelNames: {},
      assignment: null,
    });
    await run((tx) =>
      configureAutopilot(tx, project.owner, {
        enabled: true,
        channels: [X],
        factKeys: ["beta.access"],
        assetIds: [],
        planWeekday: 1,
        planTime: "08:00",
      }),
    );
    r = await request("viewer", "GET", "assignments/autopilot-migration");
    expect(r.statusCode).toBe(200);
    expect(r.json().proposal).toMatchObject({
      channels: [X],
      schedule: { rhythm: "daily", times: ["17:00"] },
    });
    expect(
      (await request("viewer", "POST", "assignments/autopilot-migration", {}))
        .statusCode,
    ).toBe(403);
    r = await request("editor", "POST", "assignments/autopilot-migration", {});
    expect(r.statusCode).toBe(200);
    const { assignmentId, actionRequestId } = r.json();
    const draft = await run((tx) =>
      entity(tx, project.owner, "assignments", assignmentId),
    );
    expect(data(draft)).toMatchObject({ status: "draft", actionRequestId });
    r = await request("owner", "GET", "assignments/autopilot-migration");
    expect(r.json().assignment).toEqual({
      id: assignmentId,
      status: "draft",
      actionRequestId,
    });
    r = await request("owner", "POST", "assignments/autopilot-migration", {});
    expect([r.statusCode, r.json().error.code]).toEqual([
      409,
      "AUTOPILOT_ALREADY_PROPOSED",
    ]);
  });

  it("answers 404 on every Orbit Agents route while the flag is off", async () => {
    const assignment = await confirmed();
    const post = await assignmentPost(assignment.id);
    delete process.env.ORBIT_AGENTS;
    const calls: Array<[keyof typeof people, "GET" | "POST", string, unknown]> =
      [
        ["owner", "GET", "assignments", undefined],
        [
          "owner",
          "POST",
          `assignments/${assignment.id}/status`,
          { status: "paused", version: assignment.version },
        ],
        ["owner", "GET", "assignment-posts", undefined],
        [
          "owner",
          "POST",
          `publications/${post.id}/veto`,
          { version: post.version },
        ],
        ["owner", "GET", "telegram", undefined],
        ["owner", "GET", "assignments/autopilot-migration", undefined],
        ["owner", "POST", "assignments/autopilot-migration", {}],
        // Before authentication and role checks, too.
        ["viewer", "POST", `publications/${post.id}/veto`, { version: 1 }],
      ];
    for (const [who, method, path, payload] of calls) {
      const r = await request(who, method, path, payload);
      expect([path, r.statusCode]).toEqual([path, 404]);
    }
    const unchanged = await run((tx) =>
      entity(tx, project.owner, "assignments", assignment.id),
    );
    expect(data(unchanged).status).toBe("active");
  });
});

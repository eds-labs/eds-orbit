import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import { assignmentHash } from "../src/modules/marketing/agents/assignments.ts";
import type { AttentionResponse } from "../src/platform/attention/types.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const HOUR = 3_600_000;
const CHANNEL = "x-attention";

/**
 * The marketing module's attention items (UI restructure §4.1): assignment
 * drafts waiting for the owner, content to review, open exceptions, posts a
 * project pause stopped and failed runs, in the project's attention route.
 */
describe.skipIf(!enabled)("marketing attention items", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  const ids = { owner: "", viewer: "", editor: "" };
  const cookies = { owner: "", viewer: "", editor: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const attention = async (who: keyof typeof cookies = "owner") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${owner.projectId}/attention`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as AttentionResponse;
  };
  const marketingItems = async (who: keyof typeof cookies = "owner") =>
    (await attention(who)).items.filter((i) => i.moduleId === "marketing");
  const inHours = (hours: number) =>
    new Date(Date.now() + hours * HOUR).toISOString();

  const content = (fields: Record<string, unknown>) =>
    run((tx) =>
      create(tx, owner, "content", {
        type: "social",
        channel: CHANNEL,
        body: "SECRET-BODY must never reach the attention response",
        ...fields,
      }),
    );

  /** A draft the review left for the owner: it needs every row it is checked against. */
  const awaitingDraft = async (slotAt: string, name = "Two posts a day") =>
    run(async (tx) => {
      const body = {
        name,
        kind: "standing",
        schedule: {
          rhythm: "daily",
          weekdays: [],
          times: ["10:00"],
          leadMinutes: 360,
        },
        contentType: "social",
        channels: [CHANNEL],
      };
      const assignment = await create(tx, owner, "assignments", {
        ...body,
        status: "active",
        confirmation: {
          userId: owner.userId,
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(body),
        },
      });
      const runRow = await create(tx, owner, "assignment_runs", {
        assignmentId: assignment.id,
        status: "running",
        date: slotAt.slice(0, 10),
        slots: [],
        steps: [],
      });
      const mission = await create(tx, owner, "missions", {
        plannedSlotAt: slotAt,
      });
      const draft = await create(tx, owner, "content", {
        status: "needs_review",
        type: "social",
        channel: CHANNEL,
        body: "SECRET-BODY must never reach the attention response",
        assignmentId: assignment.id,
        assignmentRunId: runRow.id,
        missionId: mission.id,
      });
      return { draftId: draft.id, assignmentId: assignment.id };
    });

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "viewer", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic marketing attention",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.viewer, role: "viewer" },
            { userId: ids.editor, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Synthetic marketing attention",
        timezone: "Europe/Berlin",
      },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: ids.viewer,
        role: "viewer",
      },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: ids.editor,
        role: "editor",
      },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ids.owner,
      role: "owner",
    };
    await run((tx) =>
      create(tx, owner, "connectors", {
        provider: "postiz",
        status: "read_verified",
        channels: [
          {
            id: CHANNEL,
            name: "Synthetic X",
            identifier: "x",
            disabled: false,
          },
        ],
        assignedIntegrationIds: [CHANNEL],
      }),
    );
    for (const who of ["owner", "viewer", "editor"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    // Each test starts without attention rows.
    await run((tx) =>
      tx.entity.deleteMany({
        where: {
          kind: {
            in: [
              "content",
              "exceptions",
              "publications",
              "assignments",
              "assignment_runs",
              "missions",
            ],
          },
        },
      }),
    );
  });
  afterAll(async () => {
    delete process.env.ORBIT_AGENTS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("an awaiting draft is a warning with slotAt", async () => {
    process.env.ORBIT_AGENTS = "true";
    const slotAt = inHours(3);
    const { draftId } = await awaitingDraft(slotAt);
    const items = await marketingItems();
    expect(items.filter((i) => i.kind === "marketing_draft_release")).toEqual([
      {
        id: `marketing:draft:${draftId}`,
        moduleId: "marketing",
        kind: "marketing_draft_release",
        severity: "warning",
        dueAt: slotAt,
        params: {
          assignmentName: "Two posts a day",
          channelName: "Synthetic X",
          slotAt,
        },
        navKey: "approvals",
        link: "/approvals",
      },
    ]);
    // The draft is its own item: the content review does not count it again.
    expect(items.some((i) => i.kind === "marketing_content_review")).toBe(
      false,
    );
    expect(JSON.stringify(items)).not.toContain("SECRET-BODY");
  });

  it("no draft items while agents are off", async () => {
    await awaitingDraft(inHours(3));
    const items = await marketingItems();
    expect(items.some((i) => i.kind === "marketing_draft_release")).toBe(false);
    // Without agents the draft is plain content to review.
    expect(
      items.find((i) => i.kind === "marketing_content_review"),
    ).toMatchObject({ count: 1 });
  });

  it("a viewer gets no draft items", async () => {
    process.env.ORBIT_AGENTS = "true";
    await awaitingDraft(inHours(3));
    const items = await marketingItems("viewer");
    expect(items.some((i) => i.kind === "marketing_draft_release")).toBe(false);
    // The draft still needs review, which any member may see.
    expect(
      items.find((i) => i.kind === "marketing_content_review"),
    ).toMatchObject({ count: 1 });
  });

  it("an owner sees the draft and a review count of the other content", async () => {
    process.env.ORBIT_AGENTS = "true";
    const { draftId } = await awaitingDraft(inHours(3));
    await content({ status: "review" });
    await content({ status: "draft" });
    const items = await marketingItems();
    expect(
      items
        .filter((i) => i.kind === "marketing_draft_release")
        .map((i) => i.id),
    ).toEqual([`marketing:draft:${draftId}`]);
    expect(
      items.find((i) => i.kind === "marketing_content_review"),
    ).toMatchObject({ count: 2 });
  });

  it("an editor gets no draft item; the review count includes the draft", async () => {
    process.env.ORBIT_AGENTS = "true";
    await awaitingDraft(inHours(3));
    await content({ status: "review" });
    await content({ status: "draft" });
    const items = await marketingItems("editor");
    expect(items.some((i) => i.kind === "marketing_draft_release")).toBe(false);
    expect(
      items.find((i) => i.kind === "marketing_content_review"),
    ).toMatchObject({ count: 3 });
  });

  it("many resolved exceptions do not hide an open one", async () => {
    await run(async (tx) => {
      for (let i = 0; i < 120; i++)
        await create(tx, owner, "exceptions", {
          code: `OLD_${i}`,
          status: "resolved",
          count: 1,
          resourceIds: [`r${i}`],
          lastSeenAt: new Date().toISOString(),
        });
    });
    await run((tx) =>
      create(tx, owner, "exceptions", {
        code: "STILL_OPEN",
        status: "open",
        count: 1,
        resourceIds: ["x"],
        lastSeenAt: new Date().toISOString(),
      }),
    );
    const items = (await marketingItems()).filter(
      (i) => i.kind === "marketing_exception",
    );
    expect(items.map((i) => i.id)).toEqual(["marketing:exception:STILL_OPEN"]);
  });

  it("OUTCOME_UNKNOWN exception is critical", async () => {
    await run(async (tx) => {
      await create(tx, owner, "exceptions", {
        code: "EMAIL_OUTCOME_UNKNOWN",
        status: "open",
        count: 5,
        resourceIds: ["a", "b"],
        lastSeenAt: new Date().toISOString(),
      });
      await create(tx, owner, "exceptions", {
        code: "DRIVE_UPLOAD_FAILED",
        status: "open",
        count: 1,
        resourceIds: ["c"],
        lastSeenAt: new Date().toISOString(),
      });
      await create(tx, owner, "exceptions", {
        code: "OLD_THING_OUTCOME_UNKNOWN",
        status: "resolved",
        count: 1,
        resourceIds: ["d"],
        lastSeenAt: new Date().toISOString(),
      });
    });
    const items = (await marketingItems()).filter(
      (i) => i.kind === "marketing_exception",
    );
    expect(items.map((i) => i.id).sort()).toEqual([
      "marketing:exception:DRIVE_UPLOAD_FAILED",
      "marketing:exception:EMAIL_OUTCOME_UNKNOWN",
    ]);
    const unknown = items.find(
      (i) => i.params.code === "EMAIL_OUTCOME_UNKNOWN",
    );
    expect(unknown).toMatchObject({
      severity: "critical",
      params: { code: "EMAIL_OUTCOME_UNKNOWN", affected: 2 },
      navKey: "approvals",
      link: "/approvals",
    });
    // One open exception is one thing to act on, whatever it affects (R19).
    expect(unknown?.count).toBeUndefined();
    expect(
      items.find((i) => i.params.code === "DRIVE_UPLOAD_FAILED"),
    ).toMatchObject({
      severity: "warning",
      params: { code: "DRIVE_UPLOAD_FAILED", affected: 1 },
    });
    expect((await attention()).counts.approvals).toBe(2);
  });

  it("content review aggregated by status list", async () => {
    for (const status of ["review", "needs_review", "draft", "blocked"])
      await content({ status });
    await content({ status: "pending_approval" });
    // Archived, approved and published content is not waiting for review.
    for (const status of ["archived", "approved", "published"])
      await content({ status });
    const review = (await marketingItems()).filter(
      (i) => i.kind === "marketing_content_review",
    );
    expect(review).toEqual([
      expect.objectContaining({
        id: "marketing:content-review",
        moduleId: "marketing",
        severity: "warning",
        count: 5,
        navKey: "approvals",
        link: "/approvals",
        params: {},
      }),
    ]);
    expect((await attention()).counts.approvals).toBe(5);
  });

  it("aggregates the posts a project pause stopped", async () => {
    const first = inHours(2);
    const publication = (fields: Record<string, unknown>) =>
      run((tx) =>
        create(tx, owner, "publications", {
          channel: CHANNEL,
          status: "blocked_dependency",
          reason: "PROJECT_PAUSED",
          scheduledAt: inHours(5),
          ...fields,
        }),
      );
    await publication({ scheduledAt: first });
    await publication({});
    // Past slots, other reasons and other statuses are not paused posts.
    await publication({ scheduledAt: inHours(-1) });
    await publication({ reason: "FACT_EXPIRED" });
    await publication({ status: "intent_created" });
    const paused = (await marketingItems()).filter(
      (i) => i.kind === "marketing_paused_posts",
    );
    expect(paused).toEqual([
      {
        id: "marketing:paused-posts",
        moduleId: "marketing",
        kind: "marketing_paused_posts",
        severity: "warning",
        count: 2,
        dueAt: first,
        params: {},
        navKey: "approvals",
        link: "/approvals",
      },
    ]);
  });

  it("a failed run is a critical run problem while agents are on", async () => {
    const failed = () =>
      run((tx) =>
        create(tx, owner, "assignment_runs", {
          assignmentId: randomUUID(),
          status: "failed",
          date: "2026-10-18",
          slots: [],
          steps: [],
        }),
      );
    await failed();
    await failed();
    expect(
      (await marketingItems()).some((i) => i.kind === "marketing_run_problem"),
    ).toBe(false);
    process.env.ORBIT_AGENTS = "true";
    const problems = (await marketingItems()).filter(
      (i) => i.kind === "marketing_run_problem",
    );
    expect(problems).toEqual([
      {
        id: "marketing:run-problem:RUN_FAILED",
        moduleId: "marketing",
        kind: "marketing_run_problem",
        severity: "critical",
        count: 2,
        params: { code: "RUN_FAILED" },
        navKey: "marketing-overview",
        link: "/marketing",
      },
    ]);
  });
});

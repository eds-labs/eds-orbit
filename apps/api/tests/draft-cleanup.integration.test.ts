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
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, list } from "../src/shared.ts";
import {
  archiveOldDrafts,
  DRAFT_STATUSES,
  restoreDraftCleanup,
} from "../src/modules/draft-cleanup.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Mario's clean start (2026-10-10): production held about 50 old drafts on
 * the approvals page and 6 ready missions. One owner action archives them,
 * reversibly, and keeps everything tied to a post that may still go out.
 */
describe.skipIf(!enabled)("archiving old drafts in one step", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope, workspaceId: string;
  const people = {} as Record<
    "owner" | "editor" | "viewer",
    { id: string; cookie: string }
  >;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const request = (who: keyof typeof people, path: string, payload?: unknown) =>
    app.inject({
      method: payload === undefined ? "GET" : "POST",
      url: `/api/projects/${owner.projectId}/${path}`,
      headers: { origin: process.env.APP_ORIGIN!, cookie: people[who].cookie },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  const cleanup = (input: unknown, scope = owner) =>
    run((tx) => archiveOldDrafts(tx, scope, input));
  const restore = (cleanupId: string) =>
    run((tx) => restoreDraftCleanup(tx, owner, { cleanupId }));
  /** Every row of the project as `kind:id → version`, to prove what changed. */
  const versions = () =>
    run(async (tx) =>
      Object.fromEntries(
        (
          await tx.entity.findMany({ where: { projectId: owner.projectId } })
        ).map((row) => [`${row.kind}:${row.id}`, row.version]),
      ),
    );

  /** The production mix in small: drafts of each kind, and what must stay. */
  const seed = () =>
    run(async (tx) => {
      const add = (kind: string, value: Record<string, unknown>) =>
        create(tx, owner, kind, value);
      const reviewDone = [{ key: "review", role: "review", status: "done" }];
      const runs = {
        active: await add("assignment_runs", { status: "running" }),
        done: await add("assignment_runs", { status: "done" }),
        partial: await add("assignment_runs", {
          status: "partial",
          steps: [{ key: "review", role: "review", status: "failed" }],
        }),
        failed: await add("assignment_runs", {
          status: "failed",
          steps: reviewDone,
        }),
        scheduled: await add("assignment_runs", {
          status: "done",
          steps: reviewDone,
          scheduledAt: new Date().toISOString(),
        }),
        // Review done, not scheduled yet: the sweep still schedules it.
        awaiting: await add("assignment_runs", {
          status: "done",
          steps: reviewDone,
        }),
      };
      const mission = (value: Record<string, unknown>) =>
        add("missions", { title: "Mission", status: "ready", ...value });
      const missions = {
        autopilot: await mission({ autopilot: true }),
        package: await mission({ packageId: randomUUID() }),
        other: await mission({}),
        settled: await mission({}),
        empty: await mission({}),
        busy: await mission({}),
        blockedJob: await mission({}),
        batch: await mission({ batch: { status: "running" } }),
        keeps: await mission({}),
        openByReference: await mission({}),
        unsettled: await mission({}),
        awaiting: await mission({ assignmentRunId: runs.awaiting.id }),
        activeRun: await mission({ assignmentRunId: runs.active.id }),
        completed: await mission({ status: "completed" }),
      };
      const draft = (status: string, extra: Record<string, unknown> = {}) =>
        add("content", { title: "Draft", status, body: "Text", ...extra });
      const of = (m: { id: string }) => ({ missionId: m.id });
      const archived = {
        autopilot: await draft("needs_review", of(missions.autopilot)),
        package: await draft("reviewed", of(missions.package)),
        loose: await draft("draft"),
        blocked: await draft("blocked", of(missions.other)),
        review: await draft("review", of(missions.other)),
        busy: await draft("pending_approval", of(missions.busy)),
        finalPublications: await draft("reviewed"),
        acceptedPostiz: await draft("reviewed"),
        doneRun: await draft("needs_review", { assignmentRunId: runs.done.id }),
        partialRun: await draft("needs_review", {
          assignmentRunId: runs.partial.id,
        }),
        failedRun: await draft("needs_review", {
          assignmentRunId: runs.failed.id,
        }),
        scheduledRun: await draft("needs_review", {
          assignmentRunId: runs.scheduled.id,
        }),
        blockedJob: await draft("draft", of(missions.blockedJob)),
        batch: await draft("draft", of(missions.batch)),
        settled: await draft("draft", of(missions.settled)),
        openByReference: await draft("draft", of(missions.openByReference)),
        unsettled: await draft("draft", of(missions.unsettled)),
      };
      const kept = {
        intent: await draft("reviewed", of(missions.keeps)),
        paused: await draft("needs_review"),
        remote: await draft("reviewed"),
        sending: await draft("reviewed"),
        unknown: await draft("reviewed"),
        decision: await draft("reviewed"),
        activeRun: await draft("needs_review", {
          assignmentRunId: runs.active.id,
        }),
        awaitingRun: await draft("needs_review", {
          ...of(missions.awaiting),
          assignmentRunId: runs.awaiting.id,
        }),
      };
      const untouched = {
        published: await draft("published", of(missions.completed)),
        approved: await draft("approved"),
        settledPost: await draft("published", of(missions.settled)),
        // Not a draft, but a post that may still go out keeps its mission.
        openPost: await draft("approved", of(missions.openByReference)),
        // Approved, no publication yet: neither settled nor referenced.
        unsettledPost: await draft("approved", of(missions.unsettled)),
      };
      const publication = (contentId: string, status: string) =>
        add("publications", { contentId, status, channel: "x" });
      await publication(kept.intent.id, "intent_created");
      await publication(kept.paused.id, "blocked_dependency");
      await publication(kept.remote.id, "scheduled_remote");
      for (const status of ["published", "canceled", "failed"])
        await publication(archived.finalPublications.id, status);
      await publication(untouched.settledPost.id, "published");
      await publication(untouched.openPost.id, "intent_created");
      const postiz = (contentId: string, status: string) =>
        add("postiz_drafts", { contentId, status });
      await postiz(kept.sending.id, "sending");
      await postiz(kept.unknown.id, "outcome_unknown");
      await postiz(archived.acceptedPostiz.id, "accepted");
      const request = (contentId: string, status: string) =>
        add("action_requests", {
          actionType: "content.schedule",
          status,
          payload: { contentId },
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        });
      await request(kept.decision.id, "pending");
      await request(archived.finalPublications.id, "consumed");
      await request(archived.loose.id, "rejected");
      const job = (resourceId: string, status: string) =>
        add("jobs", { topic: "generation", resourceId, status });
      await job(missions.busy.id, "queued");
      await job(missions.blockedJob.id, "blocked_dependency");
      await job(missions.other.id, "succeeded");
      return { missions, archived, kept, untouched };
    });

  const expectedSummary = {
    content: {
      total: 17,
      byStatus: {
        review: 1,
        needs_review: 5,
        reviewed: 3,
        draft: 6,
        blocked: 1,
        pending_approval: 1,
      },
      byMissionKind: { autopilot: 1, package: 1, other: 15 },
      alreadyInPostiz: 1,
    },
    missions: {
      total: 4,
      byMissionKind: { autopilot: 1, package: 1, other: 2 },
      // Ready missions that stay, by their first reason.
      kept: {
        total: 9,
        byReason: {
          ACTIVE_RUN: 2,
          BATCH_RUNNING: 1,
          ACTIVE_JOB: 2,
          NO_CONTENT: 1,
          KEPT_CONTENT: 2,
          UNSETTLED_CONTENT: 1,
        },
      },
    },
    kept: {
      total: 8,
      byReason: {
        HAS_OPEN_PUBLICATION: 3,
        HAS_OPEN_POSTIZ_DRAFT: 2,
        PENDING_DECISION: 1,
        ACTIVE_ASSIGNMENT_RUN: 2,
      },
    },
  };
  const expected = {
    content: expectedSummary.content.total,
    missions: expectedSummary.missions.total,
    kept: expectedSummary.kept.total,
  };

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    for (const role of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: `Synthetic cleanup ${role}`, password },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: process.env.APP_ORIGIN! },
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
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Isolated draft cleanup",
          members: { create: { userId: people.owner.id, role: "owner" } },
        },
      })
    ).id;
    const project = await authDb.project.create({
      data: { workspaceId, name: "Draft cleanup fixture" },
    });
    owner = {
      workspaceId,
      projectId: project.id,
      userId: people.owner.id,
      role: "owner",
    };
    for (const role of ["owner", "editor", "viewer"] as const) {
      if (role !== "owner")
        await authDb.workspaceMember.create({
          data: { workspaceId, userId: people[role].id, role: "viewer" },
        });
      await authDb.projectMember.create({
        data: {
          workspaceId,
          projectId: project.id,
          userId: people[role].id,
          role,
        },
      });
    }
  });
  afterEach(async () => {
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
  });
  afterAll(async () => {
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((p) => p.id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("previews the counts by status, mission kind and kept reason without changing anything", async () => {
    await seed();
    const before = await versions();
    const r = await request("owner", "actions/archive-old-drafts", {
      preview: true,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      preview: true,
      cleanupId: null,
      ...expectedSummary,
    });
    expect(await versions()).toEqual(before);
    const audits = await run((tx) =>
      tx.auditEvent.count({
        where: { projectId: owner.projectId, action: "drafts.cleaned_up" },
      }),
    );
    expect(audits).toBe(0);
  });

  it("archives exactly the eligible drafts and ready missions and keeps what may still go out", async () => {
    const seeded = await seed();
    const before = await versions();
    const others = (
      await run((tx) =>
        tx.entity.findMany({
          where: {
            projectId: owner.projectId,
            kind: {
              in: [
                "publications",
                "postiz_drafts",
                "jobs",
                "assignment_runs",
                "action_requests",
              ],
            },
          },
          orderBy: { id: "asc" },
        }),
      )
    ).map((row) => [row.id, row.version, row.data]);
    // The real run needs the explicit confirmation and the counts shown.
    await expect(cleanup({ preview: false })).rejects.toThrow(
      "CLEANUP_CONFIRMATION_REQUIRED",
    );
    await expect(cleanup({ confirm: true })).rejects.toThrow(
      "CLEANUP_CONFIRMATION_REQUIRED",
    );
    await expect(cleanup({ preview: true, extra: 1 })).rejects.toThrow();
    // Counts that no longer match a fresh plan change nothing.
    for (const stale of [
      { ...expected, content: expected.content - 1 },
      { ...expected, missions: expected.missions + 1 },
      { ...expected, kept: 0 },
    ])
      await expect(cleanup({ confirm: true, expected: stale })).rejects.toThrow(
        "CLEANUP_CHANGED",
      );
    expect(await versions()).toEqual(before);
    const result = await cleanup({ confirm: true, expected });
    expect(result).toMatchObject({ preview: false, ...expectedSummary });
    expect(result.cleanupId).toMatch(/^[\da-f-]{36}$/);
    const content = new Map(
      (await run((tx) => list(tx, owner, "content"))).map((row) => [
        row.id,
        row,
      ]),
    );
    for (const row of Object.values(seeded.archived)) {
      const after = content.get(row.id)!;
      expect(data(after)).toMatchObject({
        status: "archived",
        statusBeforeArchive: data(row).status,
        archivedBy: owner.userId,
        archiveReason: "OWNER_CLEANUP",
        cleanupId: result.cleanupId,
      });
      expect(Date.parse(data(after).archivedAt)).not.toBeNaN();
      expect(after.version).toBe(row.version + 1);
    }
    for (const row of [
      ...Object.values(seeded.kept),
      ...Object.values(seeded.untouched),
    ])
      expect(content.get(row.id)!.version).toBe(row.version);
    const missions = new Map(
      (await run((tx) => list(tx, owner, "missions"))).map((m) => [m.id, m]),
    );
    const { autopilot, package: pkg, other, settled } = seeded.missions;
    for (const m of [autopilot, pkg, other, settled])
      expect(data(missions.get(m.id))).toMatchObject({
        status: "archived",
        statusBeforeArchive: "ready",
        archiveReason: "OWNER_CLEANUP",
        cleanupId: result.cleanupId,
      });
    // No content of its own, a queued or blocked job, a running batch, kept
    // content (also a post that is not a draft), content that is neither
    // archived now nor settled (an approved post without publication), a run
    // that is still active or about to be scheduled, or another status keep
    // a mission.
    for (const key of [
      "empty",
      "busy",
      "blockedJob",
      "batch",
      "keeps",
      "openByReference",
      "unsettled",
      "awaiting",
      "activeRun",
      "completed",
    ] as const) {
      const m = seeded.missions[key];
      expect([key, missions.get(m.id)!.version]).toEqual([key, m.version]);
    }
    // Publications, Postiz drafts, jobs and runs are untouched.
    const othersAfter = (
      await run((tx) =>
        tx.entity.findMany({
          where: {
            projectId: owner.projectId,
            kind: {
              in: [
                "publications",
                "postiz_drafts",
                "jobs",
                "assignment_runs",
                "action_requests",
              ],
            },
          },
          orderBy: { id: "asc" },
        }),
      )
    ).map((row) => [row.id, row.version, row.data]);
    expect(othersAfter).toEqual(others);
    const changed = Object.entries(await versions()).filter(
      ([key, version]) => before[key] !== version,
    );
    expect(changed).toHaveLength(17 + 4);
    const audits = await run((tx) =>
      tx.auditEvent.findMany({
        where: { projectId: owner.projectId, action: "drafts.cleaned_up" },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      cleanupId: result.cleanupId,
      content: { total: 17, alreadyInPostiz: 1 },
      missions: { total: 4 },
      kept: { total: 8 },
    });
    // A second run finds nothing left and changes nothing.
    const afterFirst = await versions();
    const second = await cleanup({
      confirm: true,
      expected: { content: 0, missions: 0, kept: 8 },
    });
    expect(second).toMatchObject({
      preview: false,
      cleanupId: null,
      content: { total: 0 },
      missions: { total: 0 },
      kept: { total: 8 },
    });
    expect(await versions()).toEqual(afterFirst);
  });

  it("restores exactly the rows of one cleanup to their previous status, once", async () => {
    await seed();
    const original = new Map(
      (
        await run((tx) =>
          tx.entity.findMany({
            where: {
              projectId: owner.projectId,
              kind: { in: ["content", "missions"] },
            },
          }),
        )
      ).map((row) => [row.id, row]),
    );
    const { cleanupId } = await cleanup({
      preview: false,
      confirm: true,
      expected,
    });
    // A mission archived by hand is not part of the cleanup.
    const own = await run((tx) =>
      create(tx, owner, "missions", {
        title: "Archived by hand",
        status: "archived",
        statusBeforeArchive: "completed",
      }),
    );
    const r = await request("owner", "actions/restore-draft-cleanup", {
      cleanupId,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      cleanupId,
      restored: { content: 17, missions: 4 },
    });
    const after = await run((tx) =>
      tx.entity.findMany({
        where: {
          projectId: owner.projectId,
          kind: { in: ["content", "missions"] },
        },
      }),
    );
    for (const row of after) {
      if (row.id === own.id) {
        expect(data(row).status).toBe("archived");
        continue;
      }
      const was = original.get(row.id)!;
      expect(row.data).toEqual(was.data);
    }
    expect(
      after.filter((row) => row.version === original.get(row.id)?.version! + 2),
    ).toHaveLength(21);
    const again = await restore(cleanupId!);
    expect(again.restored).toEqual({ content: 0, missions: 0 });
    // An unknown cleanup restores nothing either.
    expect((await restore(randomUUID())).restored).toEqual({
      content: 0,
      missions: 0,
    });
  });

  it("refuses editors and viewers with OWNER_REQUIRED", async () => {
    await seed();
    const before = await versions();
    for (const who of ["editor", "viewer"] as const)
      for (const [path, payload] of [
        ["actions/archive-old-drafts", { preview: true }],
        ["actions/archive-old-drafts", { confirm: true, expected }],
        ["actions/restore-draft-cleanup", { cleanupId: randomUUID() }],
      ] as const) {
        const r = await request(who, path, payload);
        expect([who, path, r.statusCode, r.json().error?.code]).toEqual([
          who,
          path,
          403,
          "OWNER_REQUIRED",
        ]);
      }
    await expect(
      cleanup({ confirm: true, expected }, { ...owner, role: "editor" }),
    ).rejects.toThrow("OWNER_REQUIRED");
    expect(await versions()).toEqual(before);
  });

  it("leaves archived drafts out of the approvals list", async () => {
    const seeded = await seed();
    const approvals = async () =>
      (
        (await request("viewer", "content")).json().items as Array<{
          id: string;
          data: Record<string, unknown>;
        }>
      )
        .filter((item) =>
          (DRAFT_STATUSES as readonly string[]).includes(
            String(item.data.status),
          ),
        )
        .map((item) => item.id)
        .sort();
    expect(await approvals()).toHaveLength(17 + 8);
    await cleanup({ confirm: true, expected });
    expect(await approvals()).toEqual(
      Object.values(seeded.kept)
        .map((row) => row.id)
        .sort(),
    );
  });
});

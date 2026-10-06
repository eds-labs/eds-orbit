import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { pauseProject } from "../src/modules/pause.ts";
import { resumePausedPublications } from "../src/modules/paused-posts.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../src/modules/agents/package-schedule.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Production uLiquid, 2026-10-06: the owner paused the project to stop ten
 * approved posts. Resuming must not send them silently, and there was no way
 * to schedule them again; a slot that passed during the pause stayed blocked.
 */
describe.skipIf(!enabled)("Posts stopped by a project pause", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  // One scheduled X post (test execution), approved by the owner.
  const scheduledPost = async () => {
    const { editor, owner } = project;
    const thread = await createConversation(editor);
    const { package: pkg, actionRequest } = await requestContentPackage(
      editor,
      thread.id,
      {
        goal: `Announce beta access ${Math.random().toString(36).slice(2)}`,
        channels: [X],
        factKeys: ["beta.access"],
      },
    );
    await run((tx) =>
      decideActionRequest(tx, editor, actionRequest.id, {
        version: actionRequest.version,
        packageHash: data(actionRequest).packageHash,
        decision: "approve",
      }),
    );
    await run(async (tx) => {
      for (const mission of (await list(tx, owner, "missions")).filter(
        (m) => data(m).packageId === pkg.id,
      )) {
        const job = (await list(tx, owner, "jobs")).find(
          (row) => data(row).resourceId === mission.id,
        )!;
        await deterministicDraft(tx, owner, mission.id, job.id);
      }
    });
    await run((tx) => sweepProject(tx, worker()));
    const proposed = await proposeSchedule(editor, thread.id, {
      deliverableKey: X,
    });
    const item = (await run((tx) => listActionRequests(tx, owner))).find(
      (row) => row.id === proposed.actionRequestId,
    )!;
    await run((tx) =>
      decideActionRequest(tx, owner, item.id, {
        version: item.version,
        packageHash: item.packageHash,
        decision: "approve",
      }),
    );
    const contentId = (
      await run(async (tx) =>
        packageSnapshot(
          tx,
          owner,
          await entity(tx, owner, "content_packages", pkg.id),
        ),
      )
    ).deliverables[0]!.content!.id as string;
    return (await run((tx) => list(tx, owner, "publications"))).find(
      (row) => data(row).contentId === contentId,
    )!;
  };
  const publication = (id: string) =>
    run((tx) => entity(tx, project.owner, "publications", id));
  const pause = (paused: boolean) =>
    run((tx) => pauseProject(tx, project.owner, paused));
  const resume = () => run((tx) => resumePausedPublications(tx, project.owner));

  beforeEach(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    project = await createPackageProject();
  });
  afterEach(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    await project.cleanup();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("schedules a stopped post again only on the owner's request after the pause ends", async () => {
    const post = await scheduledPost();
    await pause(true);
    expect(data(await publication(post.id))).toMatchObject({
      status: "blocked_dependency",
      reason: "PROJECT_PAUSED",
    });
    await expect(resume()).rejects.toThrow("PROJECT_PAUSED");
    await pause(false);
    // Resuming the project alone sends nothing.
    expect(data(await publication(post.id)).status).toBe("blocked_dependency");
    expect(await resume()).toMatchObject({ resumed: 1, blocked: [] });
    const resumed = data(await publication(post.id));
    expect(resumed.status).toBe("intent_created");
    expect(resumed.reason).toBeUndefined();
    const jobs = (await run((tx) => list(tx, project.owner, "jobs"))).filter(
      (job) =>
        data(job).topic === "publishing" &&
        data(job).resourceId === post.id &&
        data(job).status === "queued",
    );
    expect(jobs).toHaveLength(1);
    expect(data(jobs[0]!).availableAt).toBe(resumed.scheduledAt);
    // A second request changes nothing.
    expect(await resume()).toMatchObject({ resumed: 0, blocked: [] });
  });

  it("keeps a stopped post blocked and names the reason when its pre-publish check fails", async () => {
    const post = await scheduledPost();
    await pause(true);
    await pause(false);
    await run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), channels: [] });
    });
    const result = await resume();
    expect(result.resumed).toBe(0);
    expect(result.blocked).toEqual([
      expect.objectContaining({
        id: post.id,
        blockers: expect.arrayContaining(["SCOPE_NOT_ALLOWED"]),
      }),
    ]);
    expect(data(await publication(post.id)).status).toBe("blocked_dependency");
  });

  it("cancels a stopped post whose slot passed during the pause instead of sending it late", async () => {
    const post = await scheduledPost();
    await pause(true);
    await run(async (tx) =>
      update(
        tx,
        project.owner,
        await entity(tx, project.owner, "publications", post.id),
        {
          ...data(await entity(tx, project.owner, "publications", post.id)),
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ),
    );
    await pause(false);
    await run((tx) => sweepProject(tx, worker()));
    expect(data(await publication(post.id))).toMatchObject({
      status: "canceled",
      reason: "SLOT_PASSED",
    });
    expect(await resume()).toMatchObject({ resumed: 0, blocked: [] });
  });

  it("archives an autopilot draft whose slot passed without an owner decision", async () => {
    const { draft, upcoming } = await run(async (tx) => {
      const mission = await create(tx, project.owner, "missions", {
        autopilot: true,
        status: "completed",
        channels: [X],
      });
      const draftAt = (offset: number) =>
        create(tx, project.owner, "content", {
          type: "social",
          channel: X,
          body: `Autopilot draft ${offset}`,
          status: "needs_review",
          missionId: mission.id,
          scheduledAt: new Date(Date.now() + offset).toISOString(),
        });
      return {
        draft: await draftAt(-60_000),
        upcoming: await draftAt(86_400_000),
      };
    });
    await run((tx) => sweepProject(tx, worker()));
    const content = (id: string) =>
      run((tx) => entity(tx, project.owner, "content", id));
    expect(data(await content(draft.id))).toMatchObject({
      status: "archived",
      reason: "SLOT_PASSED",
    });
    expect(data(await content(upcoming.id)).status).toBe("needs_review");
  });
});

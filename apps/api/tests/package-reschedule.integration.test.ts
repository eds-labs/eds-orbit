import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { dispatchPublication } from "../src/modules/publisher.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/agents/content-packages.ts";
import {
  cancelPackageSchedule,
  proposeSchedule,
} from "../src/modules/agents/package-schedule.ts";
import { channelSlots } from "../src/modules/agents/scheduling.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("Cancel and reschedule package posts (J3.4)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const snapshot = (packageId: string) =>
    run(async (tx) =>
      packageSnapshot(
        tx,
        project.owner,
        await entity(tx, project.owner, "content_packages", packageId),
      ),
    );
  const decide = async (
    requestId: string,
    decision: "approve" | "reject" = "approve",
  ) => {
    const item = (
      await run((tx) => listActionRequests(tx, project.owner))
    ).find((candidate) => candidate.id === requestId)!;
    return run((tx) =>
      decideActionRequest(tx, project.owner, item.id, {
        version: item.version,
        packageHash: item.packageHash,
        decision,
      }),
    );
  };
  const publicationsOf = (contentId: string) =>
    run(async (tx) =>
      (await list(tx, project.owner, "publications")).filter(
        (row) => data(row).contentId === contentId,
      ),
    );
  // The editor's X package with a draft whose post an owner scheduled.
  const scheduledPackage = async (schedule = true) => {
    const { editor } = project;
    const thread = await createConversation(editor);
    const { package: pkg, actionRequest } = await requestContentPackage(
      editor,
      thread.id,
      {
        goal: "Announce that beta access is open",
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
      const step = (
        data(await entity(tx, project.owner, "content_packages", pkg.id))
          .steps as Array<Record<string, any>>
      )[0]!;
      await deterministicDraft(tx, project.owner, step.missionId, step.jobId);
    });
    await run((tx) => sweepProject(tx, worker()));
    const proposed = await proposeSchedule(editor, thread.id, {
      deliverableKey: X,
    });
    if (schedule) await decide(proposed.actionRequestId!);
    const contentId = (await snapshot(pkg.id)).deliverables[0]!.content!
      .id as string;
    return { thread, pkg, proposed, contentId };
  };
  // The slot arrives and the existing publisher hands the post over (test execution).
  const handOver = async (contentId: string) => {
    const [publication] = await publicationsOf(contentId);
    await run((tx) =>
      update(tx, project.owner, publication!, {
        ...data(publication),
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await dispatchPublication(project.owner, publication!.id);
  };
  const cancel = (scope: Scope, packageId: string) =>
    cancelPackageSchedule(scope, packageId, { deliverableKey: X });

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

  it("cancels a scheduled post before the handoff, and nothing is sent later", async () => {
    const { pkg, contentId } = await scheduledPackage();
    const result = await cancel(project.editor, pkg.id);
    expect(result).toMatchObject({
      result: "canceled",
      publicationStatus: "canceled",
    });
    const [publication] = await publicationsOf(contentId);
    expect(data(publication)).toMatchObject({
      status: "canceled",
      canceledBy: project.editor.userId,
    });
    const job = (await run((tx) => list(tx, project.owner, "jobs"))).find(
      (row) =>
        data(row).topic === "publishing" &&
        data(row).resourceId === publication!.id,
    )!;
    expect(data(job).status).toBe("canceled");
    // The mission may publish nothing any more.
    const content = await run((tx) =>
      entity(tx, project.owner, "content", contentId),
    );
    const mission = await run((tx) =>
      entity(tx, project.owner, "missions", data(content).missionId),
    );
    expect(data(mission).allowedActions).not.toContain("publish_test");
    expect((await snapshot(pkg.id)).deliverables[0]!.schedule).toMatchObject({
      status: "canceled",
    });
    // A late publishing job sends nothing.
    await run((tx) =>
      update(tx, project.owner, publication!, {
        ...data(publication),
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await dispatchPublication(project.owner, publication!.id);
    expect(data((await publicationsOf(contentId))[0]).status).toBe("canceled");
    // Cancelling again reports the same state.
    expect(await cancel(project.editor, pkg.id)).toMatchObject({
      result: "canceled",
    });
  });

  it("reports a handed-over post as not retractable and changes nothing", async () => {
    const { pkg, contentId } = await scheduledPackage();
    await handOver(contentId);
    expect(await cancel(project.owner, pkg.id)).toMatchObject({
      result: "not_retractable",
      publicationStatus: "published_test",
    });
    expect(data((await publicationsOf(contentId))[0]).status).toBe(
      "published_test",
    );
    await expect(
      proposeSchedule(project.editor, await scheduledThread(pkg.id), {
        deliverableKey: X,
      }),
    ).rejects.toThrow("PUBLICATION_NOT_RETRACTABLE");
  });

  it("reports a handoff in progress without touching it", async () => {
    const { pkg, contentId } = await scheduledPackage();
    const [publication] = await publicationsOf(contentId);
    await run((tx) =>
      update(tx, project.owner, publication!, {
        ...data(publication),
        status: "sending",
      }),
    );
    expect(await cancel(project.editor, pkg.id)).toMatchObject({
      result: "handoff_in_progress",
      publicationStatus: "sending",
    });
    expect(data((await publicationsOf(contentId))[0]).status).toBe("sending");
  });

  it("withdraws an open proposal", async () => {
    const { pkg, proposed, contentId } = await scheduledPackage(false);
    expect(await cancel(project.editor, pkg.id)).toMatchObject({
      result: "withdrawn",
    });
    expect(
      data(
        await run((tx) =>
          entity(
            tx,
            project.owner,
            "action_requests",
            proposed.actionRequestId!,
          ),
        ),
      ).status,
    ).toBe("canceled");
    expect(await publicationsOf(contentId)).toHaveLength(0);
    expect((await snapshot(pkg.id)).deliverables[0]!.schedule).toMatchObject({
      status: "canceled",
    });
  });

  it("moves a scheduled post only with a new owner decision", async () => {
    const { thread, pkg, proposed, contentId } = await scheduledPackage();
    const other = (
      await run((tx) => channelSlots(tx, project.owner, { channels: [X] }))
    ).channels[0]!.slots.find((slot) => slot.free)!;
    const move = await proposeSchedule(project.editor, thread.id, {
      deliverableKey: X,
      date: other.date,
    });
    expect(move).toMatchObject({
      status: "proposed",
      scheduledAt: other.at,
      replacesScheduledAt: proposed.scheduledAt,
    });
    // Until the owner decides, the post keeps its current slot.
    const [current] = await publicationsOf(contentId);
    expect(data(current)).toMatchObject({
      status: "intent_created",
      scheduledAt: proposed.scheduledAt,
    });
    const pending = (await snapshot(pkg.id)).deliverables[0]!.schedule!;
    expect(pending).toMatchObject({
      status: "scheduled",
      scheduledAt: proposed.scheduledAt,
      move: { status: "awaiting_approval", scheduledAt: other.at },
    });
    // A rejected move leaves the post where it was.
    await decide(move.actionRequestId!, "reject");
    expect(data((await publicationsOf(contentId))[0]).status).toBe(
      "intent_created",
    );
    expect(
      (await snapshot(pkg.id)).deliverables[0]!.schedule!.move,
    ).toMatchObject({ status: "rejected" });
    // A second proposal, approved: the old slot is canceled, the new one scheduled once.
    const again = await proposeSchedule(project.editor, thread.id, {
      deliverableKey: X,
      date: other.date,
    });
    await decide(again.actionRequestId!);
    const publications = await publicationsOf(contentId);
    expect(
      publications.map((row) => [data(row).status, data(row).scheduledAt]),
    ).toEqual(
      expect.arrayContaining([
        ["canceled", proposed.scheduledAt],
        ["intent_created", other.at],
      ]),
    );
    expect(publications).toHaveLength(2);
    expect(
      data(await run((tx) => entity(tx, project.owner, "content", contentId)))
        .scheduledAt,
    ).toBe(other.at);
    const moved = (await snapshot(pkg.id)).deliverables[0]!.schedule!;
    expect(moved).toMatchObject({ status: "scheduled", scheduledAt: other.at });
    expect(moved.move).toBeNull();
  });

  it("lets the requester or an owner cancel, also with the package flag off", async () => {
    const { pkg } = await scheduledPackage();
    await expect(cancel(project.viewer, pkg.id)).rejects.toThrow(
      "EDITOR_REQUIRED",
    );
    delete process.env.ORBIT_CONTENT_PACKAGES;
    expect(await cancel(project.owner, pkg.id)).toMatchObject({
      result: "canceled",
    });
  });

  async function scheduledThread(packageId: string) {
    return data(
      await run((tx) =>
        entity(tx, project.owner, "content_packages", packageId),
      ),
    ).conversationId as string;
  }
});

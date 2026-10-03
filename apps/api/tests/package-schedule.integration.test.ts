import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../src/modules/action-requests.ts";
import { deterministicDraft, publishIntent } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { dispatchPublication } from "../src/modules/publisher.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../src/modules/agents/package-schedule.ts";
import { channelSlots } from "../src/modules/agents/scheduling.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)(
  "Scheduling a package post by owner decision (J3.1)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const worker = () => ({
      ...project.owner,
      userId: "worker",
      role: "owner" as const,
    });
    const setPolicy = (changes: Record<string, unknown>) =>
      run(async (tx) => {
        const row = (await list(tx, project.owner, "policies")).find(
          (p) => data(p).active === true,
        )!;
        await update(tx, project.owner, row, { ...data(row), ...changes });
      });
    // A started X package with an automatically reviewed draft, requested by the editor.
    const readyPackage = async () => {
      const { editor } = project;
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
        for (const mission of (
          await list(tx, project.owner, "missions")
        ).filter((m) => data(m).packageId === pkg.id)) {
          const job = (await list(tx, project.owner, "jobs")).find(
            (row) => data(row).resourceId === mission.id,
          )!;
          await deterministicDraft(tx, project.owner, mission.id, job.id);
        }
      });
      await run((tx) => sweepProject(tx, worker()));
      return { thread, pkg };
    };
    const snapshot = (packageId: string) =>
      run(async (tx) =>
        packageSnapshot(
          tx,
          project.owner,
          await entity(tx, project.owner, "content_packages", packageId),
        ),
      );
    const decide = (
      scope: Scope,
      request: { id: string; version: number; packageHash: string },
      decision: "approve" | "reject" = "approve",
    ) =>
      run((tx) =>
        decideActionRequest(tx, scope, request.id, {
          version: request.version,
          packageHash: request.packageHash,
          decision,
        }),
      );
    const inboxItem = async (id: string) =>
      (await run((tx) => listActionRequests(tx, project.owner))).find(
        (item) => item.id === id,
      )!;
    const publicationsOf = (contentId: string) =>
      run(async (tx) =>
        (await list(tx, project.owner, "publications")).filter(
          (row) => data(row).contentId === contentId,
        ),
      );

    // A fresh project per case: earlier drafts with the same fact would block as duplicates.
    beforeEach(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
    });
    afterEach(async () => {
      process.env.EXECUTION_MODE = "test";
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
    });
    afterAll(async () => {
      await closeDatabase();
    });

    it("proposes the next free slot for the exact post and waits for an owner", async () => {
      const { thread, pkg } = await readyPackage();
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      expect(proposed.status).toBe("proposed");
      const free = (
        await run((tx) => channelSlots(tx, project.owner, { channels: [X] }))
      ).channels[0]!;
      expect(proposed.scheduledAt).toBe(free.nextFree);
      const contentId = (await snapshot(pkg.id)).deliverables[0]!.content!
        .id as string;
      // A proposal changes nothing on the draft: the slot is only in the request.
      expect(
        data(await run((tx) => entity(tx, project.owner, "content", contentId)))
          .scheduledAt ?? null,
      ).toBeNull();
      expect(await publicationsOf(contentId)).toHaveLength(0);
      const item = await inboxItem(proposed.actionRequestId!);
      expect(item).toMatchObject({
        actionType: "content.schedule",
        requestedBy: { userId: project.editor.userId },
        summary: {
          channel: X,
          scheduledAt: proposed.scheduledAt,
          body: (await snapshot(pkg.id)).deliverables[0]!.content!.body,
          executionMode: "test",
          packageGoal: data(pkg).goal,
        },
      });
      expect((await snapshot(pkg.id)).deliverables[0]!.schedule).toMatchObject({
        status: "awaiting_approval",
        scheduledAt: proposed.scheduledAt,
      });
    });

    it("schedules exactly that post on the owner's decision, once, and publishes it at the slot", async () => {
      const { thread, pkg } = await readyPackage();
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      const item = await inboxItem(proposed.actionRequestId!);
      await decide(project.owner, item);
      await decide(project.owner, item);
      const contentId = (await snapshot(pkg.id)).deliverables[0]!.content!
        .id as string;
      const [publication, ...more] = await publicationsOf(contentId);
      expect(more).toHaveLength(0);
      expect(data(publication)).toMatchObject({
        status: "intent_created",
        scheduledAt: proposed.scheduledAt,
        test: true,
      });
      const content = await run((tx) =>
        entity(tx, project.owner, "content", contentId),
      );
      expect(data(content)).toMatchObject({
        status: "reviewed",
        scheduledAt: proposed.scheduledAt,
      });
      const mission = await run((tx) =>
        entity(tx, project.owner, "missions", data(content).missionId),
      );
      expect(data(mission).allowedActions).toEqual(
        expect.arrayContaining(["draft", "publish_test"]),
      );
      expect(Date.parse(data(mission).endAt)).toBeGreaterThan(
        Date.parse(proposed.scheduledAt!),
      );
      expect(data(mission).allowedActions).not.toContain("publish_live");
      expect(
        data(
          await run((tx) =>
            entity(tx, project.owner, "action_requests", item.id),
          ),
        ).status,
      ).toBe("consumed");
      expect((await snapshot(pkg.id)).deliverables[0]!.schedule).toMatchObject({
        status: "scheduled",
      });
      // The slot arrives: the existing publisher runs its final preflight and publishes (test execution).
      await run((tx) =>
        update(tx, project.owner, publication!, {
          ...data(publication),
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await dispatchPublication(project.owner, publication!.id);
      expect((await snapshot(pkg.id)).deliverables[0]!.schedule).toMatchObject({
        status: "published_test",
      });
    });

    it("lets nothing publish a package draft without an owner decision (JC16)", async () => {
      const { thread, pkg } = await readyPackage();
      const draft = (await snapshot(pkg.id)).deliverables[0]!.content!;
      await expect(
        run((tx) =>
          publishIntent(tx, project.owner, {
            contentId: draft.id as string,
            version: draft.version as number,
          }),
        ),
      ).rejects.toThrow("MISSION_TEST_WRITE_NOT_AUTHORIZED");
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      await expect(
        decide(project.editor, await inboxItem(proposed.actionRequestId!)),
      ).rejects.toThrow("OWNER_REQUIRED");
    });

    it("rolls the decision back when live publishing is not possible, keeping the draft", async () => {
      const { thread, pkg } = await readyPackage();
      process.env.EXECUTION_MODE = "live";
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      const item = await inboxItem(proposed.actionRequestId!);
      await expect(decide(project.owner, item)).rejects.toThrow(
        /EXTERNAL_WRITES_DISABLED|CHANNEL_WRITE_VERIFICATION_REQUIRED|PUBLISHER_WRITE_VERIFICATION_REQUIRED/,
      );
      const draft = (await snapshot(pkg.id)).deliverables[0]!;
      expect(draft.status).toBe("drafted");
      expect(await publicationsOf(draft.content!.id as string)).toHaveLength(0);
      expect(
        data(
          await run((tx) =>
            entity(tx, project.owner, "action_requests", item.id),
          ),
        ).status,
      ).toBe("pending");
    });

    it("refuses a day the autopilot already planned and names the next free slot", async () => {
      const { thread } = await readyPackage();
      const slots = (
        await run((tx) => channelSlots(tx, project.owner, { channels: [X] }))
      ).channels[0]!.slots.filter((slot) => slot.free);
      const taken = slots[slots.length - 1]!;
      await run((tx) =>
        create(tx, project.owner, "missions", {
          title: "Autopilot X slot",
          status: "ready",
          autopilot: true,
          autopilotSlot: `${X}|${taken.date}`,
          channels: [X],
          plannedSlotAt: taken.at,
        }),
      );
      const refused = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
        date: taken.date,
      });
      expect(refused).toMatchObject({
        status: "slot_taken",
        reasons: expect.arrayContaining(["DAILY_QUOTA"]),
        nextFree: expect.any(String),
      });
      expect(refused.actionRequestId).toBeUndefined();
    });

    it("refuses the decision when the slot was taken after the proposal", async () => {
      const { thread } = await readyPackage();
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: (
          await run((tx) => channelSlots(tx, project.owner, { channels: [X] }))
        ).timezone,
      }).format(new Date(proposed.scheduledAt!));
      await run((tx) =>
        create(tx, project.owner, "missions", {
          title: "Autopilot X slot",
          status: "ready",
          autopilot: true,
          autopilotSlot: `${X}|${date}`,
          channels: [X],
          plannedSlotAt: proposed.scheduledAt,
        }),
      );
      await expect(
        decide(project.owner, await inboxItem(proposed.actionRequestId!)),
      ).rejects.toThrow("SCHEDULE_SLOT_TAKEN");
    });

    it("allows one open proposal per post and none for viewers", async () => {
      const { thread } = await readyPackage();
      await proposeSchedule(project.editor, thread.id, { deliverableKey: X });
      await expect(
        proposeSchedule(project.editor, thread.id, { deliverableKey: X }),
      ).rejects.toThrow("SCHEDULE_ALREADY_PROPOSED");
      await expect(
        proposeSchedule(project.viewer, thread.id, { deliverableKey: X }),
      ).rejects.toThrow("EDITOR_REQUIRED");
    });

    it("makes the decision stale when the draft changed after the proposal", async () => {
      const { thread, pkg } = await readyPackage();
      const proposed = await proposeSchedule(project.editor, thread.id, {
        deliverableKey: X,
      });
      const contentId = (await snapshot(pkg.id)).deliverables[0]!.content!
        .id as string;
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "content", contentId);
        await update(tx, project.owner, row, {
          ...data(row),
          body: "Edited after the proposal.",
        });
      });
      await expect(
        decide(project.owner, await inboxItem(proposed.actionRequestId!)),
      ).rejects.toThrow("SCHEDULE_STALE");
      expect(await publicationsOf(contentId)).toHaveLength(0);
    });

    it("records the owner's package approval in assisted mode", async () => {
      await setPolicy({ mode: "assisted" });
      try {
        const { thread, pkg } = await readyPackage();
        const proposed = await proposeSchedule(project.editor, thread.id, {
          deliverableKey: X,
        });
        await decide(project.owner, await inboxItem(proposed.actionRequestId!));
        const contentId = (await snapshot(pkg.id)).deliverables[0]!.content!
          .id as string;
        const approvals = await run(async (tx) =>
          (await list(tx, project.owner, "approvals")).filter(
            (row) => data(row).contentId === contentId,
          ),
        );
        expect(approvals).toHaveLength(1);
        expect(data(approvals[0])).toMatchObject({
          status: "approved",
          userId: project.owner.userId,
        });
        expect(await publicationsOf(contentId)).toHaveLength(1);
      } finally {
        await setPolicy({ mode: "autopilot" });
      }
    });
  },
);

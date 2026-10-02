import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { configureAutopilot, planAutopilot } from "../src/modules/autopilot.ts";
import { requestContentPackage } from "../src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../src/modules/agents/package-schedule.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)(
  "Weekly autopilot next to scheduled package posts (J3.2, JC15)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let packageSlot: string;
    let slotKey: string;
    let publicationId: string;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const worker = () => ({
      ...project.owner,
      userId: "worker",
      role: "owner" as const,
    });
    const autopilotMissions = () =>
      run(async (tx) =>
        (await list(tx, project.owner, "missions")).filter(
          (m) => data(m).autopilot === true,
        ),
      );
    const skipAudits = () =>
      run((tx) =>
        tx.auditEvent.count({
          where: {
            projectId: project.owner.projectId,
            action: "autopilot.slot_skipped",
          },
        }),
      );
    // planAutopilot checks at most every ten minutes; tests check again at once.
    const planNow = () =>
      run(async (tx) => {
        const row = (await list(tx, project.owner, "autopilot_settings"))[0]!;
        await update(tx, project.owner, row, {
          ...data(row),
          lastPlanCheckAt: null,
        });
        return planAutopilot(tx, project.owner);
      });

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
      const { editor, owner } = project;
      // An owner-approved package post on the next free X slot.
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
        const mission = (await list(tx, owner, "missions")).find(
          (m) => data(m).packageId === pkg.id,
        )!;
        const job = (await list(tx, owner, "jobs")).find(
          (row) => data(row).resourceId === mission.id,
        )!;
        await deterministicDraft(tx, owner, mission.id, job.id);
      });
      await run((tx) => sweepProject(tx, worker()));
      const proposed = await proposeSchedule(editor, thread.id, {
        deliverableKey: X,
      });
      packageSlot = proposed.scheduledAt!;
      const item = (await run((tx) => listActionRequests(tx, owner))).find(
        (candidate) => candidate.id === proposed.actionRequestId,
      )!;
      await run((tx) =>
        decideActionRequest(tx, owner, item.id, {
          version: item.version,
          packageHash: item.packageHash,
          decision: "approve",
        }),
      );
      publicationId = (await run((tx) => list(tx, owner, "publications")))[0]!
        .id;
      slotKey = `${X}|${new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
      }).format(new Date(packageSlot))}`;
      // Weekly autopilot for X, planning this and next week now.
      await run(async (tx) => {
        await tx.project.update({
          where: { id: owner.projectId },
          data: { mode: "autopilot" },
        });
        await configureAutopilot(tx, owner, {
          enabled: true,
          channels: [X],
          factKeys: ["beta.access"],
          assetIds: [],
          planWeekday: new Date().getDay(),
          planTime: "00:00",
        });
      });
    });
    afterAll(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
      await closeDatabase();
    });

    it("plans no paid autopilot draft for a day with a scheduled package post and records why, once", async () => {
      const first = await planNow();
      expect(first.planned).toBeGreaterThan(0);
      expect(first.skipped).toEqual([
        {
          slot: slotKey,
          reason: "PUBLICATION_SCHEDULED",
          publicationIds: [publicationId],
        },
      ]);
      const slots = (await autopilotMissions()).map(
        (m) => data(m).autopilotSlot,
      );
      expect(slots).not.toContain(slotKey);
      // Every other planned day keeps the usual one post per channel and day.
      expect(new Set(slots).size).toBe(slots.length);
      expect(slots.length).toBe(first.planned);
      expect(await skipAudits()).toBe(1);
      // Checking again neither plans the day nor records the skip twice.
      const second = await planNow();
      expect(second.planned).toBe(0);
      expect(await skipAudits()).toBe(1);
    });

    it("plans the day again once the package post is canceled", async () => {
      await run(async (tx) => {
        const publication = await entity(
          tx,
          project.owner,
          "publications",
          publicationId,
        );
        await update(tx, project.owner, publication, {
          ...data(publication),
          status: "canceled",
        });
      });
      expect((await planNow()).planned).toBe(1);
      expect(
        (await autopilotMissions()).map((m) => data(m).autopilotSlot),
      ).toContain(slotKey);
    });

    it("also keeps the spacing when the policy allows two posts a day", async () => {
      // Free one planned day again and put a post on its slot time.
      const freed = (await autopilotMissions()).find(
        (m) => data(m).autopilotSlot !== slotKey,
      )!;
      const freedSlot = data(freed).autopilotSlot as string;
      await run(async (tx) => {
        await update(tx, project.owner, freed, {
          ...data(freed),
          status: "archived",
          autopilotSlot: `${freedSlot}|released`,
        });
        const policy = (await list(tx, project.owner, "policies")).find(
          (row) => data(row).active === true,
        )!;
        await update(tx, project.owner, policy, {
          ...data(policy),
          maxPerDay: 2,
          minIntervalMinutes: 120,
        });
        await create(tx, project.owner, "publications", {
          contentId: "00000000-0000-4000-8000-000000000020",
          channel: X,
          status: "intent_created",
          scheduledAt: new Date(
            Date.parse(data(freed).plannedSlotAt) + 30 * 60000,
          ).toISOString(),
        });
      });
      const result = await planNow();
      expect(result.planned).toBe(0);
      expect(result.skipped).toEqual([
        expect.objectContaining({
          slot: freedSlot,
          reason: "PUBLICATION_SCHEDULED",
        }),
      ]);
    });
  },
);

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity, list, update } from "../../api/src/shared.ts";
import { createConversation } from "../../api/src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../../api/src/modules/action-requests.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../../api/src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../../api/src/modules/agents/package-schedule.ts";
import {
  createPackageProject,
  X,
} from "../../api/tests/support/package-project.ts";
import { workerProcess } from "./support/worker-process.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);
describe.skipIf(!enabled)(
  "Owner-approved package post through the real worker (J3.1)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const worker = workerProcess("orbit-schedule");
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const snapshotOf = (packageId: string) =>
      run(async (tx) =>
        packageSnapshot(
          tx,
          project.owner,
          await entity(tx, project.owner, "content_packages", packageId),
        ),
      );

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
    });
    afterAll(async () => {
      await worker.cleanup();
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project?.cleanup();
      await closeDatabase();
    });

    it("drafts, waits for the owner and ends as published_test at its slot", async () => {
      const { editor, owner } = project;
      const thread = await createConversation(editor);
      const { package: pkg, actionRequest } = await requestContentPackage(
        editor,
        thread.id,
        {
          goal: "Announce that beta access is open for product teams",
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
      worker.start(owner.workspaceId);
      await worker.waitFor(async () => {
        const snapshot = await snapshotOf(pkg.id);
        return snapshot.status === "completed" &&
          snapshot.deliverables.every((d) => d.review)
          ? snapshot
          : false;
      });

      const proposed = await proposeSchedule(editor, thread.id, {
        deliverableKey: X,
      });
      expect(proposed.status).toBe("proposed");
      // Without the owner's decision the running worker publishes nothing.
      await new Promise((r) => setTimeout(r, 1500));
      const contentId = (await snapshotOf(pkg.id)).deliverables[0]!.content!
        .id as string;
      const publicationsOf = () =>
        run(async (tx) =>
          (await list(tx, owner, "publications")).filter(
            (row) => data(row).contentId === contentId,
          ),
        );
      expect(await publicationsOf()).toHaveLength(0);

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
      // The slot arrives: move the publication and its job into the past.
      const [publication] = await publicationsOf();
      await run(async (tx) => {
        const past = new Date(Date.now() - 1000);
        await update(tx, owner, publication!, {
          ...data(publication),
          scheduledAt: past.toISOString(),
        });
        const job = (await list(tx, owner, "jobs")).find(
          (row) =>
            data(row).topic === "publishing" &&
            data(row).resourceId === publication!.id,
        )!;
        await update(tx, owner, job, {
          ...data(job),
          availableAt: past.toISOString(),
        });
        await tx.outbox.updateMany({
          where: { entityId: job.id },
          data: { availableAt: past },
        });
      });
      const published = await worker.waitFor(async () => {
        const schedule = (await snapshotOf(pkg.id)).deliverables[0]!.schedule;
        return schedule?.status === "published_test" ? schedule : false;
      });
      expect(published.publicationId).toBeTruthy();
      expect(await publicationsOf()).toHaveLength(1);
    }, 90000);
  },
);

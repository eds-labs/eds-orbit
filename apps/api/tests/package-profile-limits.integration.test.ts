import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { requestContentPackage } from "../src/modules/agents/content-packages.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * A marketing profile allows a longer audience (2,000 characters) than a
 * mission (300). Production uLiquid has 408 characters; a package must still
 * be prepared, with the audience shortened like the weekly autopilot does.
 */
describe.skipIf(!enabled)(
  "Content package with a long profile audience",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const audience = `${"Crypto traders who want control over their own accounts. ".repeat(7)}End.`;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
      await run(async (tx) => {
        const profile = await tx.projectMarketingProfile.findFirstOrThrow({
          where: { projectId: project.owner.projectId },
        });
        await tx.projectMarketingProfile.update({
          where: { id: profile.id },
          data: { data: { ...(profile.data as object), audience } },
        });
      });
    });
    afterAll(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
      await closeDatabase();
    });

    it("prepares the package and shortens the audience to the mission limit", async () => {
      expect(audience.length).toBeGreaterThan(300);
      const thread = await createConversation(project.owner);
      const { actionRequest } = await requestContentPackage(
        project.owner,
        thread.id,
        {
          goal: "Announce that beta access is open",
          channels: [X],
          factKeys: ["beta.access"],
        },
      );
      const plan = data(
        await run((tx) =>
          entity(tx, project.owner, "action_requests", actionRequest.id),
        ),
      ).payload;
      expect(plan.deliverables[0].mission.audience).toBe(
        audience.slice(0, 300),
      );
    });
  },
);

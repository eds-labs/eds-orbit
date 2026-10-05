import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { setFact } from "../../../packages/knowledge/src/index.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
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

    it("drafts with only the package's facts when the project has many public facts", async () => {
      // Production uLiquid has 21 public facts; all of them exceed the fact
      // context limit, so a package must retrieve only the facts it states.
      await run(async (tx) => {
        for (let index = 0; index < 30; index++)
          await setFact(tx, project.owner, {
            // Key words that also appear in the goal make every one of them match.
            key: `beta.note_${index}`,
            value: `Beta access is open for product teams, announcement ${index}. ${"Announce that beta access is open. ".repeat(12)}`,
            valueType: "text",
            language: "en",
            sourceId: project.sourceId,
            validFrom: new Date(Date.now() - 3600000).toISOString(),
            status: "verified",
            publicUse: true,
            modelUse: true,
          });
      });
      const thread = await createConversation(project.owner);
      const { package: pkg, actionRequest } = await requestContentPackage(
        project.owner,
        thread.id,
        {
          goal: "Announce that beta access is open",
          channels: [X],
          factKeys: ["beta.access"],
        },
      );
      await run((tx) =>
        decideActionRequest(tx, project.owner, actionRequest.id, {
          version: actionRequest.version,
          packageHash: data(actionRequest).packageHash,
          decision: "approve",
        }),
      );
      const drafts = await run(async (tx) => {
        const step = (
          data(await entity(tx, project.owner, "content_packages", pkg.id))
            .steps as Array<Record<string, any>>
        )[0]!;
        return deterministicDraft(
          tx,
          project.owner,
          step.missionId,
          step.jobId,
        );
      });
      expect(drafts).toHaveLength(1);
      const evidence = await run((tx) =>
        entity(tx, project.owner, "evidence", data(drafts[0]!).evidenceId),
      );
      expect(data(evidence).gaps).not.toContain("fact_context_limit");
      expect(
        (data(evidence).facts as Array<{ id: string }>).map((f) => f.id),
      ).toEqual([project.betaFactId]);
    });
  },
);

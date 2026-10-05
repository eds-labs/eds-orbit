import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { requestContentPackage } from "../src/modules/agents/content-packages.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * An import that ran twice leaves two verified copies of the same fact with an
 * identical value (seen in production uLiquid on 2026-09-18). That is not a
 * contradiction: the package uses the newer copy. Copies with different values
 * still block.
 */
describe.skipIf(!enabled)(
  "Content package with duplicated Verified Facts",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    // A second copy of the beta fact under another key, as a repeated import writes it.
    const copyBetaFact = (
      key: string,
      changes: Record<string, unknown> = {},
    ) => {
      // Separate transactions, as two import runs: the second copy is newer.
      const copy = (extra: Record<string, unknown>) =>
        run(async (tx) => {
          const original = await entity(
            tx,
            project.owner,
            "facts",
            project.betaFactId,
          );
          return create(tx, project.owner, "facts", {
            ...data(original),
            key,
            ...extra,
          });
        });
      return copy({}).then(async (first) => ({
        first,
        second: await copy(changes),
      }));
    };
    const ask = async (factKey: string) => {
      const thread = await createConversation(project.owner);
      return requestContentPackage(project.owner, thread.id, {
        goal: "Announce that beta access is open",
        channels: [X],
        factKeys: [factKey],
      });
    };

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
    });
    afterAll(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
      await closeDatabase();
    });

    it("uses the newer of two copies with the same value", async () => {
      const { second } = await copyBetaFact("beta.access_copy");
      const { actionRequest } = await ask("beta.access_copy");
      const plan = data(
        await run((tx) =>
          entity(tx, project.owner, "action_requests", actionRequest.id),
        ),
      ).payload;
      expect(plan.facts).toEqual([
        { id: second.id, version: second.version, key: "beta.access_copy" },
      ]);
    });

    it("still blocks copies whose values differ", async () => {
      await copyBetaFact("beta.access_changed", {
        value: "closed for new teams",
      });
      await expect(ask("beta.access_changed")).rejects.toThrow("FACT_CONFLICT");
    });
  },
);

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../../api/src/shared.ts";
import { enqueue } from "../../api/src/platform/jobs/enqueue.ts";
import { setModuleEnabled } from "../../api/src/platform/modules/activation.ts";
import { moduleRegistry } from "../../api/src/modules/registry.ts";
import { workerProcess } from "./support/worker-process.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);

/**
 * A disabled module's jobs stop like paused ones (WP2.4): blocked_dependency
 * with MODULE_DISABLED, never claimed; platform jobs keep running.
 */
describe.skipIf(!enabled)("Worker with a disabled module", () => {
  const worker = workerProcess("orbit-module-disabled");
  let scope: Scope;
  const users: string[] = [];
  const jobs: Record<string, string> = {};

  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic disabled module owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic disabled module",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic disabled module" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await setModuleEnabled(tx, scope, moduleRegistry(), "marketing", false);
      for (const topic of ["generation", "ingestion"])
        jobs[topic] = (
          await enqueue(
            tx,
            scope,
            topic,
            randomUUID(),
            `module-disabled:${topic}:${randomUUID()}`,
          )
        ).id;
    });
    process.env.ORBIT_MODULES = "true";
    worker.start(scope.workspaceId);
    delete process.env.ORBIT_MODULES;
  }, 60000);

  afterAll(async () => {
    await worker.cleanup();
    if (scope)
      await authDb.workspace.deleteMany({ where: { id: scope.workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("stops the marketing job unclaimed and runs the platform job", async () => {
    const outcome = await worker.waitFor(async () => {
      const rows = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        Promise.all(
          Object.entries(jobs).map(async ([topic, id]) => {
            const d = data(await entity(tx, scope, "jobs", id));
            return [
              topic,
              { status: d.status, error: d.error, attempts: d.attempts },
            ] as const;
          }),
        ),
      );
      return rows.every(([, row]) => row.status === "blocked_dependency")
        ? Object.fromEntries(rows)
        : false;
    }, 60000);
    expect(outcome).toEqual({
      generation: {
        status: "blocked_dependency",
        error: "MODULE_DISABLED",
        attempts: 0,
      },
      // The platform's ingestion job runs and stops on its missing source.
      ingestion: {
        status: "blocked_dependency",
        error: "NOT_FOUND",
        attempts: 1,
      },
    });
  });
});

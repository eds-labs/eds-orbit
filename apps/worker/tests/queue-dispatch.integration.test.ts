import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../../api/src/shared.ts";
import { enqueue } from "../../api/src/modules/workflow.ts";
import { workerProcess } from "./support/worker-process.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);

/**
 * Queue classes without a dedicated worker test. Each job names a resource
 * that does not exist, so the handler must be wired and look the resource
 * up; the pinned outcome shows which error stops the job and after how many
 * attempts. A missing handler would show JOB_CAPABILITY_NOT_CONFIGURED.
 */
const QUEUES = [
  "ingestion",
  "embedding",
  "reindex",
  "index_evaluation",
  "analytics",
  "reconciliation",
  "slack_notification",
  "email_archive",
] as const;

describe.skipIf(!enabled)(
  "Worker dispatch of every untested queue class",
  () => {
    const worker = workerProcess("orbit-queue-smoke");
    let scope: Scope;
    const users: string[] = [];
    const jobs = new Map<string, string>();

    beforeAll(async () => {
      const user = await authDb.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic queue smoke owner",
          email: `${randomUUID()}@example.invalid`,
        },
      });
      users.push(user.id);
      const workspace = await authDb.workspace.create({
        data: {
          name: "Synthetic queue smoke",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await authDb.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Synthetic queue smoke project",
        },
      });
      scope = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        for (const topic of QUEUES) {
          const job = await enqueue(
            tx,
            scope,
            topic,
            randomUUID(),
            `queue-smoke:${topic}:${randomUUID()}`,
          );
          jobs.set(topic, job.id);
        }
      });
      worker.start(scope.workspaceId);
    }, 60000);

    afterAll(async () => {
      await worker.cleanup();
      if (scope)
        await authDb.workspace.deleteMany({ where: { id: scope.workspaceId } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
      await closeDatabase();
    });

    it("claims each job and stops it for good on the missing resource", async () => {
      const outcomes = await worker.waitFor(async () => {
        const rows = await scoped(scope.workspaceId, scope.projectId, (tx) =>
          Promise.all(
            QUEUES.map(async (topic) => {
              const d = data(await entity(tx, scope, "jobs", jobs.get(topic)!));
              return { status: d.status, error: d.error, attempts: d.attempts };
            }),
          ),
        );
        return rows.every((row) => row.status === "blocked_dependency")
          ? Object.fromEntries(QUEUES.map((topic, i) => [topic, rows[i]]))
          : false;
      }, 60000);
      expect(outcomes).toEqual({
        ingestion: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
        embedding: {
          status: "blocked_dependency",
          error: "DOCUMENT_NOT_FOUND",
          attempts: 1,
        },
        // Current behaviour, pinned: a missing index generation is not recognised
        // as permanent, so the job spends all three attempts before it stops.
        reindex: {
          status: "blocked_dependency",
          error: "INDEX_UNAVAILABLE",
          attempts: 3,
        },
        index_evaluation: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
        analytics: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
        reconciliation: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
        slack_notification: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
        email_archive: {
          status: "blocked_dependency",
          error: "NOT_FOUND",
          attempts: 1,
        },
      });
    }, 90000);
  },
);

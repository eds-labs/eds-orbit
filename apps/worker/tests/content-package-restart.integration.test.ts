import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity, update } from "../../api/src/shared.ts";
import {
  createConversation,
  getConversation,
} from "../../api/src/modules/chat.ts";
import { decideActionRequest } from "../../api/src/modules/action-requests.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../../api/src/modules/agents/content-packages.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "../../api/tests/support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);
describe.skipIf(!enabled)(
  "Content package across a worker crash and restart (JC06)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let worker: ChildProcess | undefined;
    let diagnostic = "";
    const queueNamespace = "orbit-package-" + randomUUID().slice(0, 8);
    const healthDir = join(tmpdir(), queueNamespace);
    const healthFile = join(healthDir, "worker.json");
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    function start() {
      worker = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/src/main.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
            QUEUE_NAMESPACE: queueNamespace,
            PUBLISHER_INSTANCE_ID: queueNamespace,
            WORKER_HEALTH_FILE: healthFile,
            WORKER_WORKSPACE_ALLOWLIST: project.owner.workspaceId,
            EXECUTION_MODE: "test",
            ENABLE_EXTERNAL_WRITES: "false",
            LIVE_RAG_EVAL_PASSED: "false",
            OPENAI_API_KEY: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worker.stderr!.on("data", (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-3000);
      });
    }
    async function stop(crash = false) {
      if (!worker || worker.exitCode !== null) return;
      const p = worker;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          p.kill("SIGKILL");
          done();
        }, 3000);
        p.once("exit", () => {
          clearTimeout(timer);
          done();
        });
        p.kill(crash ? "SIGKILL" : "SIGTERM");
      });
      worker = undefined;
    }
    async function waitFor<T>(
      check: () => Promise<T | false>,
      timeout = 30000,
    ) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const result = await check();
        if (result) return result;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Worker package timeout " + diagnostic);
    }
    const snapshotOf = (packageId: string) =>
      run(async (tx) =>
        packageSnapshot(
          tx,
          project.owner,
          await entity(tx, project.owner, "content_packages", packageId),
        ),
      );
    // Everything the package caused: missions, their jobs and drafts, and paid reservations.
    const footprint = (packageId: string) =>
      run(async (tx) => {
        const missions = await tx.entity.findMany({
          where: {
            kind: "missions",
            data: { path: ["packageId"], equals: packageId },
          },
        });
        const ids = missions.map((m) => m.id);
        const jobs = (await tx.entity.findMany({ where: { kind: "jobs" } }))
          .filter((job) => ids.includes(data(job).resourceId))
          .map((job) => ({
            id: job.id,
            status: data(job).status,
            attempts: data(job).attempts,
          }));
        const drafts = (
          await tx.entity.findMany({ where: { kind: "content" } })
        )
          .filter((row) => ids.includes(data(row).missionId))
          .map((row) => ({ id: row.id, version: row.version }));
        return {
          missions: ids.length,
          jobs: jobs.sort((a, b) => a.id.localeCompare(b.id)),
          drafts: drafts.sort((a, b) => a.id.localeCompare(b.id)),
          reservations: await tx.budgetReservation.count(),
          outboxPending: await tx.outbox.count({
            where: { dispatchedAt: null },
          }),
        };
      });

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
    });
    afterAll(async () => {
      await stop();
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project?.cleanup();
      await closeDatabase();
      await rm(healthDir, { recursive: true, force: true });
    });

    it("finishes once after a crash in a draft job and changes nothing after a restart", async () => {
      const { editor } = project;
      const thread = await createConversation(editor);
      const { package: pkg, actionRequest } = await requestContentPackage(
        editor,
        thread.id,
        {
          goal: "Announce that beta access is open for product teams",
          channels: [X, TELEGRAM],
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
      const steps = data(
        await run((tx) =>
          entity(tx, project.owner, "content_packages", pkg.id),
        ),
      ).steps as Array<{ key: string; jobId: string }>;
      const telegramJob = steps.find((step) => step.key === TELEGRAM)!.jobId;
      // A worker died while running the Telegram draft: lease expired, outbox row already dispatched.
      await run(async (tx) => {
        const job = await entity(tx, project.owner, "jobs", telegramJob);
        await update(tx, project.owner, job, {
          ...data(job),
          status: "running",
          attempts: 1,
          leaseUntil: new Date(Date.now() - 60000).toISOString(),
          worker: "crashed-worker",
        });
        await tx.outbox.updateMany({
          where: { entityId: telegramJob },
          data: { dispatchedAt: new Date() },
        });
      });

      start();
      const done = await waitFor(async () => {
        const snapshot = await snapshotOf(pkg.id);
        return snapshot.status === "completed" &&
          snapshot.deliverables.every((d) => d.review)
          ? snapshot
          : false;
      });
      expect(done.deliverables.map((d) => d.channelId).sort()).toEqual(
        [X, TELEGRAM].sort(),
      );
      const settled = await footprint(pkg.id);
      expect(settled.missions).toBe(2);
      expect(settled.drafts).toHaveLength(2);
      expect(settled.jobs).toHaveLength(2);
      expect(settled.jobs.every((job) => job.status === "succeeded")).toBe(
        true,
      );
      expect(settled.jobs.find((job) => job.id === telegramJob)?.attempts).toBe(
        2,
      );
      // Test execution drafts deterministically: no paid call at all.
      expect(settled.reservations).toBe(0);

      // Crash the worker and start it again: nothing is drafted, queued or charged twice.
      await stop(true);
      const restartedAt = Date.now();
      start();
      await waitFor(async () => {
        try {
          return statSync(healthFile).mtimeMs > restartedAt + 3000;
        } catch {
          return false;
        }
      });
      expect(await footprint(pkg.id)).toEqual(settled);

      // Reopening the conversation rebuilds the same result from PostgreSQL.
      const reopened = (await getConversation(editor, thread.id)).packages;
      expect(reopened).toHaveLength(1);
      expect(reopened[0]).toMatchObject({ id: pkg.id, status: "completed" });
      expect(
        reopened[0]!.deliverables.map((d: any) => d.content?.id).sort(),
      ).toEqual(settled.drafts.map((d) => d.id).sort());
    }, 90000);
  },
);

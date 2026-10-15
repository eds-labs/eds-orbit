import { registerModules } from "../../api/src/modules/registry.ts";
import {
  ownerEnabled,
  registeredJobOwner,
  registeredJobs,
  registeredPeriodicTasks,
  workerStartHooks,
} from "../../api/src/platform/modules/contributions.ts";
import { enabledModules } from "../../api/src/platform/modules/enforcement.ts";
import Redis from "ioredis";
import {
  sweepProject,
  nextSweepAt,
} from "../../api/src/platform/jobs/scheduler.ts";
import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  earliestDue,
  eachLimited,
  safeErrorCode,
  workspaceAllowlist,
} from "./schedule.ts";
import {
  claimProject,
  deferAfterFailure,
  releaseProject,
} from "./due-marker.ts";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import {
  authDb,
  scoped,
  closeDatabase,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  entity,
  data,
  update,
  exception,
  create,
} from "../../api/src/shared.ts";
// A broken module manifest stops the worker before it takes a job.
registerModules();
// Module start-up, such as the specialists of the `agent` queue.
for (const start of workerStartHooks()) start();
const config = loadConfig(),
  url = new URL(config.REDIS_URL);
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(30000, 1000 * 2 ** Math.min(times, 5)),
});
let lastConnectionError = 0;
function reportConnectionError() {
  if (Date.now() - lastConnectionError > 30000) {
    console.error("Worker connection unavailable; retry backoff active");
    lastConnectionError = Date.now();
  }
}
connection.on("error", reportConnectionError);
await connection.connect();
// Queue classes as registered by the platform and the modules (WP1.6).
const jobDefs = registeredJobs();
const classes = [...jobDefs.keys()];
const queues = new Map(
  classes.map((c) => [
    c,
    new Queue(config.QUEUE_NAMESPACE + "-" + c, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 300,
      },
    }),
  ]),
);
const healthFile =
  process.env.WORKER_HEALTH_FILE ?? "/tmp/orbit-worker-health.json";
const workspaces = workspaceAllowlist(
  process.env.WORKER_WORKSPACE_ALLOWLIST,
  config.EXECUTION_MODE,
);
let stopping = false;
const projectFailures = new Map<string, number>();
const PUMP_INTERVAL_MS = 1500,
  PUMP_BATCH = 100,
  PUMP_CONCURRENCY = 4,
  OUTBOX_BATCH = 40,
  // Safety net for transitions no trigger or hint covers; every project is revisited at least this often.
  MAX_IDLE_MS = 300_000,
  FAILURE_RETRY_MS = 5_000,
  // A pass holds the marker this long; a crashed pass is retried after it.
  PROCESSING_LEASE_MS = 60_000,
  LEASE_GRACE_MS = 1_000;
const workers = classes.map(
  (topic) =>
    new Worker(
      config.QUEUE_NAMESPACE + "-" + topic,
      async (queued) => {
        const def = jobDefs.get(topic)!;
        const { projectId, workspaceId, jobId } = queued.data;
        const scope: Scope = {
          projectId,
          workspaceId,
          userId: "worker",
          role: "owner",
        };
        const claimed = await scoped(workspaceId, projectId, async (tx) => {
          const job = await entity(tx, scope, "jobs", jobId);
          const d = data(job);
          if (
            ["succeeded", "canceled", "blocked_dependency", "failed"].includes(
              d.status,
            )
          )
            return null;
          if (
            d.status === "running" &&
            d.leaseUntil &&
            new Date(d.leaseUntil) > new Date()
          )
            return null;
          if (d.attempts >= d.maxAttempts) return null;
          const project = await tx.project.findUniqueOrThrow({
            where: { id: projectId },
          });
          if (project.paused && !def.runWhilePaused) {
            await update(tx, scope, job, {
              ...d,
              status: "blocked_dependency",
              error: "PROJECT_PAUSED",
            });
            await def.onBlockedByPause?.(tx, d);
            return null;
          }
          // A disabled module's jobs stop like paused ones (WP2.4); the
          // existing retry action restarts them once the module is on.
          if (
            !ownerEnabled(
              registeredJobOwner(topic),
              await enabledModules(tx, scope),
            )
          ) {
            await update(tx, scope, job, {
              ...d,
              status: "blocked_dependency",
              error: "MODULE_DISABLED",
            });
            return null;
          }
          return update(tx, scope, job, {
            ...d,
            status: "running",
            attempts: d.attempts + 1,
            // The lease outlasts the class's longest run (JobDef.leaseMs).
            leaseUntil: new Date(
              Date.now() + (def.leaseMs ?? 120000),
            ).toISOString(),
            worker: config.PUBLISHER_INSTANCE_ID,
          });
        });
        if (!claimed) return;
        try {
          // A handler may report its own terminal status (chat).
          const chatResult =
            (await def.handler({
              scope,
              jobId,
              job: data(claimed),
              executionMode: config.EXECUTION_MODE,
            })) ?? null;
          await scoped(workspaceId, projectId, async (tx) => {
            const job = await entity(tx, scope, "jobs", jobId);
            await update(tx, scope, job, {
              ...data(job),
              status:
                chatResult?.status === "canceled"
                  ? "canceled"
                  : chatResult && chatResult.status !== "succeeded"
                    ? "blocked_dependency"
                    : "succeeded",
              ...(chatResult?.errorCode ? { error: chatResult.errorCode } : {}),
              leaseUntil: null,
              completedAt: new Date().toISOString(),
            });
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "JOB_FAILED";
          let retryable = false;
          await scoped(workspaceId, projectId, async (tx) => {
            const job = await entity(tx, scope, "jobs", jobId);
            retryable =
              !/BUDGET|NOT_|REQUIRED|EXPIRED|EVIDENCE|CAPABILITY|POLICY|PAUSED|UNKNOWN/.test(
                code,
              ) && data(job).attempts < data(job).maxAttempts;
            await update(tx, scope, job, {
              ...data(job),
              status: retryable ? "retry_scheduled" : "blocked_dependency",
              leaseUntil: null,
              error: code.slice(0, 160),
            });
            await exception(tx, scope, code.slice(0, 100), jobId);
          });
          if (!retryable) throw new UnrecoverableError("ORBIT_JOB_BLOCKED");
          throw new Error("ORBIT_JOB_FAILED");
        }
      },
      {
        connection,
        concurrency: jobDefs.get(topic)!.concurrency ?? 1,
        lockDuration: 120000,
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
    ),
);
workers.forEach((w) => w.on("error", reportConnectionError));
type DueProject = { id: string; workspaceId: string };
async function processProject(p: DueProject, claimed: Date) {
  const scope: Scope = {
    workspaceId: p.workspaceId,
    projectId: p.id,
    userId: "worker",
    role: "owner",
  };
  const at = new Date();
  const { events, candidates, periodicTasks } = await scoped(
    p.workspaceId,
    p.id,
    async (tx) => {
      // Periodic tasks of enabled modules only (WP2.4).
      const periodicTasks = registeredPeriodicTasks(
        await enabledModules(tx, scope),
      );
      await sweepProject(tx, scope);
      const candidates: (Date | null)[] = [await nextSweepAt(tx, scope)];
      // Periodic tasks are not gated by pause, matching their run below.
      for (const task of periodicTasks)
        if (task.nextDueAt) candidates.push(await task.nextDueAt(tx, scope));
      // Crash recovery preserves the intent and never retries an ambiguous external write.
      const running = await tx.entity.findMany({
        where: {
          workspaceId: p.workspaceId,
          projectId: p.id,
          kind: "jobs",
          data: { path: ["status"], equals: "running" },
        },
      });
      for (const job of running) {
        const d = data(job);
        if (d.status !== "running" || !d.leaseUntil) continue;
        const lease = new Date(d.leaseUntil);
        if (!(lease < new Date())) {
          candidates.push(new Date(lease.valueOf() + LEASE_GRACE_MS));
          continue;
        }
        // Crash recovery per queue class: an ambiguous external write is never repeated.
        await jobDefs.get(d.topic)?.onLeaseExpired?.(tx, scope, d);
        if (d.liveDraftOnce === true || d.attempts >= d.maxAttempts) {
          await update(tx, scope, job, {
            ...d,
            status: "blocked_dependency",
            leaseUntil: null,
            error: "JOB_OUTCOME_UNKNOWN",
          });
          await exception(tx, scope, "JOB_OUTCOME_UNKNOWN", job.id);
          continue;
        }
        await update(tx, scope, job, {
          ...d,
          status: "retry_scheduled",
          leaseUntil: null,
        });
        await tx.outbox.create({
          data: {
            workspaceId: p.workspaceId,
            projectId: p.id,
            topic: d.topic,
            entityId: job.id,
            payload: { jobId: job.id },
          },
        });
      }
      // Events of a topic without a queue here wait in the outbox and never fill a batch.
      const events = await tx.outbox.findMany({
        where: {
          workspaceId: p.workspaceId,
          projectId: p.id,
          topic: { in: [...classes] },
          dispatchedAt: null,
          availableAt: { lte: new Date() },
        },
        take: OUTBOX_BATCH,
        orderBy: { availableAt: "asc" },
      });
      const upcoming = await tx.outbox.findFirst({
        where: {
          workspaceId: p.workspaceId,
          projectId: p.id,
          topic: { in: [...classes] },
          dispatchedAt: null,
          availableAt: { gt: new Date() },
        },
        orderBy: { availableAt: "asc" },
        select: { availableAt: true },
      });
      candidates.push(upcoming?.availableAt ?? null);
      return { events, candidates, periodicTasks };
    },
  );
  let redispatch = events.length === OUTBOX_BATCH;
  for (const e of events) {
    const queue = queues.get(e.topic);
    if (!queue) continue;
    if ((await queue.getWaitingCount()) > 200) {
      redispatch = true;
      continue;
    }
    await queue.add(
      e.topic,
      { workspaceId: p.workspaceId, projectId: p.id, jobId: e.entityId },
      { jobId: e.id },
    );
    await scoped(p.workspaceId, p.id, (tx) =>
      tx.outbox.update({
        where: { id: e.id },
        data: { dispatchedAt: new Date() },
      }),
    );
  }
  // Module tasks after dispatch, such as saved Matomo imports and the
  // read-only Postiz queue check; a published status feeds /api/health.
  for (const task of periodicTasks) {
    const result = await task.run(scope).catch(() => undefined);
    if (result?.wakeAt) candidates.push(result.wakeAt);
    if (!task.health || !result?.status) continue;
    const key = `orbit:${task.name}:` + config.PUBLISHER_INSTANCE_ID;
    await connection
      .multi()
      .hset(
        key,
        p.id,
        JSON.stringify({
          status: result.status,
          checkedAt: new Date().toISOString(),
        }),
      )
      .expire(key, 3600)
      .exec()
      .catch(() => {});
  }
  const next = redispatch
    ? new Date()
    : earliestDue(at, MAX_IDLE_MS, candidates);
  // A write since the claim, including this pass's own, keeps the project due.
  await releaseProject(authDb, p.id, claimed, next);
}
async function reportProjectFailure(
  p: DueProject,
  error: unknown,
  claimed: Date | null,
) {
  await deferAfterFailure(
    authDb,
    p.id,
    new Date(Date.now() + FAILURE_RETRY_MS),
    claimed,
  ).catch(() => {});
  if (Date.now() - (projectFailures.get(p.id) ?? 0) <= 30000) return;
  projectFailures.set(p.id, Date.now());
  const code =
    error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
      ? error.message
      : "PROJECT_QUEUE_UNAVAILABLE";
  console.error(
    "Orbit project queue blocked: " + code + "; other projects continue",
  );
  await scoped(p.workspaceId, p.id, (tx) =>
    exception(
      tx,
      {
        workspaceId: p.workspaceId,
        projectId: p.id,
        userId: "worker",
        role: "owner",
      },
      code,
      p.id,
    ),
  ).catch(() => {});
}
async function pump() {
  if (stopping) return;
  let delay = PUMP_INTERVAL_MS;
  try {
    // Only projects whose marker is due are touched; idle projects cost nothing per tick.
    const due = await authDb.project.findMany({
      where: {
        workDueAt: { lte: new Date() },
        ...(workspaces ? { workspaceId: { in: workspaces } } : {}),
      },
      orderBy: { workDueAt: "asc" },
      take: PUMP_BATCH,
      select: { id: true, workspaceId: true },
    });
    await eachLimited(due, PUMP_CONCURRENCY, async (p) => {
      if (stopping) return;
      let claimed: Date | null = null;
      try {
        claimed = await claimProject(
          authDb,
          p.id,
          new Date(Date.now() + PROCESSING_LEASE_MS),
        );
        // Another worker or a later marker took it since the selection.
        if (!claimed) return;
        await processProject(p, claimed);
      } catch (error) {
        await reportProjectFailure(p, error, claimed);
      }
    });
    if (due.length === PUMP_BATCH) delay = 50;
    await queues.values().next().value!.getWaitingCount();
    await connection.set(
      "orbit:worker:health:" + config.PUBLISHER_INSTANCE_ID,
      JSON.stringify({ checkedAt: Date.now(), queues: classes }),
      "EX",
      45,
    );
    await mkdir(dirname(healthFile), { recursive: true });
    await writeFile(
      healthFile + ".tmp",
      JSON.stringify({
        checkedAt: Date.now(),
        instanceId: config.PUBLISHER_INSTANCE_ID,
      }),
    );
    await rename(healthFile + ".tmp", healthFile);
  } catch (error) {
    console.error(
      "Orbit queue pump unavailable (" +
        safeErrorCode(error) +
        "); retrying with bounded concurrency",
    );
  } finally {
    if (!stopping) setTimeout(pump, delay);
  }
}
void pump();
console.log(
  "Orbit durable worker started (external writes require separate verified gates)",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    stopping = true;
    setTimeout(() => process.exit(1), 10000).unref();
    await unlink(healthFile).catch(() => {});
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([...queues.values()].map((q) => q.close()));
    await closeDatabase();
    connection.disconnect();
    process.exit(0);
  });

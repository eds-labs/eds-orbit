import {
  runScheduledMatomo,
  nextMatomoRunAt,
} from "../../api/src/modules/matomo-schedule.ts";
import {
  saveGeneratedAsset,
  markSyncFailed,
  connectionStatus,
} from "../../api/src/modules/google-drive.ts";
import { runIndexEvaluation } from "../../api/src/modules/index-evaluation.ts";
import { buildIndexBatch } from "../../api/src/modules/reindex.ts";
import Redis from "ioredis";
import {
  dispatchSlackDigest,
  markSlackOutcomeUnknown,
} from "../../api/src/modules/slack.ts";
import {
  sweepProject,
  nextSweepAt,
  evaluateExperiment,
} from "../../api/src/modules/lifecycle.ts";
import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  earliestDue,
  eachLimited,
  safeErrorCode,
  workspaceAllowlist,
} from "./schedule.ts";
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
  audit,
  create,
} from "../../api/src/shared.ts";
import {
  deterministicDraft,
  claimPublication,
  finishPublication,
  reviewContent,
  publishIntent,
} from "../../api/src/modules/workflow.ts";
import { generateMissionLive } from "../../api/src/modules/generation.ts";
import { runChat } from "../../api/src/modules/chat-runner.ts";
import { getRun } from "../../api/src/modules/chat.ts";
import { syncSource, embedDocument } from "../../api/src/modules/ingestion.ts";
import {
  dispatchPublication,
  reconcilePublication,
} from "../../api/src/modules/publisher.ts";
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
const classes = [
  "publishing",
  "generation",
  "chat",
  "ingestion",
  "embedding",
  "reindex",
  "index_evaluation",
  "analytics",
  "reconciliation",
  "slack_notification",
] as const;
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
const driveRetryChecks = new Map<
  string,
  { at: number; enabled: boolean; nextRetryAt: number | null }
>();
const PUMP_INTERVAL_MS = 1500,
  PUMP_BATCH = 100,
  PUMP_CONCURRENCY = 4,
  OUTBOX_BATCH = 40,
  // Safety net for transitions no trigger or hint covers; every project is revisited at least this often.
  MAX_IDLE_MS = 300_000,
  FAILURE_RETRY_MS = 5_000,
  LEASE_GRACE_MS = 1_000,
  DRIVE_CHECK_MS = 30_000;
const workers = classes.map(
  (topic) =>
    new Worker(
      config.QUEUE_NAMESPACE + "-" + topic,
      async (queued) => {
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
          if (project.paused) {
            await update(tx, scope, job, {
              ...d,
              status: "blocked_dependency",
              error: "PROJECT_PAUSED",
            });
            return null;
          }
          return update(tx, scope, job, {
            ...d,
            status: "running",
            attempts: d.attempts + 1,
            leaseUntil: new Date(Date.now() + 120000).toISOString(),
            worker: config.PUBLISHER_INSTANCE_ID,
          });
        });
        if (!claimed) return;
        try {
          let chatResult: { status: string; errorCode: string | null } | null =
            null;
          if (topic === "chat") {
            const actorScope = { ...scope, userId: data(claimed).actorId };
            await runChat(actorScope, data(claimed).resourceId);
            const finished = await getRun(actorScope, data(claimed).resourceId);
            chatResult = {
              status: finished.status,
              errorCode: finished.errorCode,
            };
          } else if (topic === "generation") {
            const drafts =
              config.EXECUTION_MODE === "live" ||
              data(claimed).liveDraftOnce === true
                ? [
                    await generateMissionLive(
                      scope,
                      data(claimed).resourceId,
                      jobId,
                    ),
                  ]
                : await scoped(workspaceId, projectId, (tx) =>
                    deterministicDraft(
                      tx,
                      scope,
                      data(claimed).resourceId,
                      jobId,
                    ),
                  );
            for (const content of drafts) {
              const reviewed = await scoped(
                workspaceId,
                projectId,
                async (tx) => {
                  const project = await tx.project.findUniqueOrThrow({
                    where: { id: projectId },
                  });
                  if (
                    data(claimed).liveDraftOnce === true ||
                    project.mode !== "autopilot"
                  )
                    return null;
                  const mission = await entity(
                    tx,
                    scope,
                    "missions",
                    data(content).missionId,
                  );
                  if (
                    Array.isArray(data(mission).allowedActions) &&
                    !data(mission).allowedActions.some(
                      (action: string) =>
                        action === "publish_test" || action === "publish_live",
                    )
                  )
                    return null;
                  const current = await entity(
                    tx,
                    scope,
                    "content",
                    content.id,
                  );
                  const result =
                    data(current).status === "draft"
                      ? await reviewContent(
                          tx,
                          scope,
                          current.id,
                          current.version,
                        )
                      : current;
                  if (data(result).status !== "reviewed") {
                    await exception(
                      tx,
                      scope,
                      "CONTENT_REVIEW_REQUIRED",
                      result.id,
                    );
                    return null;
                  }
                  return result;
                },
              );
              if (reviewed)
                await scoped(workspaceId, projectId, (tx) =>
                  publishIntent(tx, scope, {
                    contentId: reviewed.id,
                    version: reviewed.version,
                  }),
                );
            }
          } else if (topic === "ingestion") {
            await syncSource(scope, data(claimed).resourceId);
          } else if (topic === "embedding") {
            await embedDocument(scope, data(claimed).resourceId, jobId);
          } else if (topic === "index_evaluation") {
            await runIndexEvaluation(scope, data(claimed).resourceId, jobId);
          } else if (topic === "reindex") {
            await buildIndexBatch(scope, data(claimed).resourceId, jobId);
          } else if (topic === "publishing") {
            await dispatchPublication(scope, data(claimed).resourceId);
          } else if (topic === "reconciliation") {
            await reconcilePublication(scope, data(claimed).resourceId);
          } else if (topic === "slack_notification") {
            await dispatchSlackDigest(scope, data(claimed).resourceId);
          } else if (topic === "analytics") {
            await scoped(workspaceId, projectId, (tx) =>
              evaluateExperiment(tx, scope, data(claimed).resourceId),
            );
          } else throw new Error("JOB_CAPABILITY_NOT_CONFIGURED");
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
        concurrency: topic === "publishing" ? 2 : 1,
        lockDuration: 120000,
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
    ),
);
workers.forEach((w) => w.on("error", reportConnectionError));
type DueProject = { id: string; workspaceId: string };
async function processProject(p: DueProject) {
  const scope: Scope = {
    workspaceId: p.workspaceId,
    projectId: p.id,
    userId: "worker",
    role: "owner",
  };
  const at = new Date();
  const { events, candidates, seen } = await scoped(
    p.workspaceId,
    p.id,
    async (tx) => {
      await sweepProject(tx, scope);
      const candidates: (Date | null)[] = [
        await nextSweepAt(tx, scope),
        // Not gated by pause, matching runScheduledMatomo.
        await nextMatomoRunAt(tx, scope),
      ];
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
        if (d.topic === "slack_notification")
          await markSlackOutcomeUnknown(tx, scope, d.resourceId);
        if (d.topic === "publishing") {
          const pub = await entity(tx, scope, "publications", d.resourceId);
          if (data(pub).status === "sending") {
            await update(tx, scope, pub, {
              ...data(pub),
              status: "outcome_unknown",
            });
            await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pub.id);
          }
        }
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
      const events = await tx.outbox.findMany({
        where: {
          workspaceId: p.workspaceId,
          projectId: p.id,
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
          dispatchedAt: null,
          availableAt: { gt: new Date() },
        },
        orderBy: { availableAt: "asc" },
        select: { availableAt: true },
      });
      candidates.push(upcoming?.availableAt ?? null);
      // Read after this transaction's own writes moved the marker; later writers change it again.
      const { workDueAt } = await tx.project.findUniqueOrThrow({
        where: { id: p.id },
        select: { workDueAt: true },
      });
      return { events, candidates, seen: workDueAt };
    },
  );
  let redispatch = events.length === OUTBOX_BATCH;
  for (const e of events) {
    const queue = queues.get(e.topic as (typeof classes)[number]);
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
  // Saved Matomo imports run at most twice a day per project.
  await runScheduledMatomo(scope).catch(() => {});
  let drive = driveRetryChecks.get(p.id);
  if (!drive || Date.now() - drive.at > DRIVE_CHECK_MS) {
    // Gate the check itself, not only enabled projects, so disabled Drive costs no transaction per tick.
    drive = {
      at: Date.now(),
      enabled: (await connectionStatus(scope)).enabled,
      nextRetryAt: null,
    };
    driveRetryChecks.set(p.id, drive);
    if (drive.enabled) {
      const failed = await scoped(p.workspaceId, p.id, (tx) =>
        tx.entity.findMany({
          where: {
            projectId: p.id,
            kind: "assets",
            data: { path: ["driveSyncStatus"], equals: "FAILED" },
          },
          take: 30,
          orderBy: { updatedAt: "asc" },
        }),
      );
      const pending = failed.filter(
        (row) =>
          data(row).driveSyncStatus === "FAILED" &&
          Number(data(row).driveRetryAttempts ?? 0) < 5,
      );
      const due = pending.filter(
        (row) => Date.parse(data(row).driveRetryAt ?? "") <= Date.now(),
      );
      for (const asset of due.slice(0, 3)) {
        try {
          await saveGeneratedAsset(scope, asset.id);
        } catch {
          await markSyncFailed(scope, asset.id);
        }
      }
      const retryTimes = pending
        .filter((row) => !due.slice(0, 3).includes(row))
        .map((row) => Date.parse(data(row).driveRetryAt ?? ""))
        .filter(Number.isFinite);
      if (retryTimes.length) drive.nextRetryAt = Math.min(...retryTimes);
    }
  }
  if (drive.enabled && drive.nextRetryAt !== null)
    candidates.push(
      new Date(Math.max(drive.nextRetryAt, drive.at + DRIVE_CHECK_MS)),
    );
  const next = redispatch
    ? new Date()
    : earliestDue(at, MAX_IDLE_MS, candidates);
  // Conditional so a write that woke the project after `seen` keeps it due.
  await authDb.project.updateMany({
    where: { id: p.id, workDueAt: seen },
    data: { workDueAt: next },
  });
}
async function reportProjectFailure(p: DueProject, error: unknown) {
  await authDb.project
    .updateMany({
      where: { id: p.id, workDueAt: { lte: new Date() } },
      data: { workDueAt: new Date(Date.now() + FAILURE_RETRY_MS) },
    })
    .catch(() => {});
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
      try {
        await processProject(p);
      } catch (error) {
        await reportProjectFailure(p, error);
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

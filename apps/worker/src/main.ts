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
  evaluateExperiment,
} from "../../api/src/modules/lifecycle.ts";
import { writeFile, rename, unlink } from "node:fs/promises";
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
let stopping = false;
const projectFailures = new Map<string, number>();
const driveRetryChecks = new Map<string, number>();
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
              config.EXECUTION_MODE === "live"
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
                  if (project.mode !== "autopilot") return null;
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
async function pump() {
  if (stopping) return;
  try {
    const projects = await authDb.project.findMany();
    for (const p of projects) {
      try {
        const scope: Scope = {
          workspaceId: p.workspaceId,
          projectId: p.id,
          userId: "worker",
          role: "owner",
        };
        const events = await scoped(p.workspaceId, p.id, async (tx) => {
          await sweepProject(tx, scope);
          // Crash recovery preserves the intent and never retries an ambiguous external write.
          const stalled = await tx.entity.findMany({
            where: { projectId: p.id, kind: "jobs" },
          });
          for (const job of stalled) {
            const d = data(job);
            if (
              d.status === "running" &&
              d.leaseUntil &&
              new Date(d.leaseUntil) < new Date()
            ) {
              if (d.topic === "slack_notification")
                await markSlackOutcomeUnknown(tx, scope, d.resourceId);
              if (d.topic === "publishing") {
                const pub = await entity(
                  tx,
                  scope,
                  "publications",
                  d.resourceId,
                );
                if (data(pub).status === "sending") {
                  await update(tx, scope, pub, {
                    ...data(pub),
                    status: "outcome_unknown",
                  });
                  await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pub.id);
                }
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
          }
          return tx.outbox.findMany({
            where: {
              projectId: p.id,
              dispatchedAt: null,
              availableAt: { lte: new Date() },
            },
            take: 40,
            orderBy: { availableAt: "asc" },
          });
        });
        if (
          Date.now() - (driveRetryChecks.get(p.id) ?? 0) > 30_000 &&
          (await connectionStatus(scope)).enabled
        ) {
          driveRetryChecks.set(p.id, Date.now());
          const due = await scoped(p.workspaceId, p.id, (tx) =>
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
          for (const asset of due
            .filter(
              (row) =>
                data(row).driveSyncStatus === "FAILED" &&
                Number(data(row).driveRetryAttempts ?? 0) < 5 &&
                Date.parse(data(row).driveRetryAt ?? "") <= Date.now(),
            )
            .slice(0, 3)) {
            try {
              await saveGeneratedAsset(scope, asset.id);
            } catch {
              await markSyncFailed(scope, asset.id);
            }
          }
        }
        for (const e of events) {
          const queue = queues.get(e.topic as (typeof classes)[number]);
          if (!queue) continue;
          if ((await queue.getWaitingCount()) > 200) continue;
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
      } catch (error) {
        if (Date.now() - (projectFailures.get(p.id) ?? 0) > 30000) {
          projectFailures.set(p.id, Date.now());
          const code =
            error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
              ? error.message
              : "PROJECT_QUEUE_UNAVAILABLE";
          console.error(
            "Orbit project queue blocked: " +
              code +
              "; other projects continue",
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
      }
    }
    await queues.values().next().value!.getWaitingCount();
    await connection.set(
      "orbit:worker:health:" + config.PUBLISHER_INSTANCE_ID,
      JSON.stringify({ checkedAt: Date.now(), queues: classes }),
      "EX",
      45,
    );
    await writeFile(
      healthFile + ".tmp",
      JSON.stringify({
        checkedAt: Date.now(),
        instanceId: config.PUBLISHER_INSTANCE_ID,
      }),
    );
    await rename(healthFile + ".tmp", healthFile);
  } catch {
    console.error(
      "Orbit queue pump unavailable; retrying with bounded concurrency",
    );
  } finally {
    if (!stopping) setTimeout(pump, 1500);
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

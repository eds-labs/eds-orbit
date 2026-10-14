import { scoped } from "../../../../../packages/db/src/index.ts";
import type { JobDef } from "../../platform/jobs/types.ts";
import { data, entity, exception, update } from "../../shared.ts";
import {
  deterministicDraft,
  publishIntent,
  reviewContent,
} from "./pipeline/workflow.ts";
import { generateMissionLive } from "./pipeline/generation.ts";
import {
  dispatchPublication,
  reconcilePublication,
} from "./publishing/publisher.ts";
import {
  dispatchSlackDigest,
  markSlackOutcomeUnknown,
} from "./publishing/slack.ts";
import { evaluateExperiment } from "./analytics/lifecycle.ts";
import { runImageJob } from "./brand/image-requests.ts";
import {
  deliverPostizDraft,
  markPostizDraftOutcomeUnknown,
} from "./agents/draft-delivery.ts";
import { runAgentTask } from "./agents/specialists/runner.ts";

/**
 * The marketing module's worker queues (WP1.6). The handlers and the per-queue
 * rules moved unchanged from apps/worker/src/main.ts.
 */
export const marketingJobs: JobDef[] = [
  {
    queueClass: "publishing",
    concurrency: 2,
    handler: ({ scope, job }) =>
      dispatchPublication(scope, job.resourceId).then(() => undefined),
    // Crash recovery preserves the intent and never retries an ambiguous external write.
    async onLeaseExpired(tx, scope, job) {
      const pub = await entity(tx, scope, "publications", job.resourceId);
      if (data(pub).status === "sending") {
        await update(tx, scope, pub, {
          ...data(pub),
          status: "outcome_unknown",
        });
        await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pub.id);
      }
    },
  },
  {
    queueClass: "generation",
    async handler({ scope, job, jobId, executionMode }) {
      const drafts =
        executionMode === "live" || job.liveDraftOnce === true
          ? [await generateMissionLive(scope, job.resourceId, jobId)]
          : await scoped(scope.workspaceId, scope.projectId, (tx) =>
              deterministicDraft(tx, scope, job.resourceId, jobId),
            );
      for (const content of drafts) {
        const reviewed = await scoped(
          scope.workspaceId,
          scope.projectId,
          async (tx) => {
            const project = await tx.project.findUniqueOrThrow({
              where: { id: scope.projectId },
            });
            if (job.liveDraftOnce === true || project.mode !== "autopilot")
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
            const current = await entity(tx, scope, "content", content.id);
            const result =
              data(current).status === "draft"
                ? await reviewContent(tx, scope, current.id, current.version)
                : current;
            if (data(result).status !== "reviewed") {
              await exception(tx, scope, "CONTENT_REVIEW_REQUIRED", result.id);
              return null;
            }
            return result;
          },
        );
        if (reviewed)
          await scoped(scope.workspaceId, scope.projectId, (tx) =>
            publishIntent(tx, scope, {
              contentId: reviewed.id,
              version: reviewed.version,
            }),
          );
      }
    },
  },
  {
    queueClass: "analytics",
    handler: ({ scope, job }) =>
      scoped(scope.workspaceId, scope.projectId, (tx) =>
        evaluateExperiment(tx, scope, job.resourceId),
      ).then(() => undefined),
  },
  {
    queueClass: "reconciliation",
    handler: ({ scope, job }) =>
      reconcilePublication(scope, job.resourceId).then(() => undefined),
  },
  {
    queueClass: "slack_notification",
    handler: ({ scope, job }) =>
      dispatchSlackDigest(scope, job.resourceId).then(() => undefined),
    onLeaseExpired: (tx, scope, job) =>
      markSlackOutcomeUnknown(tx, scope, job.resourceId).then(() => undefined),
  },
  {
    queueClass: "image",
    // Runs an owner-approved image request with the decider's current role.
    handler: ({ scope, job, jobId }) =>
      runImageJob(scope, job.actorId, job.resourceId, jobId).then(
        () => undefined,
      ),
  },
  {
    // Specialist tasks of assignment runs (Orbit Agents). Records its own
    // outcome on the task; never retried after a paid call.
    queueClass: "agent",
    // A specialist task may run its full 120 s wall time.
    leaseMs: 180000,
    handler: ({ scope, job }) =>
      runAgentTask(scope, job.resourceId).then(() => undefined),
  },
  {
    // Approved assignment posts sent to Postiz as drafts only (delivery
    // "Postiz draft", R73). Records its own outcome on the handoff; an
    // unclear send is never repeated.
    queueClass: "postiz_draft",
    handler: ({ scope, job }) =>
      deliverPostizDraft(scope, job.resourceId).then(() => undefined),
    // A draft send that may have reached Postiz is never repeated (R73).
    onLeaseExpired: (tx, scope, job) =>
      markPostizDraftOutcomeUnknown(tx, scope, job.resourceId).then(
        () => undefined,
      ),
  },
];

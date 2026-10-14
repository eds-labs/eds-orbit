import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { SchedulerContribution } from "../../platform/jobs/types.ts";
import { data, DomainError, exception, list, update } from "../../shared.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { planAutopilot, nextAutopilotCheckAt } from "./pipeline/autopilot.ts";
import { releaseMissedSlots } from "./pipeline/paused-posts.ts";
import { prepareFollowup } from "./pipeline/planning.ts";
import { analyze } from "./pipeline/workflow.ts";
import { evaluateExperiment } from "./analytics/lifecycle.ts";
import { advanceContentPackages } from "../agents/content-packages.ts";
import { agentsEnabled } from "../agents/assignments.ts";
import { nextDailyReportAt, planDailyReport } from "../agents/notifications.ts";
import { scheduleUnscheduledRuns } from "../agents/veto.ts";
import { requeuePostizDrafts } from "../agents/draft-delivery.ts";
import {
  nextAssignmentPlanAt,
  planAssignmentRuns,
} from "../agents/assignment-runs.ts";

// Marketing's part of the per-project sweep (WP1.6), moved unchanged from
// lifecycle.sweepProject; the platform checks the pause before it runs.
/** Bounded sweep: an owner-created mission is never extended or regenerated past its quota. */
async function marketingSweep(tx: DbTx, scope: Scope, at: Date) {
  await releaseMissedSlots(tx, scope, at);
  // Assignment runs replace the weekly autopilot: both fill the same slots.
  if (agentsEnabled()) {
    await planAssignmentRuns(tx, scope, at);
    // Runs whose approved posts could not be scheduled after their review (R54).
    await scheduleUnscheduledRuns(tx, scope);
    // Booked Postiz drafts whose send a pause or a failed job held back (R73).
    await requeuePostizDrafts(tx, scope);
    // The bot's daily report, once per local day (a paused project sends none).
    await planDailyReport(tx, scope, at);
  } else await planAutopilot(tx, scope, at);
  let queued = 0;
  const metrics = await list(tx, scope, "metrics");
  // An owner-approved single live draft is the mission's only attempt; its
  // startAt change bumps the mission version and must not queue another job.
  const liveDraftMissions = new Set(
    (await list(tx, scope, "jobs"))
      .filter(
        (job) =>
          data(job).topic === "generation" && data(job).liveDraftOnce === true,
      )
      .map((job) => data(job).resourceId),
  );
  for (const m of await list(tx, scope, "missions")) {
    if (metrics.some((row) => data(row).campaign === m.id)) {
      try {
        await analyze(tx, scope, m.id);
      } catch (error) {
        if (error instanceof DomainError)
          await exception(tx, scope, error.code, m.id);
        else throw error;
      }
    }
    const current = (await prepareFollowup(tx, scope, m.id, at)) ?? m;
    const d = data(current);
    if (d.status !== "ready" || at < new Date(d.startAt)) continue;
    if (at >= new Date(d.endAt)) {
      await update(tx, scope, m, { ...d, status: "expired" });
      continue;
    }
    if (liveDraftMissions.has(m.id)) continue;
    // An assignment run's missions are drafted by their copywriter task only, under its budget (R37).
    if (d.assignmentRunId) continue;
    await enqueue(
      tx,
      scope,
      "generation",
      m.id,
      "mission:" + m.id + ":" + current.version,
      at,
    );
    queued++;
  }
  await advanceContentPackages(tx, scope);
  for (const e of await list(tx, scope, "experiments"))
    if (data(e).status === "running" && at >= new Date(data(e).endAt))
      await evaluateExperiment(tx, scope, e.id, at);
  return { queued };
}
/**
 * Earliest future time at which sweepProject can change state without any new write.
 * Writes wake a project through database triggers; this covers purely time-based transitions.
 */
async function marketingNextDueAt(tx: DbTx, scope: Scope, at: Date) {
  const now = at.valueOf();
  let next = Infinity;
  const consider = (value: unknown) => {
    const time =
      typeof value === "number" ? value : Date.parse(String(value ?? ""));
    if (Number.isFinite(time) && time > now) next = Math.min(next, time);
  };
  for (const m of await list(tx, scope, "missions")) {
    const d = data(m);
    if (d.status === "ready") {
      consider(d.startAt);
      consider(d.endAt);
    } else if (d.status === "awaiting_followup") {
      consider(d.nextPlanAt);
      consider(d.endAt);
    }
  }
  for (const e of await list(tx, scope, "experiments"))
    if (data(e).status === "running") consider(data(e).endAt);
  if (agentsEnabled()) {
    consider((await nextAssignmentPlanAt(tx, scope, at))?.valueOf());
    consider((await nextDailyReportAt(tx, scope, at))?.valueOf());
  } else consider((await nextAutopilotCheckAt(tx, scope))?.valueOf());
  return Number.isFinite(next) ? new Date(next) : null;
}

export const marketingScheduler: SchedulerContribution = {
  sweep: marketingSweep,
  nextDueAt: marketingNextDueAt,
};

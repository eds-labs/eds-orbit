import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit } from "../../../shared.ts";
import {
  notify as platformNotify,
  telegramLinked,
} from "../../../platform/notifications/notify.ts";
import { zonedTime } from "../publishing/posting-slots.ts";
import { agentsEnabled } from "./assignments.ts";
import { localDate } from "./scheduling.ts";

/**
 * Marketing's messages for the owner's private Telegram bot (Orbit Agents,
 * spec §10): previews, notices and the daily report. The platform queues and
 * sends them (`platform/notifications`, WP2.5b); marketing registers these
 * kinds and renders them (`notification-messages.ts`). This file is kept
 * free of the renderers so that the places that report something (pause,
 * review, runner, publisher) can import it without a cycle.
 *
 * A notification never changes publishing rights: it is a message about a
 * state, and the veto deadline applies whether or not it arrives.
 */
export const NOTIFY_KINDS = [
  // A post with a veto window (Task 11 queues it with the same key format).
  "preview",
  // A draft the agent review rejected and did not replace.
  "rejected",
  // A draft the review left for the owner to judge, or one the agent approved
  // whose approval does not stand in for the owner's (authority off, R71).
  "needs_owner",
  // A deliverable dropped because no slot was free (spec §9).
  "dropped",
  // Deliverables of a new run dropped at planning: no free slot that day (spec §9, I4).
  "slots_unavailable",
  // One notice per run that ended with failed steps or dropped briefs (I4).
  "run_problem",
  // A post the owner was told about (preview, or his own release, R71) blocked at claim or handoff (I4).
  "blocked",
  "budget_paused",
  // Scheduled posts withdrawn because the owner moved the assignment's times (R70).
  "retimed",
  // A Postiz error of a publication, or a Postiz draft handoff with an unclear outcome (R73).
  "postiz_error",
  // An assignment draft created as a draft in Postiz (delivery "Postiz draft", R73); no Stop.
  "postiz_draft",
  "project_paused",
  // Posts or drafts withdrawn because the owner confirmed another delivery (R73, I1).
  "delivery_changed",
  // A draft-delivery assignment planned no run today: Postiz drafts are switched off (M3).
  "drafts_disabled",
  "daily_report",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Local time of the daily report; the project has no setting for it yet. */
export const DAILY_REPORT_TIME = "20:00";

/**
 * Queues one message (see `platform/notifications/notify.ts`): one job per
 * `notify:<kind>:<ref>`, so `ref` must name the event. A no-op with Orbit
 * Agents off, and without a bound bot.
 */
export function notify(tx: DbTx, scope: Scope, kind: NotifyKind, ref: string) {
  return platformNotify(tx, scope, kind, ref);
}

/** The project's local report time of a local date (`YYYY-MM-DD`). */
export function dailyReportTime(date: string, timezone: string) {
  const [hour, minute] = DAILY_REPORT_TIME.split(":").map(Number);
  const [year, month, day] = date.split("-").map(Number);
  return zonedTime(year!, month!, day!, hour!, minute!, timezone);
}

/**
 * Queues the daily report once the project's local report time of a day has
 * passed (`notify:daily_report:<projectId>:<YYYY-MM-DD>`); the sweep calls it
 * on every pass and the key keeps it to one per day. A day whose sweep first
 * sees it late in the evening still gets its report that evening.
 */
export async function planDailyReport(tx: DbTx, scope: Scope, at = new Date()) {
  if (!agentsEnabled()) return null;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const date = localDate(at, project.timezone);
  if (at < dailyReportTime(date, project.timezone)) return null;
  return notify(tx, scope, "daily_report", `${scope.projectId}:${date}`);
}

/** The next report time after `at`, so the sweep wakes up for it; null without a bound bot. */
export async function nextDailyReportAt(
  tx: DbTx,
  scope: Scope,
  at = new Date(),
) {
  if (!agentsEnabled() || !(await telegramLinked(tx, scope))) return null;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const date = localDate(at, project.timezone);
  const today = dailyReportTime(date, project.timezone);
  if (today > at) return today;
  // The next calendar day, counted on the date, never in hours (DST).
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1))
    .toISOString()
    .slice(0, 10);
  return dailyReportTime(next, project.timezone);
}

// Blockers that need no notice: the owner stopped the post or paused the project himself.
const OWNER_CAUSED = ["VETOED", "PROJECT_PAUSED"];

/**
 * Reports a post that was blocked at claim or handoff although the owner was
 * told it would go out: it has a veto window (a preview was sent) or the
 * owner released it himself (R71). Audited as `publication.claim_blocked`
 * for the daily report, and one notice per publication (it is blocked once).
 * A stop or a project pause is the owner's own doing and is not reported.
 * Call it in the transaction that blocks the post; a no-op with Orbit Agents off.
 */
export async function reportBlockedPost(
  tx: DbTx,
  scope: Scope,
  pubId: string,
  pub: Record<string, any>,
  blockers: string[],
) {
  if (!agentsEnabled()) return;
  if (!pub.vetoDeadline && !pub.ownerReleasedAt) return;
  if (pub.vetoedAt || blockers.some((code) => OWNER_CAUSED.includes(code)))
    return;
  await audit(tx, scope, "publication.claim_blocked", pubId, {
    blockers,
    assignmentId: pub.assignmentId ?? null,
    assignmentRunId: pub.assignmentRunId ?? null,
  });
  await notify(tx, scope, "blocked", pubId);
}

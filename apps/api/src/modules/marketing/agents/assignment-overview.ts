import { draftReplaced } from "./draft-state.ts";
import { baseContentId } from "../approval-state.ts";
import { reviewBacklog } from "./review-backlog.ts";
import { z } from "zod";
import { latestAssignmentResult } from "./assignment-result.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, list } from "../../../shared.ts";
import { assignedPostizChannels } from "../publishing/postiz-assignment.ts";
import { socialChannelHandles } from "../../social/contract.ts";
import {
  agentReviewAuthority,
  confirmedHash,
  withinConfirmation,
} from "./agent-review.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { resolveBrandKit } from "../creative/brand-kit.ts";
import {
  nextAssignmentRunAt,
  runRetryRefusal,
  runsMatching,
} from "./assignment-runs.ts";
import {
  agentsEnabled,
  confirmedDelivery,
  deliveryOf,
  approvalModeOf,
} from "./assignments.ts";
import { localDate } from "./scheduling.ts";
import {
  assignmentMonthSpend,
  assignmentsMonthSpend,
} from "./specialists/runner.ts";
import type { ManagedAgentListing } from "../../../platform/agents/managed.ts";
import { assignmentCardOf } from "../tools/assignment-tools.ts";
import {
  assignmentPost,
  draftDelivery,
  slotExpired,
  withdrawable,
} from "./veto.ts";
import { creativeStudioEnabled } from "../creative/flag.ts";

/**
 * Read models of Orbit Agents for the web (Task 14): the assignments page,
 * the live state behind assignment cards in the chat and the upcoming
 * assignment posts on the approvals page (spec §10 fallback). Read only;
 * every change goes through assignments.ts, action requests or veto.ts.
 */

export const assignmentStatusInput = z
  .object({
    status: z.enum(["paused", "active", "ended"]),
    version: z.number().int().positive(),
  })
  .strict();

export const vetoInput = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

const EXCERPT = 280;
const CONCERNS = 6;
const CONCERN_TEXT = 500;

/**
 * The review model's reasons on a draft Orbit objected to (verdict
 * `reject`, or a channel copy of such a text): plain sentences only, the
 * codes it appends (such as AGENT_SECOND_REVIEW_NOT_APPROVED) are left out.
 */
function concernsOf(d: Record<string, any>): string[] {
  const decision = d.agentReviewDecision;
  if (!decision || d.agentReview) return [];
  const objected =
    decision.verdict === "reject" ||
    decision.modelVerdict === "reject" ||
    decision.modelVerdict === "revise";
  if (!objected) return [];
  return ((decision.reasons ?? []) as unknown[])
    .map((reason) => String(reason).trim())
    .filter((reason) => reason && !/^[A-Z0-9_]+$/.test(reason))
    .slice(0, CONCERNS)
    .map((reason) => reason.slice(0, CONCERN_TEXT));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Channel names of the project by channel ID (Postiz channels and `social:` accounts), as the owner knows them. */
export async function channelNames(tx: DbTx, scope: Scope) {
  const names = new Map<string, string>();
  for (const row of await list(tx, scope, "connectors"))
    if (data(row).provider === "postiz")
      for (const channel of assignedPostizChannels(data(row)))
        names.set(String(channel.id), String(channel.name ?? channel.id));
  for (const [channel, handle] of await socialChannelHandles(tx, scope))
    names.set(channel, handle);
  return names;
}
const namesOf = (channels: unknown, names: Map<string, string>) =>
  Object.fromEntries(
    (Array.isArray(channels) ? channels : [])
      .map(String)
      .filter((id) => names.has(id))
      .map((id) => [id, names.get(id)!]),
  );

export async function rowsById(
  tx: DbTx,
  scope: Scope,
  kind: string,
  ids: unknown[],
) {
  const wanted = [
    ...new Set(ids.filter((id): id is string => typeof id === "string")),
  ].filter((id) => UUID.test(id));
  if (!wanted.length)
    return new Map<string, { id: string; version: number; data: unknown }>();
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      id: { in: wanted },
    },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Whether the agent may release the creative posts of an assignment, and
 * whether the vision review is on (read only, for the settings view). Null
 * unless the assignment has a creative and its agent approves the drafts. The
 * brand kit is resolved at most once per call through `kit`; a project
 * without a usable kit has no vision review.
 */
export async function creativeAuthorityOf(
  tx: DbTx,
  scope: Scope,
  d: Record<string, any>,
  kit: { visionReview?: boolean } = {},
) {
  if (!d.creative || approvalModeOf(d) !== "delegated_review") return null;
  if (kit.visionReview === undefined)
    kit.visionReview = await resolveBrandKit(tx, scope).then(
      (plan) => plan.config.visualReview === true,
      (error) => {
        if (error instanceof DomainError) return false;
        throw error;
      },
    );
  return {
    flag:
      loadConfig().ORBIT_AGENT_REVIEW_CREATIVES === "true" &&
      agentReviewAuthority(),
    visionReview: kit.visionReview,
  };
}

/**
 * The project's assignments for the assignments page: schedule, the time the
 * next run starts, what this UTC month has cost (counted like the budget
 * check, `assignmentMonthSpend`) against the monthly budget, and the open
 * confirmation request of a draft. Ended ones come last.
 */
export async function listAssignments(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const rows = (await list(tx, scope, "assignments"))
    .sort(
      (a, b) =>
        Number(data(a).status === "ended") - Number(data(b).status === "ended"),
    )
    .slice(0, 100);
  const names = await channelNames(tx, scope);
  const requests = await rowsById(
    tx,
    scope,
    "action_requests",
    rows.map((row) => data(row).actionRequestId),
  );
  // Only runs of the last days can still be retried; bounds the lookup.
  const recentDate = localDate(
    new Date(now.valueOf() - 86400000),
    project.timezone,
  );
  const items = [];
  const kit: { visionReview?: boolean } = {};
  for (const row of rows) {
    const d = data(row);
    // The latest run (not retired) when the owner can still retry it (G6).
    const latest = (
      await runsMatching(tx, scope, {
        assignmentId: row.id,
        dateFrom: recentDate,
      })
    )
      .filter((run) => !data(run).retiredAt)
      .at(0);
    const retryableRunId =
      latest && !(await runRetryRefusal(tx, scope, latest, now))
        ? latest.id
        : null;
    const request = requests.get(String(d.actionRequestId));
    items.push({
      id: row.id,
      version: row.version,
      name: d.name,
      status: d.status,
      kind: d.kind,
      contentType: d.contentType,
      channels: d.channels ?? [],
      channelNames: namesOf(d.channels, names),
      schedule: d.schedule,
      image: d.image === true,
      vetoMinutes: d.vetoMinutes,
      delivery: deliveryOf(d),
      approvalMode: approvalModeOf(d),
      creativeAuthority: await creativeAuthorityOf(tx, scope, d, kit),
      // A paused project runs nothing, so no run is due.
      nextRunAt: project.paused
        ? null
        : ((
            await nextAssignmentRunAt(tx, scope, row, project.timezone, now)
          )?.toISOString() ?? null),
      monthCostMicros: await assignmentMonthSpend(tx, scope, row.id, now),
      monthlyBudgetMicros: Number(d.monthlyBudgetMicros ?? 0),
      ...(d.pendingReviewLimit !== undefined
        ? { pendingReviewLimit: d.pendingReviewLimit }
        : {}),
      ...(d.historyDays != null ? { historyDays: d.historyDays } : {}),
      retryableRunId,
      latestRun: await latestAssignmentResult(tx, scope, row.id),
      backlog: await reviewBacklog(tx, scope, row.id),
      actionRequestId:
        d.status === "draft" && data(request).status === "pending"
          ? request!.id
          : null,
    });
  }
  return { timezone: project.timezone, paused: project.paused, items };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Daily at 10:00, 17:00 (Europe/Berlin)": when an assignment's posts are due. */
export function scheduleSummary(schedule: unknown, timezone: string) {
  const s = (schedule ?? {}) as Record<string, any>;
  const times = Array.isArray(s.times) ? s.times.map(String).join(", ") : "";
  const at = times ? ` at ${times}` : "";
  const zone = ` (${timezone})`;
  if (s.rhythm === "daily") return `Daily${at}${zone}`;
  if (s.rhythm === "weekly") {
    const days = (Array.isArray(s.weekdays) ? s.weekdays : [])
      .map((day: unknown) => WEEKDAYS[Number(day)])
      .filter(Boolean)
      .join(", ");
    return `Weekly${days ? ` on ${days}` : ""}${at}${zone}`;
  }
  if (s.rhythm === "once")
    return `Once${s.date ? ` on ${s.date}` : ""}${at}${zone}`;
  return undefined;
}

/**
 * The project's assignments as managed agents for the platform's agent
 * overview (ModuleContributions.agentListings, WP1.9): read only, ended ones
 * left out, with the schedule, this UTC month's spend (as the budget check
 * counts it) against the monthly budget and a link to the assignments page.
 * Nothing while Orbit Agents is off.
 */
export async function assignmentListings(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
): Promise<ManagedAgentListing[]> {
  if (!agentsEnabled()) return [];
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { timezone: true },
  });
  const rows = (await list(tx, scope, "assignments"))
    .filter((row) => data(row).status !== "ended")
    .slice(0, 100);
  const spend = await assignmentsMonthSpend(
    tx,
    scope,
    rows.map((row) => row.id),
    now,
  );
  const link = `/p/${scope.projectId}/marketing/assignments`;
  return rows.map((row) => {
    const d = data(row);
    const schedule = scheduleSummary(d.schedule, project.timezone);
    return {
      id: row.id,
      name: String(d.name ?? ""),
      status: String(d.status ?? "draft"),
      ...(schedule ? { schedule } : {}),
      monthSpendMicros: spend.get(row.id) ?? 0,
      monthBudgetMicros: Number(d.monthlyBudgetMicros ?? 0),
      link,
    };
  });
}

/**
 * Live state of the assignments that chat cards name (R16: a card carries
 * the content it showed; the page reads status and the decision request by
 * the assignment ID). Unknown IDs are left out.
 */
export async function conversationAssignments(
  tx: DbTx,
  scope: Scope,
  ids: unknown[],
) {
  const rows = await rowsById(tx, scope, "assignments", ids);
  if (!rows.size) return [];
  const names = await channelNames(tx, scope);
  const requests = await rowsById(
    tx,
    scope,
    "action_requests",
    [...rows.values()].map((row) => data(row).actionRequestId),
  );
  return Promise.all(
    [...rows.values()].map(async (row) => {
      const request = requests.get(String(data(row).actionRequestId));
      const r = data(request);
      return {
        ...assignmentCardOf(row),
        latestRun: await latestAssignmentResult(tx, scope, row.id),
        channelNames: namesOf(data(row).channels, names),
        actionRequest: request
          ? {
              id: request.id,
              version: request.version,
              packageHash: r.packageHash,
              status: r.status,
              expiresAt: r.expiresAt,
            }
          : null,
      };
    }),
  );
}

/**
 * Assignment posts Orbit still holds (the veto allow-list, R56): created,
 * or blocked before any handoff, each with its slot, veto deadline (null for
 * a post the owner released, `ownerReleased`), a text excerpt and the
 * assignment. With them the drafts of assignments with the delivery "Postiz
 * draft" (R73) whose slot is still ahead: booked, being sent, created in
 * Postiz or unclear (`delivery: "postiz_draft"`, the handoff's id and
 * status). Those have no Stop: Orbit publishes none of them, and a draft
 * already in Postiz is withdrawn there. Earliest slot first.
 */
export async function upcomingAssignmentPosts(tx: DbTx, scope: Scope) {
  const rows = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "publications",
        OR: ["intent_created", "blocked_dependency"].map((status) => ({
          data: { path: ["status"], equals: status },
        })),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  ).filter((row) => assignmentPost(data(row)) && withdrawable(data(row)));
  const now = Date.now();
  const drafts = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "postiz_drafts",
        data: { path: ["source"], equals: "assignment" },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  ).filter(
    (row) =>
      ["queued", "sending", "accepted", "outcome_unknown"].includes(
        data(row).status,
      ) && Date.parse(String(data(row).slotAt)) > now,
  );
  const contents = await rowsById(
    tx,
    scope,
    "content",
    rows.map((row) => data(row).contentId),
  );
  const assignments = await rowsById(tx, scope, "assignments", [
    ...rows.map((row) => data(row).assignmentId),
    ...drafts.map((row) => data(row).assignmentId),
  ]);
  const names = await channelNames(tx, scope);
  const excerptOf = (body: unknown) => {
    const text = String(body ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
  };
  const delivered = drafts.map((row) => {
    const h = data(row);
    return {
      id: row.id,
      version: row.version,
      status: String(h.status),
      reason: h.error ?? null,
      channel: h.integrationId,
      channelName: names.get(String(h.integrationId)) ?? null,
      scheduledAt: h.slotAt,
      vetoDeadline: null,
      ownerReleased: h.approvedBy === "owner",
      // The text that was handed over, not a later version of the content.
      excerpt: excerptOf(h.body),
      assignmentId: h.assignmentId ?? null,
      assignmentName:
        data(assignments.get(String(h.assignmentId))).name ?? null,
      delivery: "postiz_draft" as const,
    };
  });
  return rows
    .map((row) => {
      const p = data(row);
      const text = String(data(contents.get(String(p.contentId))).body ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: row.id,
        version: row.version,
        status: p.status,
        reason: p.reason ?? null,
        channel: p.channel,
        channelName: names.get(String(p.channel)) ?? null,
        scheduledAt: p.scheduledAt,
        // Null for a post the owner released: it has no veto window.
        vetoDeadline: p.vetoDeadline ?? null,
        ownerReleased: Boolean(p.ownerReleasedAt),
        excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text,
        assignmentId: p.assignmentId ?? null,
        assignmentName:
          data(assignments.get(String(p.assignmentId))).name ?? null,
        delivery: "publish" as "publish" | "postiz_draft",
      };
    })
    .concat(delivered)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
}

/**
 * Assignment drafts that wait for the owner's release (R70, I1): social
 * drafts of a run that is not canceled, left `needs_review` by the review
 * (R47/R49), without a linked bot or while agent review authority is off,
 * and whose assignment's confirmation still covers them. Each comes with its
 * run slot, a text excerpt, whether the review agent approved it and the
 * problems it found, and its `state`: `pending` while its slot is ahead
 * (it can be released), `expired` once the slot has passed (a release no
 * longer catches it up; it can be rejected or archived). Expired drafts are
 * listed only with `includeExpired`, for up to `EXPIRED_DAYS`; attention and
 * the agent hub count pending drafts only. Earliest slot first. Empty while
 * Orbit Agents is off.
 */
export const EXPIRED_DAYS = 14;
export async function draftsAwaitingOwner(
  tx: DbTx,
  scope: Scope,
  options: { includeExpired?: boolean } = {},
) {
  if (!agentsEnabled()) return [];
  const now = new Date();
  const oldest = now.valueOf() - EXPIRED_DAYS * 86400000;
  const rows = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "content",
        data: { path: ["status"], equals: "needs_review" },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  ).filter((row) => {
    const d = data(row);
    return (
      typeof d.assignmentRunId === "string" &&
      d.type === "social" &&
      !draftReplaced(d)
    );
  });
  const missions = await rowsById(
    tx,
    scope,
    "missions",
    rows.map((row) => data(row).missionId),
  );
  const runs = await rowsById(
    tx,
    scope,
    "assignment_runs",
    rows.map((row) => data(row).assignmentRunId),
  );
  const assignments = await rowsById(
    tx,
    scope,
    "assignments",
    rows.map((row) => data(row).assignmentId),
  );
  const names = await channelNames(tx, scope);
  const items = [];
  for (const row of rows) {
    const d = data(row);
    const run = runs.get(String(d.assignmentRunId));
    const assignment = assignments.get(String(d.assignmentId));
    const slotAt = String(
      data(missions.get(String(d.missionId))).plannedSlotAt ??
        d.scheduledAt ??
        "",
    );
    if (
      !run ||
      data(run).status === "canceled" ||
      !assignment ||
      !confirmedHash(data(assignment)) ||
      !withinConfirmation(data(assignment), d) ||
      !Number.isFinite(Date.parse(slotAt))
    )
      continue;
    const expired = slotExpired(new Date(slotAt), now);
    if (expired && (!options.includeExpired || Date.parse(slotAt) < oldest))
      continue;
    const text = String(d.body ?? "")
      .replace(/\s+/g, " ")
      .trim();
    items.push({
      id: row.id,
      version: row.version,
      // The original of a channel copy (R76), else the draft itself: the
      // approvals page and the badge show a Facebook/Instagram pair once.
      baseId: baseContentId(row),
      state: expired ? ("expired" as const) : ("pending" as const),
      channel: d.channel,
      channelName: names.get(String(d.channel)) ?? null,
      slotAt,
      excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text,
      // The full text, for the owner's edit (2026-11-11).
      body: String(d.body ?? ""),
      // The draft's image or creative rendition, shown as a thumbnail
      // (Creative Studio on; off, the list is as before, CS-D6).
      ...(creativeStudioEnabled()
        ? { assetId: typeof d.assetId === "string" ? d.assetId : null }
        : {}),
      assignmentId: d.assignmentId,
      assignmentName: data(assignment).name ?? null,
      // What the release does: schedule the post, or book a Postiz draft (R73).
      delivery: draftDelivery(
        d,
        confirmedDelivery(data(assignment)) ?? deliveryOf(data(assignment)),
      ),
      // The review agent approved the text; only its authority was missing.
      agentApproved: Boolean(d.agentReview),
      // Why the review agent's approval of a creative post does not stand
      // in for the owner's: a code, only on a pending draft that still carries the agent's approval.
      waitingReason:
        !expired &&
        d.agentReview &&
        approvalModeOf(data(assignment)) === "delegated_review" &&
        approvalModeOf(d) === "delegated_review" &&
        typeof d.agentAuthorityProblem === "string"
          ? d.agentAuthorityProblem
          : null,
      // Why Orbit objected (2026-11-11): the review model's reasons, shown
      // so the owner can decide; none when it approved or only left it.
      concerns: concernsOf(d),
      // The owner changed the text since; the concerns were about the text before.
      ownerEdited: Boolean(d.ownerEdit),
      problems: [
        ...new Set([
          ...((d.agentReviewDecision?.deterministicProblems ?? []) as string[]),
          // The missing owner review is what the release gives.
          ...((d.review?.problems ?? []) as string[]).filter(
            (code) => code !== "HUMAN_CONTENT_REVIEW_REQUIRED",
          ),
        ]),
      ],
    });
  }
  return items.sort((a, b) => a.slotAt.localeCompare(b.slotAt));
}

/**
 * What happened to the assignment drafts an owner decided in the last
 * `HISTORY_DAYS` days, for the approvals page's history: released posts
 * (a publication or Postiz draft the owner released), and drafts the owner
 * rejected, discarded or archived (`ownerDecision`). An item the owner
 * archived from the overview (`ownerDecision.hiddenAt`) is listed only with
 * `includeHidden`, so archived requests stay traceable. Newest first.
 */
export const HISTORY_DAYS = 30;
export async function draftDecisionHistory(
  tx: DbTx,
  scope: Scope,
  options: { includeHidden?: boolean } = {},
) {
  if (!agentsEnabled()) return [];
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000);
  const closed = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      updatedAt: { gte: since },
      OR: [
        { data: { path: ["status"], equals: "rejected" } },
        { data: { path: ["status"], equals: "archived" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const handoffs = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: { in: ["publications", "postiz_drafts"] },
      updatedAt: { gte: since },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const released = handoffs.filter((row) => {
    const d = data(row);
    return row.kind === "publications"
      ? Boolean(d.ownerReleasedAt)
      : d.source === "assignment" && d.approvedBy === "owner";
  });
  const releasedContent = await rowsById(
    tx,
    scope,
    "content",
    released.map((row) => data(row).contentId),
  );
  const names = await channelNames(tx, scope);
  const assignments = await rowsById(tx, scope, "assignments", [
    ...closed.map((row) => data(row).assignmentId),
    ...[...releasedContent.values()].map((row) => data(row).assignmentId),
  ]);
  const excerpt = (body: unknown) => {
    const text = String(body ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
  };
  const base = (row: { id: string; version: number; data: unknown }) => {
    const d = data(row);
    return {
      id: row.id,
      version: row.version,
      channel: d.channel,
      channelName: names.get(String(d.channel)) ?? null,
      excerpt: excerpt(d.body),
      assignmentId: d.assignmentId ?? null,
      assignmentName:
        data(assignments.get(String(d.assignmentId))).name ?? null,
    };
  };
  const items = [];
  for (const row of closed) {
    const d = data(row);
    const decision = d.ownerDecision;
    if (
      typeof d.assignmentRunId !== "string" ||
      !decision?.action ||
      Date.parse(decision.at) < since.valueOf() ||
      (decision.hiddenAt && !options.includeHidden)
    )
      continue;
    items.push({
      ...base(row),
      state:
        d.status === "rejected" ? ("rejected" as const) : ("archived" as const),
      decidedAt: String(decision.at),
      reason: typeof decision.reason === "string" ? decision.reason : null,
      archiveReason: d.archiveReason ?? null,
      hidden: Boolean(decision.hiddenAt),
      slotAt: d.scheduledAt ?? null,
    });
  }
  const seen = new Set<string>();
  for (const handoff of released) {
    const h = data(handoff);
    const content = releasedContent.get(String(h.contentId));
    if (!content || seen.has(content.id)) continue;
    seen.add(content.id);
    items.push({
      ...base(content),
      state: "released" as const,
      decidedAt: String(
        h.ownerReleasedAt ?? handoff.createdAt?.toISOString?.() ?? "",
      ),
      reason: null,
      archiveReason: null,
      hidden: false,
      slotAt: h.scheduledAt ?? h.slotAt ?? null,
      delivery: handoff.kind === "postiz_drafts" ? "postiz_draft" : "publish",
      handoffStatus: h.status ?? null,
    });
  }
  return items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

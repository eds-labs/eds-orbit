import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, list } from "../../shared.ts";
import { assignedPostizChannels } from "../postiz-assignment.ts";
import { confirmedHash, withinConfirmation } from "./agent-review.ts";
import { nextAssignmentRunAt } from "./assignment-runs.ts";
import { agentsEnabled, confirmedDelivery, deliveryOf } from "./assignments.ts";
import { localDate } from "./scheduling.ts";
import { assignmentMonthSpend } from "./specialists/runner.ts";
import { assignmentCardOf } from "./tools/assignment-tools.ts";
import { assignmentPost, draftDelivery, withdrawable } from "./veto.ts";

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postiz channel names of the project by channel ID, as the owner knows them. */
export async function channelNames(tx: DbTx, scope: Scope) {
  const names = new Map<string, string>();
  for (const row of await list(tx, scope, "connectors"))
    if (data(row).provider === "postiz")
      for (const channel of assignedPostizChannels(data(row)))
        names.set(String(channel.id), String(channel.name ?? channel.id));
  return names;
}
const namesOf = (channels: unknown, names: Map<string, string>) =>
  Object.fromEntries(
    (Array.isArray(channels) ? channels : [])
      .map(String)
      .filter((id) => names.has(id))
      .map((id) => [id, names.get(id)!]),
  );

async function rowsById(tx: DbTx, scope: Scope, kind: string, ids: unknown[]) {
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
  const items = [];
  for (const row of rows) {
    const d = data(row);
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
      // A paused project runs nothing, so no run is due.
      nextRunAt: project.paused
        ? null
        : ((
            await nextAssignmentRunAt(tx, scope, row, project.timezone, now)
          )?.toISOString() ?? null),
      monthCostMicros: await assignmentMonthSpend(tx, scope, row.id, now),
      monthlyBudgetMicros: Number(d.monthlyBudgetMicros ?? 0),
      actionRequestId:
        d.status === "draft" && data(request).status === "pending"
          ? request!.id
          : null,
    });
  }
  return { timezone: project.timezone, paused: project.paused, items };
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
  return [...rows.values()].map((row) => {
    const request = requests.get(String(data(row).actionRequestId));
    const r = data(request);
    return {
      ...assignmentCardOf(row),
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
  });
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
 * whose assignment's confirmation still covers them and whose run slot is
 * today or later (project time). Each comes with its run slot, a text
 * excerpt, whether the review agent approved it and the problems it found.
 * Earliest slot first. Empty while Orbit Agents is off.
 */
export async function draftsAwaitingOwner(tx: DbTx, scope: Scope) {
  if (!agentsEnabled()) return [];
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const today = localDate(new Date(), project.timezone);
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
      !d.supersededBy
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
      !Number.isFinite(Date.parse(slotAt)) ||
      localDate(new Date(slotAt), project.timezone) < today
    )
      continue;
    const text = String(d.body ?? "")
      .replace(/\s+/g, " ")
      .trim();
    items.push({
      id: row.id,
      version: row.version,
      channel: d.channel,
      channelName: names.get(String(d.channel)) ?? null,
      slotAt,
      excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text,
      assignmentId: d.assignmentId,
      assignmentName: data(assignment).name ?? null,
      // What the release does: schedule the post, or book a Postiz draft (R73).
      delivery: draftDelivery(
        d,
        confirmedDelivery(data(assignment)) ?? deliveryOf(data(assignment)),
      ),
      // The review agent approved the text; only its authority was missing.
      agentApproved: Boolean(d.agentReview),
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

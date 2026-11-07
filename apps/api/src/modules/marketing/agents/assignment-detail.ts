import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, entity, list } from "../../../shared.ts";
import { assignedPostizChannels } from "../publishing/postiz-assignment.ts";
import { accountForChannel } from "../../social/contract.ts";
import { channelNames, rowsById } from "./assignment-overview.ts";
import {
  nextAssignmentRunAt,
  runProblems,
  runRetryRefusal,
  runsMatching,
} from "./assignment-runs.ts";
import { approvalModeOf, deliveryOf, historyDaysOf } from "./assignments.ts";
import { slotExpired } from "./veto.ts";
import { assignmentMonthSpend } from "./specialists/runner.ts";

/**
 * Read model of one assignment for its detail view (G7): settings, the last
 * runs with their errors and, per deliverable (one text per channel and
 * slot), the state, the stored Social post link and the draft's image.
 * Reads stored data only: Marketing's publications carry the Social post id
 * (`remoteId`) and the permalink Social reported (`releaseUrl`), so nothing
 * here calls an external provider.
 */

const RUNS_SHOWN = 7;
const EXCERPT = 280;
const PUBLISHED = ["published", "published_test"];
const FAILED = ["failed", "blocked_dependency", "outcome_unknown"];
const INACTIVE = ["canceled", "failed", "blocked_dependency"];

export type DeliverableState =
  | "awaiting_release"
  | "expired"
  | "released"
  | "published"
  | "failed"
  | "canceled"
  | "dropped";

const excerptOf = (body: unknown) => {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
};

/** The platform of each channel reference ("unknown" when no account or Postiz channel names one). */
async function platformsOf(tx: DbTx, scope: Scope, channels: string[]) {
  const postiz = new Map<string, string>();
  for (const row of await list(tx, scope, "connectors"))
    if (data(row).provider === "postiz")
      for (const channel of assignedPostizChannels(data(row)))
        postiz.set(String(channel.id), String(channel.identifier ?? "unknown"));
  const platforms = new Map<string, string>();
  for (const channel of channels) {
    const account = await accountForChannel(tx, scope, channel);
    platforms.set(
      channel,
      account?.platform ?? postiz.get(channel) ?? "unknown",
    );
  }
  return platforms;
}

export async function assignmentDetail(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  now = new Date(),
) {
  const row = await entity(tx, scope, "assignments", assignmentId);
  const a = data(row);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const names = await channelNames(tx, scope);
  const channelIds = (Array.isArray(a.channels) ? a.channels : []).map(String);
  const platforms = await platformsOf(tx, scope, channelIds);
  const schedule = (a.schedule ?? {}) as Record<string, any>;
  const next = project.paused
    ? null
    : await nextAssignmentRunAt(tx, scope, row, project.timezone, now);

  // runsMatching answers newest first.
  const runs = (await runsMatching(tx, scope, { assignmentId })).slice(
    0,
    RUNS_SHOWN,
  );
  const runIds = new Set(runs.map((run) => run.id));
  const byAssignment = (kind: string) =>
    tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind,
        data: { path: ["assignmentId"], equals: assignmentId },
      },
      orderBy: { createdAt: "asc" },
    });
  const contents = (await byAssignment("content")).filter((content) =>
    runIds.has(String(data(content).assignmentRunId)),
  );
  const publications = await byAssignment("publications");
  const drafts = (await byAssignment("postiz_drafts")).filter(
    (handoff) => data(handoff).source === "assignment",
  );
  const missions = await rowsById(
    tx,
    scope,
    "missions",
    contents.map((content) => data(content).missionId),
  );
  // The handoff that stands for a content: an active one, else the latest.
  const handoffOf = (contentId: string) => {
    const own = [
      ...publications.filter((p) => data(p).contentId === contentId),
      ...drafts.filter((p) => data(p).contentId === contentId),
    ];
    return (
      own.find((p) => !INACTIVE.includes(data(p).status)) ?? own.at(-1) ?? null
    );
  };

  const outRuns = [];
  for (const run of runs) {
    const r = data(run);
    const problems = await runProblems(tx, scope, run);
    const dropped = new Set(
      ((r.scheduling?.dropped ?? []) as Array<{ contentId: string }>).map(
        (entry) => entry.contentId,
      ),
    );
    const deliverables = [];
    for (const content of contents.filter(
      (c) => data(c).assignmentRunId === run.id && data(c).type === "social",
    )) {
      const c = data(content);
      const handoff = handoffOf(content.id);
      const h = data(handoff);
      const isPublication = handoff?.kind === "publications";
      const slotAt = String(
        data(missions.get(String(c.missionId))).plannedSlotAt ??
          c.scheduledAt ??
          "",
      );
      const passed =
        Number.isFinite(Date.parse(slotAt)) &&
        slotExpired(new Date(slotAt), now);
      let state: DeliverableState;
      if (handoff && PUBLISHED.includes(h.status)) state = "published";
      else if (dropped.has(content.id)) state = "dropped";
      else if (handoff && FAILED.includes(h.status)) state = "failed";
      else if (handoff && h.status === "canceled") state = "canceled";
      else if (
        c.supersededBy ||
        ["archived", "rejected", "deleted"].includes(c.status)
      )
        state = "canceled";
      else if (handoff) state = "released";
      else if (c.status === "needs_review")
        state = passed ? "expired" : "awaiting_release";
      else state = "released";
      deliverables.push({
        contentId: content.id,
        channel: String(c.channel),
        channelName: names.get(String(c.channel)) ?? null,
        slotAt,
        excerpt: excerptOf(c.body),
        assetId: typeof c.assetId === "string" ? c.assetId : null,
        state,
        publication: handoff
          ? {
              id: handoff.id,
              status: String(h.status),
              permalink:
                isPublication && typeof h.releaseUrl === "string"
                  ? h.releaseUrl
                  : null,
              socialPostId:
                isPublication &&
                h.publishingBackend === "social" &&
                typeof h.remoteId === "string"
                  ? h.remoteId
                  : null,
              errorCode:
                state === "failed"
                  ? String(h.reason ?? h.error ?? h.blockers?.[0] ?? h.status)
                  : null,
            }
          : null,
      });
    }
    outRuns.push({
      id: run.id,
      date: String(r.date),
      status: String(r.status),
      createdAt: run.createdAt.toISOString(),
      // Failed steps, then slots that got no text (the code says why).
      errors: [
        ...problems.failed.map((f) => ({ step: f.stepKey, code: f.code })),
        ...problems.dropped.map((d) => ({
          step: `slot:${d.channel}`,
          code: d.code,
        })),
      ],
      retryable: !(await runRetryRefusal(tx, scope, run, now)),
      deliverables: deliverables.sort((x, y) =>
        x.slotAt.localeCompare(y.slotAt),
      ),
    });
  }

  return {
    assignment: {
      id: row.id,
      version: row.version,
      name: String(a.name ?? ""),
      status: String(a.status ?? ""),
      channels: channelIds.map((id) => ({
        id,
        name: names.get(id) ?? id,
        platform: platforms.get(id) ?? "unknown",
      })),
      schedule: {
        rhythm: String(schedule.rhythm ?? ""),
        times: Array.isArray(schedule.times) ? schedule.times.map(String) : [],
        leadMinutes: Number(schedule.leadMinutes ?? 360),
        timezone: project.timezone,
      },
      delivery: deliveryOf(a),
      approvalMode: approvalModeOf(a),
      image: a.creative
        ? ("creative" as const)
        : a.banner
          ? ("banner" as const)
          : a.image
            ? ("plain" as const)
            : ("none" as const),
      historyDays: historyDaysOf(a),
      monthlyBudgetMicros: Number(a.monthlyBudgetMicros ?? 0),
      monthSpentMicros: await assignmentMonthSpend(tx, scope, row.id, now),
    },
    nextRunAt: next?.toISOString() ?? null,
    runs: outRuns,
  };
}

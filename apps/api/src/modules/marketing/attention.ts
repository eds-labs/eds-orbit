import { operationFromEvidence } from "./agents/run-operation.ts";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
  AttentionStatusContribution,
} from "../../platform/attention/types.ts";
import { data } from "../../shared.ts";
import { can, PROJECT_OWN } from "../../platform/tenancy/permissions.ts";
import { budgetExhausted, RECENT_MS } from "./agents/agent-activity.ts";
import { draftsAwaitingOwner } from "./agents/assignment-overview.ts";
import { expiredDraftIds } from "./agents/draft-state.ts";
import { agentsEnabled } from "./agents/assignments.ts";
import { assignmentsMonthSpend } from "./agents/specialists/runner.ts";
import { moduleSectionLink } from "../../platform/management/links.ts";
import { activePolicyRecord } from "../../platform/ai/spend-mandate.ts";
import {
  approvalLane,
  baseContentId,
  isPausedPost,
  OPEN_REVIEW_STATUSES,
  type LaneHandoff,
} from "./approval-state.ts";

// The marketing module's attention items (UI restructure §4.1): what waits on
// the approvals page, plus failed runs. Params carry names, codes and times
// only: never a post body or an excerpt.

/** The publishing rules section of the settings center. */
export const marketingPolicyLink = (projectId: string) =>
  moduleSectionLink(projectId, "marketing", "policy");

const APPROVALS = { navKey: "approvals", link: "/approvals" } as const;

/** Open exceptions and paused posts read per request (one open exception per code). */
const EXCEPTION_LIMIT = 100;
const PAUSED_POST_LIMIT = 500;
/** Active assignments checked for an exhausted budget, as the overview lists them. */
const ASSIGNMENT_LIMIT = 100;

type Draft = Awaited<ReturnType<typeof draftsAwaitingOwner>>[number];

/**
 * The owner's drafts of assignments, one item per original (the owner
 * releases them): a Facebook/Instagram pair of copies (R76) is one thing to
 * decide, so it counts once; the page keeps one release button per channel.
 */
function draftItems(drafts: Draft[]): AttentionItem[] {
  // `drafts` holds pending drafts only: an expired one can no longer be
  // released (D-2), so it has no item and the content review leaves it out.
  const groups = new Map<string, Draft[]>();
  for (const draft of drafts)
    groups.set(draft.baseId, [...(groups.get(draft.baseId) ?? []), draft]);
  return [...groups.entries()].map(([baseId, group]) => {
    const first = [...group].sort((a, b) =>
      a.slotAt.localeCompare(b.slotAt),
    )[0]!;
    // The original's channel first, then its copies'.
    const ordered = [...group].sort(
      (a, b) => Number(a.id !== baseId) - Number(b.id !== baseId),
    );
    const channels = [
      ...new Set(
        ordered.map((d) => String(d.channelName ?? "")).filter(Boolean),
      ),
    ];
    return {
      id: `marketing:draft:${baseId}`,
      moduleId: "marketing",
      kind: "marketing_draft_release",
      severity: "warning",
      dueAt: first.slotAt,
      params: {
        assignmentName: String(first.assignmentName ?? ""),
        channelName: channels.join(" · "),
        slotAt: first.slotAt,
      },
      ...APPROVALS,
    };
  });
}

/** Content waiting for a review read per request (open statuses only). */
const REVIEW_LIMIT = 1000;

/**
 * Content that still waits for someone, as one aggregated item: the rows in
 * an open review status whose approval lane is `open`. Reviewed content is
 * never counted (released, scheduled and published posts are reviewed), nor
 * a row a live publication or Postiz draft holds, an assignment draft whose
 * slot passed (D-2) or one that was replaced. A draft with its own release
 * item is not counted again, and channel copies count once with their
 * original (R76).
 */
async function contentReviewItems(
  tx: DbTx,
  scope: Scope,
  drafts: Draft[],
  now: Date,
): Promise<AttentionItem[]> {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      OR: OPEN_REVIEW_STATUSES.map((status) => ({
        data: { path: ["status"], equals: status },
      })),
    },
    select: { id: true, data: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: REVIEW_LIMIT,
  });
  if (!rows.length) return [];
  const expired = await expiredDraftIds(tx, scope, rows, now);
  // The publications and Postiz drafts of these rows, in one bounded read.
  const handoffs = new Map<string, LaneHandoff[]>();
  for (const row of await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: { in: ["publications", "postiz_drafts"] },
      OR: rows.map((row) => ({
        data: { path: ["contentId"], equals: row.id },
      })),
    },
    select: { kind: true, data: true },
  })) {
    const id = String(data(row).contentId);
    handoffs.set(id, [
      ...(handoffs.get(id) ?? []),
      {
        kind: row.kind === "publications" ? "publication" : "postiz_draft",
        status: data(row).status,
      },
    ]);
  }
  const releasing = new Set(drafts.map((draft) => draft.id));
  const releasedBases = new Set(drafts.map((draft) => draft.baseId));
  const waiting = new Map<string, Date>();
  for (const row of rows) {
    if (releasing.has(row.id)) continue;
    const lane = approvalLane(data(row), {
      handoffs: handoffs.get(row.id),
      expired: expired.has(row.id),
    });
    const base = baseContentId(row);
    if (lane !== "open" || releasedBases.has(base)) continue;
    const since = waiting.get(base);
    if (!since || row.createdAt < since) waiting.set(base, row.createdAt);
  }
  if (!waiting.size) return [];
  const since = [...waiting.values()].reduce((a, b) => (b < a ? b : a));
  return [
    {
      id: "marketing:content-review",
      moduleId: "marketing",
      kind: "marketing_content_review",
      severity: "warning",
      count: waiting.size,
      since: since.toISOString(),
      params: {},
      ...APPROVALS,
    },
  ];
}

/**
 * One item per open exception code; an unknown outcome of a paid call is
 * critical. Each is one thing to act on (R19): the number of resources it
 * affects is a param, not a badge count.
 */
async function exceptionItems(
  tx: DbTx,
  scope: Scope,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  // Only the open ones: resolved exceptions stay as history and keep growing.
  const open = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "exceptions",
      data: { path: ["status"], equals: "open" },
    },
    orderBy: { createdAt: "desc" },
    take: EXCEPTION_LIMIT,
  });
  const seen = new Set<string>();
  for (const row of open) {
    const d = data(row);
    if (typeof d.code !== "string" || seen.has(d.code)) continue;
    seen.add(d.code);
    const affected = Array.isArray(d.resourceIds) ? d.resourceIds.length : 0;
    items.push({
      id: `marketing:exception:${d.code}`,
      moduleId: "marketing",
      kind: "marketing_exception",
      severity: d.code.endsWith("_OUTCOME_UNKNOWN") ? "critical" : "warning",
      since: row.createdAt.toISOString(),
      params: { code: d.code, affected },
      ...APPROVALS,
    });
  }
  return items;
}

/** The posts a project pause stopped, as one aggregated item due with the first slot. */
async function pausedPostItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  const blocked = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["status"], equals: "blocked_dependency" } },
        { data: { path: ["reason"], equals: "PROJECT_PAUSED" } },
      ],
    },
    // The newest first; isPausedPost below keeps the ones still ahead.
    orderBy: { createdAt: "desc" },
    take: PAUSED_POST_LIMIT,
  });
  const slots = blocked
    .map((row) => data(row))
    .filter((publication) => isPausedPost(publication, now))
    .map((publication) => new Date(String(publication.scheduledAt)))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!slots.length) return [];
  return [
    {
      id: "marketing:paused-posts",
      moduleId: "marketing",
      kind: "marketing_paused_posts",
      severity: "warning",
      count: slots.length,
      dueAt: slots[0]!.toISOString(),
      params: {},
      ...APPROVALS,
    },
  ];
}

/**
 * Failed runs and exhausted assignment budgets: the `RUN_FAILED` and
 * `BUDGET_EXHAUSTED` health issues of the agent activity, read on their own
 * (R21) with the same rules, in at most five bounded queries.
 */
async function runProblemItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  if (!agentsEnabled()) return [];
  // Runs that failed within the last day (the overview reads its 50 newest
  // runs; a day holds far fewer).
  const recent = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assignment_runs",
      updatedAt: { gte: new Date(now.getTime() - RECENT_MS) },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  // One bounded batch for all recent runs; no per-run task/delivery queries.
  const evidence = recent.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: { in: ["agent_tasks", "publications", "postiz_drafts"] },
          OR: recent.flatMap((r) => [
            { data: { path: ["runId"], equals: r.id } },
            { data: { path: ["assignmentRunId"], equals: r.id } },
          ]),
        },
        orderBy: { createdAt: "asc" },
        take: 10001,
      })
    : [];
  const counts = { failed: 0, outcome_unknown: 0, degraded: 0 };
  for (const run of recent) {
    // A run the owner retried (G6) is replaced by its new run, not open.
    if (data(run).retiredAt) continue;
    const tasks = evidence
      .filter((r) => r.kind === "agent_tasks" && data(r).runId === run.id)
      .map((r) => ({
        id: r.id,
        status: String(data(r).status),
        stepKey: String(data(r).stepKey),
        errorCode: data(r).errorCode,
      }));
    const deliveries = evidence
      .filter(
        (r) => r.kind !== "agent_tasks" && data(r).assignmentRunId === run.id,
      )
      .map((r) => ({
        publicationStatus: data(r).status,
        outcome:
          r.kind === "postiz_drafts" && data(r).status === "outcome_unknown"
            ? "postiz_draft_unknown"
            : data(r).status === "failed"
              ? "failed"
              : data(r).status === "blocked_dependency"
                ? "blocked"
                : "handed_over",
      }));
    const operation = operationFromEvidence(
      data(run),
      tasks.slice(0, 100),
      deliveries,
      {
        settledMicros: 0,
        heldMicros: 0,
        unknownMicros: 0,
        releasedMicros: 0,
        complete: tasks.length <= 100 && evidence.length <= 10000,
      },
      scope.projectId,
    );
    if (operation.state in counts)
      counts[operation.state as keyof typeof counts]++;
  }
  const budgeted = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assignments",
        data: { path: ["status"], equals: "active" },
      },
      select: { id: true, data: true },
      orderBy: { createdAt: "desc" },
      take: ASSIGNMENT_LIMIT,
    })
  )
    .map((row) => ({
      id: row.id,
      status: data(row).status,
      monthlyBudgetMicros: Number(data(row).monthlyBudgetMicros ?? 0),
    }))
    .filter((item) => item.monthlyBudgetMicros > 0);
  const spend = await assignmentsMonthSpend(
    tx,
    scope,
    budgeted.map((item) => item.id),
    now,
  );
  const exhausted = budgeted.filter((item) =>
    budgetExhausted({ ...item, monthCostMicros: spend.get(item.id) ?? 0 }),
  ).length;
  return (
    [
      ["RUN_FAILED", counts.failed],
      ["RUN_OUTCOME_UNKNOWN", counts.outcome_unknown],
      ["RUN_DEGRADED", counts.degraded],
      ["BUDGET_EXHAUSTED", exhausted],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({
      id: `marketing:run-problem:${code}`,
      moduleId: "marketing",
      kind: "marketing_run_problem",
      severity: code === "RUN_DEGRADED" ? "warning" : "critical",
      count,
      params: { code },
      navKey: "marketing-overview",
      link: "/marketing",
    }));
}

/** The owner is warned this long before the active policy ends. */
const EXPIRY_WARNING_MS = 7 * 86_400_000;

/** The active policy, when it ends within a week and has not ended yet. */
async function policyExpiryItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  if (!can(scope, PROJECT_OWN)) return [];
  const policy = await activePolicyRecord(tx, scope);
  if (!policy) return [];
  const endAt = data(policy).endAt;
  const end = typeof endAt === "string" ? Date.parse(endAt) : Number.NaN;
  if (
    Number.isNaN(end) ||
    end <= now.getTime() ||
    end - now.getTime() > EXPIRY_WARNING_MS
  )
    return [];
  return [
    {
      id: `marketing:policy-expiring:${policy.id}`,
      moduleId: "marketing",
      kind: "marketing_policy_expiring",
      severity: "warning",
      dueAt: endAt as string,
      params: { endAt: endAt as string },
      navKey: "operations",
      link: marketingPolicyLink(scope.projectId),
    },
  ];
}

export const marketingAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => {
  // One read of the owner's drafts: their items, and what the content
  // review leaves out (a non-owner releases none, so it counts them).
  const drafts =
    agentsEnabled() && can(scope, PROJECT_OWN)
      ? await draftsAwaitingOwner(tx, scope)
      : [];
  const reports =
    agentsEnabled() && can(scope, PROJECT_OWN)
      ? await tx.entity.findMany({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "marketing_reports",
            data: { path: ["status"], equals: "ready" },
          },
          orderBy: { updatedAt: "desc" },
          take: 100,
        })
      : [];
  return [
    ...reports
      .filter((r) => data(r).acknowledgedRevision !== data(r).revision)
      .map((r) => ({
        id: `marketing:report:${r.id}`,
        moduleId: "marketing",
        kind: "marketing_report_ready",
        severity: "info" as const,
        params: {
          from: String(data(r).period.from),
          to: String(data(r).period.to),
          revision: Number(data(r).revision),
          noData: Boolean(data(r).noData),
        },
        navKey: "analytics",
        link: `/marketing/analytics?report=${r.id}`,
      })),
    ...draftItems(drafts),
    ...(await contentReviewItems(tx, scope, drafts, now)),
    ...(await exceptionItems(tx, scope)),
    ...(await pausedPostItems(tx, scope, now)),
    ...(await runProblemItems(tx, scope, now)),
    ...(await policyExpiryItems(tx, scope, now)),
  ];
};

/**
 * The project's mode for the home page's status strip, as the marketing
 * overview's mode band shows it (GET /dashboard `project.mode`; ruling R25):
 * activating a policy sets it, so a policy's own mode is not read here.
 */
export const marketingAttentionStatus: AttentionStatusContribution = async (
  tx,
  scope,
) => {
  const project = await tx.project.findUnique({
    where: { id: scope.projectId },
    select: { mode: true },
  });
  return project ? { mode: project.mode } : {};
};

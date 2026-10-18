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
import { agentsEnabled } from "./agents/assignments.ts";
import { assignmentsMonthSpend } from "./agents/specialists/runner.ts";
import { APPROVAL_STATUSES, isPausedPost } from "./approval-state.ts";
import { activePolicy } from "./policy/policy.ts";

// The marketing module's attention items (UI restructure §4.1): what waits on
// the approvals page, plus failed runs. Params carry names, codes and times
// only: never a post body or an excerpt.

const APPROVALS = { navKey: "approvals", link: "/approvals" } as const;

/** Open exceptions and paused posts read per request (one open exception per code). */
const EXCEPTION_LIMIT = 100;
const PAUSED_POST_LIMIT = 500;
/** Active assignments checked for an exhausted budget, as the overview lists them. */
const ASSIGNMENT_LIMIT = 100;

type Draft = Awaited<ReturnType<typeof draftsAwaitingOwner>>[number];

/** The owner's drafts of assignments, one item each (the owner releases them). */
function draftItems(drafts: Draft[]): AttentionItem[] {
  return drafts.map((draft) => ({
    id: `marketing:draft:${draft.id}`,
    moduleId: "marketing",
    kind: "marketing_draft_release",
    severity: "warning",
    dueAt: draft.slotAt,
    params: {
      assignmentName: String(draft.assignmentName ?? ""),
      channelName: String(draft.channelName ?? ""),
      slotAt: draft.slotAt,
    },
    ...APPROVALS,
  }));
}

/**
 * Content in a status the approvals page lists, as one aggregated item. A
 * draft that has its own release item is not counted again.
 */
async function contentReviewItems(
  tx: DbTx,
  scope: Scope,
  drafted: number,
): Promise<AttentionItem[]> {
  const waiting = await tx.entity.aggregate({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      OR: APPROVAL_STATUSES.map((status) => ({
        data: { path: ["status"], equals: status },
      })),
    },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  const count = waiting._count._all - drafted;
  if (count <= 0) return [];
  return [
    {
      id: "marketing:content-review",
      moduleId: "marketing",
      kind: "marketing_content_review",
      severity: "warning",
      count,
      ...(waiting._min.createdAt
        ? { since: waiting._min.createdAt.toISOString() }
        : {}),
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
 * (R21) with the same rules, in four bounded queries.
 */
async function runProblemItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  if (!agentsEnabled()) return [];
  // Runs that failed within the last day (the overview reads its 50 newest
  // runs; a day holds far fewer).
  const failed = await tx.entity.count({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assignment_runs",
      data: { path: ["status"], equals: "failed" },
      updatedAt: { gte: new Date(now.getTime() - RECENT_MS) },
    },
  });
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
      ["RUN_FAILED", failed],
      ["BUDGET_EXHAUSTED", exhausted],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({
      id: `marketing:run-problem:${code}`,
      moduleId: "marketing",
      kind: "marketing_run_problem",
      severity: "critical",
      count,
      params: { code },
      navKey: "marketing-overview",
      link: "/marketing",
    }));
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
  return [
    ...draftItems(drafts),
    ...(await contentReviewItems(tx, scope, drafts.length)),
    ...(await exceptionItems(tx, scope)),
    ...(await pausedPostItems(tx, scope, now)),
    ...(await runProblemItems(tx, scope, now)),
  ];
};

/** The active policy's mode for the home page's status strip; none without one. */
export const marketingAttentionStatus: AttentionStatusContribution = async (
  tx,
  scope,
) => {
  const mode = data(await activePolicy(tx, scope)).mode;
  return typeof mode === "string" ? { mode } : {};
};

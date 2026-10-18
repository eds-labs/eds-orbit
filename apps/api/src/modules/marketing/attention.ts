import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
} from "../../platform/attention/types.ts";
import { data } from "../../shared.ts";
import { can, PROJECT_OWN } from "../../platform/tenancy/permissions.ts";
import { agentActivity } from "./agents/agent-activity.ts";
import { draftsAwaitingOwner } from "./agents/assignment-overview.ts";
import { agentsEnabled } from "./agents/assignments.ts";
import { APPROVAL_STATUSES, isPausedPost } from "./approval-state.ts";

// The marketing module's attention items (UI restructure §4.1): what waits on
// the approvals page, plus failed runs. Params carry names, codes and times
// only: never a post body or an excerpt.

const APPROVALS = { navKey: "approvals", link: "/approvals" } as const;

/** Open exceptions and paused posts read per request (one open exception per code). */
const EXCEPTION_LIMIT = 100;
const PAUSED_POST_LIMIT = 500;

/** Health issues of the agent activity that are a problem to act on now. */
const RUN_PROBLEM_CODES = ["RUN_FAILED", "BUDGET_EXHAUSTED"];

/** The owner's drafts of assignments, one item each (the owner releases them). */
async function draftItems(tx: DbTx, scope: Scope): Promise<AttentionItem[]> {
  if (!agentsEnabled() || !can(scope, PROJECT_OWN)) return [];
  return (await draftsAwaitingOwner(tx, scope)).map((draft) => ({
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

/** One item per open exception code; an unknown outcome of a paid call is critical. */
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
    const resources = Array.isArray(d.resourceIds) ? d.resourceIds.length : 0;
    items.push({
      id: `marketing:exception:${d.code}`,
      moduleId: "marketing",
      kind: "marketing_exception",
      severity: d.code.endsWith("_OUTCOME_UNKNOWN") ? "critical" : "warning",
      count: Math.max(1, resources),
      since: row.createdAt.toISOString(),
      params: { code: d.code },
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

/** Failed runs and exhausted assignment budgets, from the agent activity's health. */
async function runProblemItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  if (!agentsEnabled()) return [];
  const { health } = await agentActivity(tx, scope, now);
  return health.issues
    .filter((issue) => RUN_PROBLEM_CODES.includes(issue.code))
    .map((issue) => ({
      id: `marketing:run-problem:${issue.code}`,
      moduleId: "marketing",
      kind: "marketing_run_problem",
      severity: "critical",
      count: issue.count,
      params: { code: issue.code },
      navKey: "marketing-overview",
      link: "/marketing",
    }));
}

export const marketingAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => {
  const drafts = await draftItems(tx, scope);
  return [
    ...drafts,
    ...(await contentReviewItems(tx, scope, drafts.length)),
    ...(await exceptionItems(tx, scope)),
    ...(await pausedPostItems(tx, scope, now)),
    ...(await runProblemItems(tx, scope, now)),
  ];
};

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data } from "../../shared.ts";
import {
  channelNames,
  draftsAwaitingOwner,
  listAssignments,
  upcomingAssignmentPosts,
} from "./assignment-overview.ts";
import {
  TERMINAL_RUN,
  type RunStatus,
  type StepRole,
  type StepStatus,
  type WorkStep,
} from "./assignment-runs.ts";

/**
 * The agent activity read model for the overview: the runs the specialists
 * work on right now (or the last one), each step with its live task state,
 * what comes next (run starts, slots, drafts waiting for the owner) and a
 * health summary. Read only, like assignment-overview.ts.
 */

// Runs shown at once: the open ones first, else the most recent one.
const MAX_RUNS = 3;
// Failed and partial runs count as a problem for this long.
const RECENT_MS = 24 * 3600000;
const MAX_NEXT = 6;

// Same mapping as startReadySteps: an unknown paid outcome counts as failed.
const TASK_TO_STEP: Record<string, StepStatus> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  canceled: "canceled",
  outcome_unknown: "failed",
};

export type ActivityStep = {
  key: string;
  role: StepRole;
  status: StepStatus;
  dependsOn: string[];
  optionalDependsOn: string[];
  errorCode: string | null;
  channel: string | null;
  channelName: string | null;
};
export type ActivityRun = {
  id: string;
  assignmentId: string;
  assignmentName: string | null;
  date: string;
  status: RunStatus;
  plannedAt: string | null;
  updatedAt: string;
  firstSlotAt: string | null;
  costMicros: number;
  ceilingMicros: number;
  delivery: "publish" | "postiz_draft";
  steps: ActivityStep[];
};
export type NextItem = {
  kind: "run_start" | "post" | "postiz_draft" | "owner_release";
  at: string;
  assignmentName: string | null;
  channelName: string | null;
  status: string | null;
};
export type HealthIssue = {
  code:
    | "PROJECT_PAUSED"
    | "RUN_FAILED"
    | "RUN_PARTIAL"
    | "DRAFTS_AWAIT_RELEASE"
    | "POSTS_BLOCKED"
    | "DRAFT_HANDOFF_UNCLEAR"
    | "BUDGET_EXHAUSTED";
  severity: "warning" | "problem";
  count: number;
};

export function healthState(paused: boolean, issues: HealthIssue[]) {
  if (paused) return "paused" as const;
  if (issues.some((issue) => issue.severity === "problem"))
    return "problem" as const;
  return issues.length ? ("attention" as const) : ("ok" as const);
}

export async function agentActivity(tx: DbTx, scope: Scope, now = new Date()) {
  const assignments = await listAssignments(tx, scope, now);
  const byId = new Map(assignments.items.map((item) => [item.id, item]));
  const names = await channelNames(tx, scope);
  const recent = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assignment_runs",
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const open = recent.filter((row) => !TERMINAL_RUN.includes(data(row).status));
  const shown = (open.length ? open : recent).slice(0, MAX_RUNS);
  const tasks = shown.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "agent_tasks",
          OR: shown.map((row) => ({
            data: { path: ["runId"], equals: row.id },
          })),
        },
      })
    : [];
  const taskById = new Map(tasks.map((task) => [task.id, data(task)]));
  const runs: ActivityRun[] = shown.map((row) => {
    const d = data(row);
    const terminal = TERMINAL_RUN.includes(d.status);
    const steps = ((d.steps ?? []) as WorkStep[]).map((step) => {
      const task = step.taskId ? taskById.get(step.taskId) : undefined;
      const live = task ? TASK_TO_STEP[String(task.status)] : undefined;
      // A finished run's steps are settled as stored; an open run's tasks may be ahead of it.
      const status = terminal ? step.status : (live ?? step.status);
      const channel = step.key.startsWith("copywriter:")
        ? step.key.slice("copywriter:".length)
        : null;
      return {
        key: step.key,
        role: step.role,
        status,
        dependsOn: step.dependsOn ?? [],
        optionalDependsOn: step.optionalDependsOn ?? [],
        errorCode: task?.errorCode ?? null,
        channel,
        channelName: channel ? (names.get(channel) ?? null) : null,
      };
    });
    const slots = ((d.slots ?? []) as Array<{ at?: unknown }>)
      .map((slot) => String(slot.at ?? ""))
      .filter((at) => Number.isFinite(Date.parse(at)))
      .sort();
    const assignment = byId.get(String(d.assignmentId));
    return {
      id: row.id,
      assignmentId: String(d.assignmentId),
      assignmentName: (assignment?.name as string | undefined) ?? null,
      date: String(d.date ?? ""),
      status: d.status,
      plannedAt: d.plannedAt ?? null,
      updatedAt: row.updatedAt.toISOString(),
      firstSlotAt: slots[0] ?? null,
      costMicros: Number(d.costMicros ?? 0),
      ceilingMicros: Number(d.ceilingMicros ?? 0),
      delivery:
        assignment?.delivery === "postiz_draft" ? "postiz_draft" : "publish",
      steps,
    };
  });

  const posts = await upcomingAssignmentPosts(tx, scope);
  const drafts = await draftsAwaitingOwner(tx, scope);
  const next: NextItem[] = [
    ...assignments.items
      .filter((item) => item.nextRunAt)
      .map((item) => ({
        kind: "run_start" as const,
        at: item.nextRunAt!,
        assignmentName: (item.name as string | undefined) ?? null,
        channelName: null,
        status: null,
      })),
    ...posts.map((post) => ({
      kind:
        post.delivery === "postiz_draft"
          ? ("postiz_draft" as const)
          : ("post" as const),
      at: String(post.scheduledAt),
      assignmentName: post.assignmentName as string | null,
      channelName: post.channelName,
      status: String(post.status),
    })),
    ...drafts.map((draft) => ({
      kind: "owner_release" as const,
      at: draft.slotAt,
      assignmentName: draft.assignmentName as string | null,
      channelName: draft.channelName,
      status: "needs_review",
    })),
  ]
    .filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, MAX_NEXT);

  const since = now.getTime() - RECENT_MS;
  const ended = (status: RunStatus) =>
    recent.filter(
      (row) => data(row).status === status && row.updatedAt.getTime() >= since,
    ).length;
  const issues: HealthIssue[] = [];
  const add = (
    code: HealthIssue["code"],
    severity: HealthIssue["severity"],
    count: number,
  ) => {
    if (count > 0) issues.push({ code, severity, count });
  };
  add("PROJECT_PAUSED", "warning", assignments.paused ? 1 : 0);
  add("RUN_FAILED", "problem", ended("failed"));
  add("RUN_PARTIAL", "warning", ended("partial"));
  add("DRAFTS_AWAIT_RELEASE", "warning", drafts.length);
  add(
    "POSTS_BLOCKED",
    "warning",
    posts.filter((post) => post.status === "blocked_dependency").length,
  );
  add(
    "DRAFT_HANDOFF_UNCLEAR",
    "warning",
    posts.filter((post) => post.status === "outcome_unknown").length,
  );
  add(
    "BUDGET_EXHAUSTED",
    "warning",
    assignments.items.filter(
      (item) =>
        item.status === "active" &&
        item.monthlyBudgetMicros > 0 &&
        item.monthCostMicros >= item.monthlyBudgetMicros,
    ).length,
  );

  return {
    timezone: assignments.timezone,
    paused: assignments.paused,
    activeAssignments: assignments.items.filter(
      (item) => item.status === "active",
    ).length,
    health: { state: healthState(assignments.paused, issues), issues },
    runs,
    next,
  };
}

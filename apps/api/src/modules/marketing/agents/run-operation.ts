import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";
import { isOptionalStep, type WorkStep } from "./assignment-runs.ts";
import { reservationPrefixes } from "./specialists/runner.ts";

/** Read-only evidence; recovery links never bypass existing mutation guards. */
export async function runOperation(
  tx: DbTx,
  scope: Scope,
  run: { id: string; data: unknown },
  deliverables: Array<Record<string, unknown>>,
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "agent_tasks",
      data: { path: ["runId"], equals: run.id },
    },
    orderBy: { createdAt: "asc" },
    take: 101,
  });
  const complete = rows.length <= 100;
  const tasks = rows.slice(0, 100).map((row) => ({
    id: row.id,
    status: String(data(row).status),
    errorCode: data(row).errorCode,
    stepKey: String(data(row).stepKey),
  }));
  const costs = {
    settledMicros: 0,
    heldMicros: 0,
    unknownMicros: 0,
    releasedMicros: 0,
    complete,
  };
  let unknownReservation = false;
  // Aggregate in SQL: no unbounded reservation rows loaded into the process.
  if (tasks.length) {
    const totals = await tx.budgetReservation.groupBy({
      by: ["state"],
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        OR: tasks.flatMap((task) =>
          reservationPrefixes(scope, task.id).map((prefix) => ({
            key: { startsWith: prefix },
          })),
        ),
      },
      _sum: { amountMicros: true, settledMicros: true },
    });
    for (const r of totals) {
      if (r.state === "settled")
        costs.settledMicros += Number(r._sum.settledMicros ?? 0);
      else if (r.state === "unknown") {
        unknownReservation = true;
        costs.unknownMicros += Number(r._sum.amountMicros ?? 0);
      } else if (r.state === "released")
        costs.releasedMicros += Number(r._sum.amountMicros ?? 0);
      else costs.heldMicros += Number(r._sum.amountMicros ?? 0);
    }
  }
  return operationFromEvidence(
    data(run),
    tasks,
    deliverables,
    costs,
    unknownReservation,
  );
}

type TaskEvidence = {
  id: string;
  status: string;
  stepKey: string;
  errorCode?: unknown;
};
type Costs = {
  settledMicros: number;
  heldMicros: number;
  unknownMicros: number;
  releasedMicros: number;
  complete: boolean;
};
/** Same state rules for bounded batch attention reads and detailed ledger views. */
export function operationFromEvidence(
  d: Record<string, any>,
  tasks: TaskEvidence[],
  deliverables: Array<Record<string, unknown>>,
  costs: Costs,
  unknownReservation = false,
) {
  const complete = costs.complete;
  const steps = (Array.isArray(d.steps) ? d.steps : []).map((s: WorkStep) => ({
    ...s,
    dependsOn: s.dependsOn ?? [],
    optionalDependsOn: s.optionalDependsOn ?? [],
  })) as WorkStep[];
  const issues = tasks
    .filter(
      (t) =>
        ["failed", "outcome_unknown", "blocked_dependency"].includes(
          t.status,
        ) || t.errorCode,
    )
    .map((t) => ({
      taskId: t.id,
      stepKey: String(t.stepKey),
      status: String(t.status),
      code: String(t.errorCode ?? t.status),
      optional: isOptionalStep(steps, t.stepKey),
    }));
  const unknown =
    !complete ||
    unknownReservation ||
    tasks.some((t) => t.status === "outcome_unknown") ||
    deliverables.some(
      (item) =>
        item.outcome === "postiz_draft_unknown" ||
        ["outcome_unknown", "reconciliation_required"].includes(
          String(item.publicationStatus),
        ),
    );
  const failed =
    issues.some(
      (i) => !i.optional && ["failed", "blocked_dependency"].includes(i.status),
    ) ||
    steps.some((s) => s.status === "failed" && !isOptionalStep(steps, s.key)) ||
    deliverables.some((i) =>
      ["failed", "postiz_draft_failed"].includes(String(i.outcome)),
    );
  const blocked =
    issues.some((i) => i.code === "ASSIGNMENT_REVIEW_BACKLOG_FULL") ||
    deliverables.some((i) => i.outcome === "blocked");
  const degraded =
    issues.some((i) => i.optional) ||
    steps.some(
      (s) =>
        ["failed", "skipped"].includes(s.status) &&
        isOptionalStep(steps, s.key),
    ) ||
    deliverables.some((i) => i.outcome === "dropped") ||
    (Array.isArray(d.unavailable) && d.unavailable.length > 0);
  const state = unknown
    ? "outcome_unknown"
    : d.status === "canceled"
      ? "canceled"
      : failed || d.status === "failed"
        ? "failed"
        : blocked
          ? "blocked"
          : deliverables.some((i) => i.outcome === "awaiting_owner")
            ? "awaiting_owner"
            : degraded
              ? "degraded"
              : String(d.status);
  const recovery: Array<{ action: string; href: string }> = [];
  const add = (action: string, href: string) => {
    if (!recovery.some((r) => r.action === action))
      recovery.push({ action, href });
  };
  if (unknown)
    add(
      "reconcile_outcome",
      deliverables.some((i) => i.outcome === "postiz_draft_unknown")
        ? "/marketing/content"
        : "/operations",
    );
  if (
    issues.some((i) => i.code === "ASSIGNMENT_REVIEW_BACKLOG_FULL") ||
    deliverables.some((i) => i.outcome === "awaiting_owner")
  )
    add("review_content", "/approvals");
  if (deliverables.some((i) => i.outcome === "blocked"))
    add("inspect_delivery", "/approvals");
  if (failed || degraded) add("inspect_run", "/operations");
  if (issues.some((i) => i.code === "PROJECT_PAUSED"))
    add("resume_project", "/settings");
  return {
    state,
    lifecycle: String(d.status),
    degraded: Boolean(degraded),
    complete,
    costs,
    issues,
    recovery,
  };
}

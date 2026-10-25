import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { EventSubscription } from "../../../platform/events/types.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { notifyMembers } from "../../../platform/notifications/members.ts";
import { audit, DomainError } from "../../../shared.ts";
import { assignableIds, fromDate, uuid, workDomainEvent } from "../common.ts";
import { pmActive } from "../gate.ts";
import { readWorkSettings } from "../settings.ts";
import { projectToday } from "./context.ts";
import { PM_ORIGIN, PM_QUEUE, pmActor } from "./planner.ts";
import { evaluateRules, stateHash, type RuleFinding, type Snapshot } from "./rules.ts";
import { getPmState } from "./state.ts";
import { requestAnalysis } from "./analyst.ts";
import { scheduleReports } from "./reporter.ts";

// Monitoring (ADR 0017 P-6, plan §2.5): rule scans of initiatives the PM
// watches, woken by task, milestone and initiative events (at most one
// scan per initiative and five minutes) and once a day. Scans cost
// nothing; a newly critical finding notifies the initiative's owner and the
// configured people and becomes an attention item. Escalation never
// changes work data.

const SCAN_BUCKET_MS = 5 * 60_000;
const DAY = 86_400_000;

export type FindingRow = Awaited<ReturnType<DbTx["workPmFinding"]["findFirstOrThrow"]>>;

export function findingView(row: FindingRow) {
  return {
    id: row.id,
    initiativeId: row.initiativeId,
    rule: row.rule,
    severity: row.severity,
    taskIds: row.taskIds,
    milestoneId: row.milestoneId,
    status: row.status,
    dismissedUntil: row.dismissedUntil?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    data: row.data as Record<string, unknown>,
  };
}

/** The initiative's state as the rules read it. */
export async function pmSnapshot(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  now = new Date(),
): Promise<Snapshot> {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { timezone: true },
  });
  const { settings } = await readWorkSettings(tx, scope);
  const tasks = await tx.workTask.findMany({
    where: { projectId: scope.projectId, initiativeId, archivedAt: null },
    select: {
      id: true,
      number: true,
      statusCategory: true,
      priority: true,
      dueDate: true,
      assigneeUserId: true,
      milestoneId: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
    take: 2000,
  });
  const ids = tasks.map((t) => t.id);
  const [statusChanges, activity, dependencies, milestones, plan] = await Promise.all([
    tx.workEvent.groupBy({
      by: ["taskId"],
      where: { projectId: scope.projectId, taskId: { in: ids }, type: "status" },
      _max: { createdAt: true },
    }),
    tx.workEvent.groupBy({
      by: ["taskId"],
      where: { projectId: scope.projectId, taskId: { in: ids } },
      _max: { createdAt: true },
    }),
    tx.workTaskDependency.findMany({
      where: { projectId: scope.projectId, taskId: { in: ids } },
      select: { taskId: true, dependsOnTaskId: true },
    }),
    tx.workMilestone.findMany({
      where: { projectId: scope.projectId, initiativeId, archivedAt: null },
      select: { id: true, dueDate: true, status: true },
    }),
    tx.workPlanProposal.findFirst({
      where: { projectId: scope.projectId, initiativeId, status: "applied", kind: "new_plan" },
      orderBy: { appliedAt: "desc" },
      select: { appliedAt: true, appliedTaskIds: true },
    }),
  ]);
  const since = new Map(statusChanges.map((g) => [g.taskId, g._max.createdAt]));
  const last = new Map(activity.map((g) => [g.taskId, g._max.createdAt]));
  return {
    initiativeId,
    today: projectToday(project.timezone, now),
    now,
    dueSoonDays: settings.notifications.dueSoonDays,
    tasks: tasks.map((t) => ({
      id: t.id,
      number: t.number,
      statusCategory: t.statusCategory,
      priority: t.priority,
      dueDate: fromDate(t.dueDate),
      assigneeUserId: t.assigneeUserId,
      milestoneId: t.milestoneId,
      createdAt: t.createdAt,
      categorySince: since.get(t.id) ?? t.createdAt,
      lastActivityAt: last.get(t.id) ?? t.updatedAt,
      completedAt: t.completedAt,
    })),
    dependencies,
    milestones: milestones.map((m) => ({ id: m.id, dueDate: fromDate(m.dueDate), status: m.status })),
    plan: plan?.appliedAt ? { appliedAt: plan.appliedAt, tasks: plan.appliedTaskIds.length } : null,
  };
}

/** Notifies the initiative's owner and its escalation list about critical findings. */
async function escalate(tx: DbTx, scope: Scope, initiativeId: string, critical: readonly FindingRow[]) {
  if (!critical.length) return;
  const initiative = await tx.workInitiative.findFirstOrThrow({
    where: { projectId: scope.projectId, id: initiativeId },
    select: { ownerUserId: true, key: true },
  });
  const state = await getPmState(tx, scope, initiativeId);
  const allowed = await assignableIds(scope);
  const to = [initiative.ownerUserId, ...state.settings.escalateTo].filter(
    (u): u is string => !!u && allowed.has(u),
  );
  if (to.length)
    await notifyMembers(tx, scope, {
      kind: "work_pm_escalation",
      userIds: [...new Set(to)],
      title: `${initiative.key}: ${critical.length} critical finding${critical.length > 1 ? "s" : ""}`,
      body: critical.map((f) => f.rule).join(", "),
      link: `/p/${scope.projectId}/work/initiatives?initiative=${initiativeId}`,
    });
  await audit(tx, scope, "work.pm.escalated", initiativeId, {
    findings: critical.length,
    notified: to.length,
  });
}

/**
 * Runs the rules for one initiative and brings its findings up to date:
 * new conditions open a finding, gone ones resolve it, a dismissal ends
 * when its time is over. Returns what changed.
 */
export async function scanInitiative(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  now = new Date(),
) {
  const snapshot = await pmSnapshot(tx, scope, initiativeId, now);
  const found = evaluateRules(snapshot);
  const active = await tx.workPmFinding.findMany({
    where: { projectId: scope.projectId, initiativeId, status: { in: ["open", "dismissed"] } },
  });
  const byPrint = new Map(active.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();
  const opened: FindingRow[] = [];
  const nowCritical: FindingRow[] = [];
  for (const finding of found) {
    seen.add(finding.fingerprint);
    const existing = byPrint.get(finding.fingerprint);
    const common = {
      severity: finding.severity,
      taskIds: finding.taskIds,
      milestoneId: finding.milestoneId,
      data: finding.data as Prisma.InputJsonValue,
      lastSeenAt: now,
    };
    if (!existing) {
      const row = await tx.workPmFinding.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          initiativeId,
          rule: finding.rule,
          fingerprint: finding.fingerprint,
          firstSeenAt: now,
          ...common,
        },
      });
      opened.push(row);
      if (row.severity === "critical") nowCritical.push(row);
      continue;
    }
    const reopen =
      existing.status === "dismissed" && existing.dismissedUntil !== null && existing.dismissedUntil <= now;
    const row = await tx.workPmFinding.update({
      where: { id: existing.id },
      data: { ...common, ...(reopen ? { status: "open", dismissedUntil: null, dismissedBy: null } : {}) },
    });
    if (reopen) opened.push(row);
    if (
      row.status === "open" &&
      row.severity === "critical" &&
      (reopen || existing.severity !== "critical")
    )
      nowCritical.push(row);
  }
  const gone = active.filter((f) => !seen.has(f.fingerprint));
  if (gone.length)
    await tx.workPmFinding.updateMany({
      where: { id: { in: gone.map((f) => f.id) } },
      data: { status: "resolved", resolvedAt: now },
    });
  const hash = stateHash(snapshot, found);
  await tx.workPmState.updateMany({
    where: { projectId: scope.projectId, initiativeId },
    data: { lastScanAt: now, lastScanHash: hash },
  });
  for (const row of opened)
    await workDomainEvent(tx, scope, "work.pm.finding.opened", { type: "work.initiative", id: initiativeId }, pmActor, {
      findingId: row.id,
      rule: row.rule,
      severity: row.severity,
    });
  for (const row of gone)
    await workDomainEvent(tx, scope, "work.pm.finding.resolved", { type: "work.initiative", id: initiativeId }, pmActor, {
      findingId: row.id,
      rule: row.rule,
    });
  await escalate(tx, scope, initiativeId, nowCritical);
  // A new critical finding asks the analyst, at most once per day.
  if (nowCritical.length) await requestAnalysis(tx, scope, initiativeId, { automatic: true }, now);
  return { opened: opened.length, resolved: gone.length, critical: nowCritical, stateHash: hash, findings: found };
}

/** Scans one initiative when the PM may run and watches it. */
export async function runScanJob(workerScope: Scope, initiativeId: string, now = new Date()) {
  return scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    if (!(await pmActive(tx, workerScope))) return null;
    const state = await tx.workPmState.findFirst({
      where: { projectId: workerScope.projectId, initiativeId },
      select: { enabled: true },
    });
    if (!state?.enabled) return null;
    return scanInitiative(tx, workerScope, initiativeId, now);
  });
}

/** Queues one scan per initiative and five-minute bucket, after the bucket. */
export function queueScan(tx: DbTx, scope: Scope, initiativeId: string, now = new Date()) {
  const bucket = Math.floor(now.getTime() / SCAN_BUCKET_MS);
  return enqueue(
    tx,
    scope,
    PM_QUEUE,
    initiativeId,
    `work_pm:scan:${initiativeId}:${bucket}`,
    new Date((bucket + 1) * SCAN_BUCKET_MS + 30_000),
    { kind: "scan" },
  );
}

/** The initiative an event concerns, or null. */
async function initiativeOfEvent(tx: DbTx, scope: Scope, subject: { type: string; id: string }) {
  if (subject.type === "work.initiative") return subject.id;
  if (subject.type === "work.task")
    return (
      await tx.workTask.findFirst({
        where: { projectId: scope.projectId, id: subject.id },
        select: { initiativeId: true },
      })
    )?.initiativeId ?? null;
  if (subject.type === "work.milestone")
    return (
      await tx.workMilestone.findFirst({
        where: { projectId: scope.projectId, id: subject.id },
        select: { initiativeId: true },
      })
    )?.initiativeId ?? null;
  return null;
}

/**
 * The monitor's subscriber. Its name is the PM's origin, so the platform
 * never queues it for the PM's own writes.
 */
export const pmMonitorSubscriber: EventSubscription = {
  name: PM_ORIGIN,
  types: ["work.task.*", "work.milestone.*", "work.initiative.updated", "work.initiative.restored"],
  async handler(tx, scope, event) {
    if (!(await pmActive(tx, scope))) return;
    const initiativeId = await initiativeOfEvent(tx, scope, event.subject);
    if (!initiativeId) return;
    const state = await tx.workPmState.findFirst({
      where: { projectId: scope.projectId, initiativeId },
      select: { enabled: true },
    });
    if (state?.enabled) await queueScan(tx, scope, initiativeId);
  },
};

const nextDaily = new Map<string, number>();
/** Tests only: forget the daily throttle. */
export function resetPmDailyThrottle() {
  nextDaily.clear();
}

/** Daily: scans every watched initiative (overdue depends on time passing). */
export const pmDailyScan: PeriodicTask = {
  name: "work-pm-daily",
  async nextDueAt(tx, scope) {
    if (!(await pmActive(tx, scope))) return null;
    const any = await tx.workPmState.findFirst({
      where: { projectId: scope.projectId, enabled: true },
      select: { id: true },
    });
    if (!any) return null;
    return new Date(Math.max(Date.now(), nextDaily.get(scope.projectId) ?? 0));
  },
  async run(scope) {
    const now = new Date();
    if (now.getTime() < (nextDaily.get(scope.projectId) ?? 0)) return { status: "idle" };
    // 05:30 UTC the next day, before the due notices.
    const day = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
    const wakeAt = new Date(day + DAY + 5.5 * 3_600_000);
    nextDaily.set(scope.projectId, wakeAt.getTime());
    const scanned = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!(await pmActive(tx, scope))) return 0;
      const states = await tx.workPmState.findMany({
        where: { projectId: scope.projectId, enabled: true },
        select: { initiativeId: true },
      });
      for (const state of states) await scanInitiative(tx, scope, state.initiativeId, now);
      await scheduleReports(tx, scope, now);
      return states.length;
    });
    return { status: scanned ? `scanned ${scanned}` : "idle", wakeAt };
  },
};

export async function listFindings(
  tx: DbTx,
  scope: Scope,
  filter: { initiativeId?: string; status?: "open" | "resolved" | "dismissed" },
) {
  const rows = await tx.workPmFinding.findMany({
    where: {
      projectId: scope.projectId,
      ...(filter.initiativeId ? { initiativeId: filter.initiativeId } : {}),
      status: filter.status ?? "open",
    },
    orderBy: [{ lastSeenAt: "desc" }],
    take: 200,
  });
  const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
  return rows.sort((a, b) => rank[a.severity]! - rank[b.severity]!).map(findingView);
}

export const dismissInput = z
  .object({ until: z.iso.datetime().nullable().optional() })
  .strict();

/** Dismisses an open finding until a time, or until its condition clears. */
export async function dismissFinding(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const input = dismissInput.parse(raw ?? {});
  const row = await tx.workPmFinding.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  if (row.status !== "open") throw new DomainError("WORK_FINDING_NOT_OPEN", 409);
  const until = input.until ? new Date(input.until) : null;
  if (until && until.getTime() <= Date.now()) throw new DomainError("WORK_DISMISS_UNTIL_PAST", 422);
  const updated = await tx.workPmFinding.update({
    where: { id: row.id },
    data: { status: "dismissed", dismissedBy: scope.userId, dismissedUntil: until },
  });
  await audit(tx, scope, "work.pm.finding_dismissed", row.id, { rule: row.rule, until: input.until ?? null });
  return findingView(updated);
}

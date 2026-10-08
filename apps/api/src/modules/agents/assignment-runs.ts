import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, entity, list, update } from "../../shared.ts";
import { activePolicy } from "../policy.ts";
import { zonedTime } from "../posting-slots.ts";
import { enqueue } from "../workflow.ts";
import { agentsEnabled } from "./assignments.ts";
import { localDate, slotContext, slotStatus } from "./scheduling.ts";
import type { HeldSlot, SlotContext } from "./scheduling.ts";

/**
 * Runs of assignments (Orbit Agents). A run is one due execution of an active
 * assignment for a local date: it holds the slots it was given, a work plan of
 * specialist steps and the cost. It is created once per assignment and date
 * (`assignment:<id>:<date>`) at `firstSlot - leadMinutes` (weekly: the day
 * before at the same local time) and keeps the assignment version it started
 * with. Slots come from the same rules as every other post (daily quota,
 * spacing, quiet hours, calendar blocks) and count against package posts,
 * publications and other runs; the specialists themselves run in the worker
 * (`agent` queue) and report back through `startReadySteps`.
 */
export type StepRole =
  "analytics" | "research" | "strategy" | "copywriter" | "visual" | "review";
export type StepStatus =
  "pending" | "queued" | "running" | "done" | "failed" | "skipped";
export type RunStatus =
  "planned" | "running" | "done" | "partial" | "failed" | "canceled";
export type WorkStep = {
  key: string;
  role: StepRole;
  dependsOn: string[];
  taskId: string | null;
  status: StepStatus;
  ceilingMicros: number;
};

export const SLOT_UNAVAILABLE = "SLOT_UNAVAILABLE";

const RUNS = "assignment_runs";
const TASKS = "agent_tasks";
// Weekly runs start a day ahead, daily ones up to three days (the longest lead) plus a day.
const LOOKAHEAD_DAYS = 9;
// A taken time moves forward in steps of this size within the same local day.
const SLOT_STEP_MS = 30 * 60000;
const TERMINAL_RUN: RunStatus[] = ["done", "partial", "failed", "canceled"];
// Share of a run's cost ceiling per step; several copywriters each get their own share.
const WEIGHT: Record<StepRole, number> = {
  analytics: 10,
  research: 20,
  strategy: 15,
  copywriter: 20,
  visual: 20,
  review: 15,
};

/** Runs a month at most, to spread the monthly budget over the runs of a rhythm. */
function runsPerMonth(schedule: Record<string, any>) {
  if (schedule.rhythm === "daily") return 30;
  if (schedule.rhythm === "weekly")
    return Math.max(1, Math.ceil(((schedule.weekdays?.length ?? 1) * 52) / 12));
  return 1;
}

/** The specialist steps of one run of an assignment, with cost ceilings that add up to the run's budget share. */
export function buildWorkPlan(assignment: Record<string, any>): WorkStep[] {
  const step = (
    key: string,
    role: StepRole,
    dependsOn: string[] = [],
  ): WorkStep => ({
    key,
    role,
    dependsOn,
    taskId: null,
    status: "pending",
    ceilingMicros: 0,
  });
  const channels = (assignment.channels ?? []) as string[];
  let steps: WorkStep[];
  if (assignment.contentType === "report") {
    // A report goes to the owner only: figures, no research, no post.
    steps = [step("analytics", "analytics")];
  } else if (assignment.contentType === "social") {
    const copy = channels.map((channel) =>
      step(`copywriter:${channel}`, "copywriter", ["strategy"]),
    );
    const visual = assignment.image
      ? [step("visual", "visual", ["strategy"])]
      : [];
    steps = [
      step("analytics", "analytics"),
      step("research", "research"),
      step("strategy", "strategy", ["analytics", "research"]),
      ...copy,
      ...visual,
      step(
        "review",
        "review",
        [...copy, ...visual].map((s) => s.key),
      ),
    ];
  } else {
    steps = [
      step("research", "research"),
      step("strategy", "strategy", ["research"]),
      step("copywriter", "copywriter", ["strategy"]),
      step("review", "review", ["copywriter"]),
    ];
  }
  const runCeiling = Math.floor(
    Number(assignment.monthlyBudgetMicros ?? 0) /
      runsPerMonth(assignment.schedule ?? {}),
  );
  const total = steps.reduce((sum, s) => sum + WEIGHT[s.role], 0);
  for (const s of steps)
    s.ceilingMicros = Math.floor((runCeiling * WEIGHT[s.role]) / total);
  // The rounding remainder goes to the last step so the ceilings add up exactly.
  steps[steps.length - 1]!.ceilingMicros +=
    runCeiling - steps.reduce((sum, s) => sum + s.ceilingMicros, 0);
  return steps;
}

type Due = {
  date: string;
  // Requested local slot times of the day, ascending.
  slots: Date[];
  createAt: Date;
};

/** The days of a schedule that have, or soon get, a run: their date, requested slots and creation time. */
function dueDays(
  schedule: Record<string, any>,
  timezone: string,
  now: Date,
): Due[] {
  const [y, m, d] = localDate(now, timezone).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const days =
    schedule.rhythm === "once"
      ? [new Date(`${schedule.date}T00:00:00Z`)]
      : Array.from(
          { length: LOOKAHEAD_DAYS },
          (_, offset) => new Date(Date.UTC(y, m - 1, d + offset)),
        );
  const times = schedule.times as string[];
  const at = (day: Date, time: string, shift = 0) => {
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    return zonedTime(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate() + shift,
      hh,
      mm,
      timezone,
    );
  };
  const due: Due[] = [];
  for (const day of days) {
    if (
      schedule.rhythm === "weekly" &&
      !(schedule.weekdays as number[]).includes(day.getUTCDay())
    )
      continue;
    const slots = times.map((time) => at(day, time));
    const createAt =
      schedule.rhythm === "weekly"
        ? at(day, times[0]!, -1)
        : new Date(slots[0]!.valueOf() - Number(schedule.leadMinutes) * 60000);
    due.push({ date: day.toISOString().slice(0, 10), slots, createAt });
  }
  return due;
}

type JsonFilter = { path: string[] } & Record<string, unknown>;
/** Entities of a kind narrowed by JSON fields in the database, never by loading the whole kind. */
function filtered(
  tx: DbTx,
  scope: Scope,
  kind: string,
  filters: JsonFilter[],
  order: "asc" | "desc" = "desc",
) {
  return tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      AND: filters.map((filter) => ({ data: filter as any })),
    },
    orderBy: { createdAt: order },
  });
}

/** Runs narrowed by assignment, local date, date range or month; used by the chat tools. */
export function runsMatching(
  tx: DbTx,
  scope: Scope,
  where: {
    assignmentId?: string;
    date?: string;
    dateFrom?: string;
    monthPrefix?: string;
  },
) {
  const filters: JsonFilter[] = [];
  if (where.assignmentId)
    filters.push({ path: ["assignmentId"], equals: where.assignmentId });
  if (where.date) filters.push({ path: ["date"], equals: where.date });
  if (where.dateFrom) filters.push({ path: ["date"], gte: where.dateFrom });
  if (where.monthPrefix)
    filters.push({ path: ["date"], string_starts_with: where.monthPrefix });
  return filtered(tx, scope, RUNS, filters);
}

const activeAssignments = (tx: DbTx, scope: Scope) =>
  filtered(
    tx,
    scope,
    "assignments",
    [{ path: ["status"], equals: "active" }],
    "asc",
  );

async function plannedDates(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  from: string,
) {
  return new Set(
    (await runsMatching(tx, scope, { assignmentId, dateFrom: from })).map(
      (row) => String(data(row).date),
    ),
  );
}

/**
 * The first free slot at or after the requested time on the same local day:
 * quota, spacing and blocks as for any post, counting `held` (chosen by this
 * run) too. A time that has already passed is not moved.
 */
async function freeSlot(
  ctx: SlotContext,
  channel: string,
  requested: Date,
  date: string,
  held: HeldSlot[],
) {
  if (requested <= ctx.now) return null;
  for (
    let candidate = requested;
    localDate(candidate, ctx.timezone) === date;
    candidate = new Date(candidate.valueOf() + SLOT_STEP_MS)
  ) {
    const status = await slotStatus(ctx, channel, candidate, held);
    // Preflight has its own lead; here only the veto window of the run matters, and the run is created ahead of it.
    if (status.reasons.every((reason) => reason === "TOO_SOON"))
      return candidate;
  }
  return null;
}

async function allocateSlots(
  tx: DbTx,
  scope: Scope,
  due: Due,
  channels: string[],
  now: Date,
) {
  const ctx = await slotContext(tx, scope, now);
  const slots: HeldSlot[] = [];
  const unavailable: Array<{
    channel: string;
    requestedAt: string;
    code: typeof SLOT_UNAVAILABLE;
  }> = [];
  for (const requested of due.slots)
    for (const channel of channels) {
      const found = await freeSlot(ctx, channel, requested, due.date, slots);
      if (found) slots.push({ channel, at: found.toISOString() });
      else
        unavailable.push({
          channel,
          requestedAt: requested.toISOString(),
          code: SLOT_UNAVAILABLE,
        });
    }
  return { slots, unavailable };
}

/**
 * Creates the runs that are due: one per active assignment and local date,
 * with their slots and work plan, and starts the first steps. Idempotent.
 */
export async function planAssignmentRuns(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
) {
  if (!agentsEnabled()) return { created: 0 };
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return { created: 0 };
  const assignments = await activeAssignments(tx, scope);
  if (!assignments.length) return { created: 0 };
  const policy = await activePolicy(tx, scope);
  const today = localDate(now, project.timezone);
  let created = 0;
  for (const row of assignments) {
    const d = data(row);
    const known = await plannedDates(tx, scope, row.id, today);
    for (const due of dueDays(d.schedule, project.timezone, now)) {
      if (
        known.has(due.date) ||
        due.createAt > now ||
        due.slots[due.slots.length - 1]! <= now
      )
        continue;
      const report = d.contentType === "report";
      // Posts need a policy for their rules; without one nothing can be planned.
      if (!report && !policy) continue;
      const allocation = report
        ? { slots: [], unavailable: [] }
        : await allocateSlots(tx, scope, due, d.channels, now);
      const key = `assignment:${row.id}:${due.date}`;
      const saved = await create(tx, scope, RUNS, {
        assignmentId: row.id,
        // The run works with the assignment as it was confirmed when it started.
        assignmentVersion: row.version,
        assignmentHash: d.confirmation?.assignmentHash ?? null,
        idempotencyKey: key,
        date: due.date,
        status: "planned",
        ...allocation,
        steps: buildWorkPlan(d),
        costMicros: 0,
        plannedAt: now.toISOString(),
      });
      await audit(tx, scope, "assignment.run_planned", saved.id, {
        assignmentId: row.id,
        date: due.date,
        slots: allocation.slots.length,
        unavailable: allocation.unavailable.length,
      });
      await startReadySteps(tx, scope, saved.id);
      created++;
    }
  }
  return { created };
}

/**
 * Earliest future time at which a run becomes due, so the sweep wakes up for
 * it without any other write; null when nothing is pending.
 */
export async function nextAssignmentPlanAt(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
) {
  if (!agentsEnabled()) return null;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return null;
  const today = localDate(now, project.timezone);
  let next: Date | null = null;
  for (const row of await activeAssignments(tx, scope)) {
    const known = await plannedDates(tx, scope, row.id, today);
    for (const due of dueDays(data(row).schedule, project.timezone, now))
      if (
        !known.has(due.date) &&
        due.createAt > now &&
        (!next || due.createAt < next)
      )
        next = due.createAt;
  }
  return next;
}

const TASK_TO_STEP: Record<string, StepStatus> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  // A paid call of unknown outcome is never repeated: the step counts as failed.
  outcome_unknown: "failed",
};
const SETTLED: StepStatus[] = ["done", "failed", "skipped"];

/**
 * Brings a run up to date with its tasks and starts what can start: a step
 * whose dependencies are all done gets an `agent_tasks` row and an `agent`
 * job (`agent:<taskId>`); a step behind a failed one is skipped, the run goes
 * on without that deliverable. The run ends `done`, `partial` or `failed`
 * when no step is left. Safe to call repeatedly.
 */
export async function startReadySteps(tx: DbTx, scope: Scope, runId: string) {
  const row = await entity(tx, scope, RUNS, runId);
  const d = data(row);
  if (TERMINAL_RUN.includes(d.status)) return row;
  const tasks = new Map(
    (
      await filtered(tx, scope, TASKS, [{ path: ["runId"], equals: runId }])
    ).map((task) => [task.id, task]),
  );
  const steps: WorkStep[] = (d.steps as WorkStep[]).map((step) => {
    const task = step.taskId ? tasks.get(step.taskId) : undefined;
    const mapped = task ? TASK_TO_STEP[String(data(task).status)] : undefined;
    return { ...step, status: mapped ?? step.status };
  });
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const deps = (step: WorkStep) => step.dependsOn.map((key) => byKey.get(key)!);
  for (let changed = true; changed;) {
    changed = false;
    for (const step of steps)
      if (
        step.status === "pending" &&
        deps(step).some(
          (dep) => dep.status === "failed" || dep.status === "skipped",
        )
      ) {
        step.status = "skipped";
        changed = true;
      }
  }
  for (const step of steps) {
    if (
      step.status !== "pending" ||
      !deps(step).every((s) => s.status === "done")
    )
      continue;
    const task = await create(tx, scope, TASKS, {
      runId,
      stepKey: step.key,
      role: step.role,
      assignmentId: d.assignmentId,
      assignmentVersion: d.assignmentVersion,
      ceilingMicros: step.ceilingMicros,
      input: null,
      output: null,
      status: "queued",
      errorCode: null,
      costMicros: 0,
    });
    await enqueue(tx, scope, "agent", task.id, `agent:${task.id}`);
    step.taskId = task.id;
    step.status = "queued";
  }
  const settled = steps.every((step) => SETTLED.includes(step.status));
  const done = steps.filter((step) => step.status === "done").length;
  const status: RunStatus = settled
    ? done === steps.length
      ? "done"
      : done
        ? "partial"
        : "failed"
    : steps.some((step) => step.status !== "pending")
      ? "running"
      : "planned";
  const costMicros = [...tasks.values()].reduce(
    (sum, task) => sum + Number(data(task).costMicros ?? 0),
    0,
  );
  if (
    status === d.status &&
    costMicros === d.costMicros &&
    JSON.stringify(steps) === JSON.stringify(d.steps)
  )
    return row;
  return update(tx, scope, row, { ...d, steps, status, costMicros });
}

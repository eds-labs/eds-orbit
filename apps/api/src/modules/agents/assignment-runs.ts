import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, entity, list, update } from "../../shared.ts";
import { activePolicy } from "../policy.ts";
import { zonedTime } from "../posting-slots.ts";
import { enqueue } from "../workflow.ts";
import { agentsEnabled } from "./assignments.ts";
import { notify } from "./notifications.ts";
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
  "pending" | "queued" | "running" | "done" | "failed" | "skipped" | "canceled";
export type RunStatus =
  "planned" | "running" | "done" | "partial" | "failed" | "canceled";
export type WorkStep = {
  key: string;
  role: StepRole;
  // Every input of the step, hard and optional.
  dependsOn: string[];
  // The inputs among `dependsOn` the step can do without: it starts once they
  // are settled (done or not), with whatever exists.
  optionalDependsOn: string[];
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
export const SLOT_STEP_MS = 30 * 60000;
export const TERMINAL_RUN: RunStatus[] = [
  "done",
  "partial",
  "failed",
  "canceled",
];
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
    optionalDependsOn: string[] = [],
  ): WorkStep => ({
    key,
    role,
    dependsOn: [...dependsOn, ...optionalDependsOn],
    optionalDependsOn,
    taskId: null,
    status: "pending",
    ceilingMicros: 0,
  });
  const channels = (assignment.channels ?? []) as string[];
  let steps: WorkStep[];
  if (assignment.contentType === "report") {
    // A report goes to the owner only: figures, no research, no post.
    steps = [step("analytics", "analytics")];
  } else {
    const social = assignment.contentType === "social";
    const copy = social
      ? channels.map((channel) =>
          step(`copywriter:${channel}`, "copywriter", ["strategy"]),
        )
      : [step("copywriter", "copywriter", ["strategy"])];
    // One image per run, reusable across channels.
    const visual = assignment.image
      ? [step("visual", "visual", ["strategy"])]
      : [];
    steps = [
      // Figures and research feed the strategy but never block it.
      ...(social ? [step("analytics", "analytics")] : []),
      step("research", "research"),
      step(
        "strategy",
        "strategy",
        [],
        social ? ["analytics", "research"] : ["research"],
      ),
      ...copy,
      ...visual,
      step(
        "review",
        "review",
        [...copy, ...visual].map((s) => s.key),
      ),
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
  // A canceled run (assignment paused or ended) leaves its date open for a resumed assignment.
  return new Set(
    (await runsMatching(tx, scope, { assignmentId, dateFrom: from }))
      .filter((row) => data(row).status !== "canceled")
      .map((row) => String(data(row).date)),
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
    // Nothing delivers a report yet (R71): a report confirmed before reports
    // were refused plans no paid run and sends no notice.
    if (d.contentType === "report") continue;
    // Posts need a policy for their rules; without one nothing can be planned.
    if (!policy) continue;
    const known = await plannedDates(tx, scope, row.id, today);
    for (const due of dueDays(d.schedule, project.timezone, now)) {
      if (
        known.has(due.date) ||
        due.createAt > now ||
        due.slots[due.slots.length - 1]! <= now
      )
        continue;
      const allocation = await allocateSlots(tx, scope, due, d.channels, now);
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
      // A deliverable without a slot is dropped with a notice (spec §9); one per run.
      if (allocation.unavailable.length)
        await notify(tx, scope, "slots_unavailable", saved.id);
      await startReadySteps(tx, scope, saved.id);
      created++;
    }
  }
  return { created };
}

/**
 * Earliest future time at which a run of this assignment becomes due (its
 * preparation start), or null when it has none pending: not active, paused
 * project, or every due day already has a run.
 */
export async function nextAssignmentRunAt(
  tx: DbTx,
  scope: Scope,
  row: { id: string; data: unknown },
  timezone: string,
  now = new Date(),
) {
  // A report plans no run (R71).
  if (data(row).status !== "active" || data(row).contentType === "report")
    return null;
  const known = await plannedDates(tx, scope, row.id, localDate(now, timezone));
  let next: Date | null = null;
  for (const due of dueDays(data(row).schedule, timezone, now))
    if (
      !known.has(due.date) &&
      due.createAt > now &&
      (!next || due.createAt < next)
    )
      next = due.createAt;
  return next;
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
  let next: Date | null = null;
  for (const row of await activeAssignments(tx, scope)) {
    const due = await nextAssignmentRunAt(
      tx,
      scope,
      row,
      project.timezone,
      now,
    );
    if (due && (!next || due < next)) next = due;
  }
  return next;
}

const TASK_TO_STEP: Record<string, StepStatus> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  canceled: "canceled",
  // A paid call of unknown outcome is never repeated: the step counts as failed.
  outcome_unknown: "failed",
};
const SETTLED: StepStatus[] = ["done", "failed", "skipped", "canceled"];

/** Serializes everything that changes one run (parallel task completions, cancellation). */
const lockRun = (tx: DbTx, scope: Scope, runId: string) =>
  tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${runId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;

/**
 * Brings a run up to date with its tasks and starts what can start. A step
 * is ready when its hard dependencies are done and its optional ones
 * (`optionalDependsOn`, e.g. analytics and research for the strategy) are
 * settled; it then gets an `agent_tasks` row and an `agent` job
 * (`agent:<taskId>`). A step behind a failed or skipped hard dependency is
 * skipped: only that deliverable drops, the rest of the run goes on. The run
 * ends `done`, `partial` or `failed` when no step is left. The run row is
 * locked first, so parallel task completions of one run are processed one
 * after the other; calling again is safe.
 */
export async function startReadySteps(tx: DbTx, scope: Scope, runId: string) {
  await lockRun(tx, scope, runId);
  const row = await entity(tx, scope, RUNS, runId);
  const d = data(row);
  const tasks = new Map(
    (
      await filtered(tx, scope, TASKS, [{ path: ["runId"], equals: runId }])
    ).map((task) => [task.id, task]),
  );
  const costMicros = [...tasks.values()].reduce(
    (sum, task) => sum + Number(data(task).costMicros ?? 0),
    0,
  );
  if (TERMINAL_RUN.includes(d.status))
    // A task that settled after its run ended (e.g. canceled) still adds its cost.
    return costMicros === d.costMicros
      ? row
      : update(tx, scope, row, { ...d, costMicros });
  const steps: WorkStep[] = (d.steps as WorkStep[]).map((step) => {
    const task = step.taskId ? tasks.get(step.taskId) : undefined;
    const mapped = task ? TASK_TO_STEP[String(data(task).status)] : undefined;
    // Runs planned before optional inputs existed have no `optionalDependsOn`.
    return {
      ...step,
      optionalDependsOn: step.optionalDependsOn ?? [],
      status: mapped ?? step.status,
    };
  });
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const hard = (step: WorkStep) =>
    step.dependsOn
      .filter((key) => !step.optionalDependsOn.includes(key))
      .map((key) => byKey.get(key)!);
  const optional = (step: WorkStep) =>
    step.optionalDependsOn.map((key) => byKey.get(key)!);
  for (let changed = true; changed;) {
    changed = false;
    for (const step of steps)
      if (
        step.status === "pending" &&
        hard(step).some(
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
      !hard(step).every((dep) => dep.status === "done") ||
      !optional(step).every((dep) => SETTLED.includes(dep.status))
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
  if (
    status === d.status &&
    costMicros === d.costMicros &&
    JSON.stringify(steps) === JSON.stringify(d.steps)
  )
    return row;
  // A run that ends with its review done is scheduled afterwards in its own
  // transaction (veto.ts scheduleFinishedRun, R54).
  const saved = await update(tx, scope, row, {
    ...d,
    steps,
    status,
    costMicros,
  });
  if (TERMINAL_RUN.includes(status)) {
    await completeOneOff(tx, scope, d.assignmentId, runId);
    await reportRunProblems(tx, scope, saved);
  }
  return saved;
}

// Codes with a notice of their own (budget pause, project pause) or none at all (flag off).
const REPORTED_ELSEWHERE = [
  "ASSIGNMENT_BUDGET_EXHAUSTED",
  "PROJECT_PAUSED",
  "AGENTS_DISABLED",
];

export type RunProblems = {
  // Steps whose task ended failed or outcome_unknown, with the task's code.
  failed: Array<{ stepKey: string; role: StepRole; code: string }>;
  // Slots the strategy left without a brief and briefs a copywriter could not write.
  dropped: Array<{ channel: string; slotAt: string; code: string }>;
  // Steps that never ran because a step they need failed.
  skipped: string[];
};

/** `<channel>@<ISO slot>` (copywriter.ts `briefKey`) back into its parts. */
function splitBriefKey(key: string) {
  const at = key.lastIndexOf("@");
  return at < 0
    ? { channel: key, slotAt: "" }
    : { channel: key.slice(0, at), slotAt: key.slice(at + 1) };
}

/**
 * What went wrong in a run, read from its steps and their tasks (I4): failed
 * or `outcome_unknown` tasks (with their code), the slots the strategy left
 * uncovered (with the code of the brief it dropped for that slot, else
 * `NO_BRIEF`), briefs a copywriter could not write (e.g. `FACT_NOT_USABLE`,
 * spec §11 "missing facts") and skipped steps. Budget exhaustion and the
 * project pause are left out: they have notices of their own.
 */
export async function runProblems(
  tx: DbTx,
  scope: Scope,
  run: { id: string; data: unknown },
): Promise<RunProblems> {
  const tasks = new Map(
    (
      await filtered(tx, scope, TASKS, [{ path: ["runId"], equals: run.id }])
    ).map((task) => [task.id, data(task)]),
  );
  const problems: RunProblems = { failed: [], dropped: [], skipped: [] };
  for (const step of (data(run).steps ?? []) as WorkStep[]) {
    if (step.status === "skipped") problems.skipped.push(step.key);
    const task = step.taskId ? tasks.get(step.taskId) : undefined;
    if (!task) continue;
    if (["failed", "outcome_unknown"].includes(task.status)) {
      const code = String(
        task.errorCode ??
          (task.status === "outcome_unknown"
            ? "AGENT_OUTCOME_UNKNOWN"
            : "AGENT_FAILED"),
      );
      if (!REPORTED_ELSEWHERE.includes(code))
        problems.failed.push({ stepKey: step.key, role: step.role, code });
      continue;
    }
    if (task.status !== "done") continue;
    const output = (task.output ?? {}) as Record<string, any>;
    if (step.role === "strategy")
      for (const slot of (output.uncovered ?? []) as Array<
        Record<string, any>
      >) {
        const reason = (
          (output.dropped ?? []) as Array<Record<string, any>>
        ).find(
          (entry) =>
            entry.channel === slot.channel &&
            Date.parse(entry.slotAt) === Date.parse(slot.slotAt),
        );
        problems.dropped.push({
          channel: String(slot.channel),
          slotAt: String(slot.slotAt),
          code: String(reason?.code ?? "NO_BRIEF"),
        });
      }
    if (step.role === "copywriter")
      for (const entry of (output.failed ?? []) as Array<Record<string, any>>)
        if (!REPORTED_ELSEWHERE.includes(String(entry.code)))
          problems.dropped.push({
            ...splitBriefKey(String(entry.briefKey)),
            code: String(entry.code),
          });
  }
  return problems;
}

/**
 * Reports a run that ended with problems: one `run_problem` notice per run
 * (key `notify:run_problem:<runId>`, the run ends once) and the audit
 * `assignment.run_problems` with the counts the daily report adds up. Runs
 * in the transaction that ends the run. A no-op with Orbit Agents off.
 */
async function reportRunProblems(
  tx: DbTx,
  scope: Scope,
  run: { id: string; data: unknown },
) {
  if (!agentsEnabled()) return;
  const problems = await runProblems(tx, scope, run);
  if (!problems.failed.length && !problems.dropped.length) return;
  await audit(tx, scope, "assignment.run_problems", run.id, {
    runId: run.id,
    assignmentId: data(run).assignmentId,
    failedSteps: problems.failed.length,
    droppedDeliverables: problems.dropped.length,
    skippedSteps: problems.skipped.length,
  });
  await notify(tx, scope, "run_problem", run.id);
}

/**
 * Ends a one-off assignment whose single run is over (M2), so it no longer
 * holds its monthly budget share. It ends as `completed` (`completedAt`):
 * unlike an end by a person, its runs and scheduled posts stay, and its
 * confirmation still covers the posts of that run (agent-review.ts
 * `confirmedHash`). A standing assignment is left alone, and nothing ends
 * while Orbit Agents is off.
 */
async function completeOneOff(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  runId: string,
) {
  // With Orbit Agents off, runs end AGENTS_DISABLED; that must not end the assignment.
  if (!agentsEnabled()) return;
  const row = await entity(tx, scope, "assignments", assignmentId);
  const a = data(row);
  if (a.status !== "active" || a.schedule?.rhythm !== "once") return;
  await update(tx, scope, row, {
    ...a,
    status: "ended",
    completedAt: new Date().toISOString(),
  });
  await audit(tx, scope, "assignment.completed", row.id, { runId });
}

/**
 * Cancels one run that is not over: its open steps and `agent_tasks` become
 * `canceled`, so no new step starts and its slots no longer hold. With a
 * `code` (e.g. `SLOT_UNAVAILABLE`) the run records it and releases its slots
 * with that reason. Settled work and its cost stay. Returns whether it
 * canceled anything.
 */
async function cancelRun(
  tx: DbTx,
  scope: Scope,
  runId: string,
  code: string | null = null,
) {
  await lockRun(tx, scope, runId);
  const row = await entity(tx, scope, RUNS, runId);
  const d = data(row);
  if (TERMINAL_RUN.includes(d.status)) return false;
  const tasks = await filtered(tx, scope, TASKS, [
    { path: ["runId"], equals: row.id },
  ]);
  for (const task of tasks)
    if (["queued", "running"].includes(data(task).status))
      await update(tx, scope, task, {
        ...data(task),
        status: "canceled",
        ...(code ? { errorCode: code } : {}),
      });
  const now = new Date().toISOString();
  await update(tx, scope, row, {
    ...d,
    status: "canceled",
    steps: (d.steps as WorkStep[]).map((step) =>
      SETTLED.includes(step.status) ? step : { ...step, status: "canceled" },
    ),
    ...(code
      ? {
          errorCode: code,
          slots: ((d.slots ?? []) as Array<Record<string, any>>).map((slot) =>
            slot.publicationId || slot.releasedAt
              ? slot
              : { ...slot, releasedAt: now, releaseReason: code },
          ),
        }
      : {}),
  });
  await audit(tx, scope, "assignment.run_canceled", row.id, {
    assignmentId: d.assignmentId,
    ...(code ? { code } : {}),
  });
  return true;
}

/**
 * Cancels the runs of an assignment that is paused, ended or changed: every
 * run that is not over becomes `canceled` with its open steps and
 * `agent_tasks`, so no new step starts and its slots are free again. Settled
 * work and its cost stay. Scheduled publications are withdrawn by
 * `withdrawAssignmentPublications` (veto.ts).
 */
export async function cancelAssignmentRuns(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
) {
  const open = (await runsMatching(tx, scope, { assignmentId })).filter(
    (run) => !TERMINAL_RUN.includes(data(run).status),
  );
  let canceled = 0;
  for (const found of open)
    if (await cancelRun(tx, scope, found.id)) canceled++;
  return { canceled };
}

const PENDING_JOB = ["queued", "running", "retry_scheduled"];

/**
 * Puts an agent task held back by a project pause back on the `agent`
 * queue, once: nothing happens while a job of the task is still pending. A
 * job the worker blocked with `PROJECT_PAUSED` is queued again; otherwise a
 * new job `agent:<taskId>:resume:<generation>` is created (the project's
 * generation changes with every pause and resume). `runAgentTask` itself
 * never repeats a paid call, so a requeued task that had sent one ends
 * failed or `outcome_unknown` instead of running again.
 */
export async function requeueAgentTask(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  generation: number,
  options: { fromCurrentJob?: boolean } = {},
) {
  const jobs = await filtered(tx, scope, "jobs", [
    { path: ["topic"], equals: "agent" },
    { path: ["resourceId"], equals: taskId },
  ]);
  // Called from the task's own job, its running job is the caller and ends right after.
  const pending = options.fromCurrentJob
    ? PENDING_JOB.filter((status) => status !== "running")
    : PENDING_JOB;
  if (jobs.some((job) => pending.includes(data(job).status))) return false;
  const blocked = jobs.find(
    (job) =>
      data(job).status === "blocked_dependency" &&
      data(job).error === "PROJECT_PAUSED",
  );
  if (blocked) {
    await update(tx, scope, blocked, {
      ...data(blocked),
      status: "queued",
      error: null,
      leaseUntil: null,
    });
    await tx.outbox.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        topic: "agent",
        entityId: blocked.id,
        payload: { jobId: blocked.id },
      },
    });
    return true;
  }
  await enqueue(
    tx,
    scope,
    "agent",
    taskId,
    `agent:${taskId}:resume:${generation}`,
  );
  return true;
}

/**
 * On resume (pauseProject with `paused: false`, I7b): the worker blocked
 * agent jobs while the project was paused and a specialist stopped by the
 * pause before its first paid call went back to `queued`. For every open
 * run: when all of its slots have passed, the run is canceled with
 * `SLOT_UNAVAILABLE` and its slots are released; otherwise its queued tasks
 * (and running tasks whose job the pause blocked) are requeued. Idempotent.
 */
export async function resumeAgentTasks(
  tx: DbTx,
  scope: Scope,
  generation: number,
  now = new Date(),
) {
  if (!agentsEnabled()) return { requeued: 0, canceled: 0 };
  const runs = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: RUNS,
      OR: (["planned", "running"] as RunStatus[]).map((status) => ({
        data: { path: ["status"], equals: status },
      })),
    },
    orderBy: { createdAt: "asc" },
  });
  let requeued = 0;
  let canceled = 0;
  for (const run of runs) {
    const slots = (data(run).slots ?? []) as Array<{ at: string }>;
    if (
      slots.length &&
      slots.every((slot) => Date.parse(slot.at) <= now.valueOf())
    ) {
      if (await cancelRun(tx, scope, run.id, SLOT_UNAVAILABLE)) {
        canceled++;
        // A one-off whose only slot passed has nothing left to do.
        await completeOneOff(tx, scope, data(run).assignmentId, run.id);
      }
      continue;
    }
    for (const task of await filtered(tx, scope, TASKS, [
      { path: ["runId"], equals: run.id },
    ])) {
      const status = data(task).status;
      if (status === "running") {
        // Only a running task whose job the pause blocked; a live worker may hold the others.
        const jobs = await filtered(tx, scope, "jobs", [
          { path: ["topic"], equals: "agent" },
          { path: ["resourceId"], equals: task.id },
        ]);
        if (
          !jobs.some(
            (job) =>
              data(job).status === "blocked_dependency" &&
              data(job).error === "PROJECT_PAUSED",
          )
        )
          continue;
      } else if (status !== "queued") continue;
      if (await requeueAgentTask(tx, scope, task.id, generation)) requeued++;
    }
  }
  return { requeued, canceled };
}

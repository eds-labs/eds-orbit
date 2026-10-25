import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { runStructured } from "../../../platform/agents/structured-run.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { notifyMembers } from "../../../platform/notifications/members.ts";
import { audit, DomainError } from "../../../shared.ts";
import { assignableIds, uuid, workDomainEvent } from "../common.ts";
import { pmActive, requirePm } from "../gate.ts";
import { assertPmBudget, PM_BUDGET_CATEGORY } from "./budget.ts";
import { initiativeContext, projectToday } from "./context.ts";
import { REPORTER_INSTRUCTIONS } from "./instructions.ts";
import { pmSnapshot } from "./monitor.ts";
import { PM_QUEUE, pmActor } from "./planner.ts";
import { evaluateRules, stateHash } from "./rules.ts";
import { getPmState } from "./state.ts";

// Status reports (plan §2.5): on request or on the initiative's schedule
// (Q-P2-2: weekly on Monday 08:00 in the project's timezone, off until
// enabled). A report is skipped when the state the AI would see is the
// one the last report saw, and when the PM's daily budget is spent.

const text = (max: number) =>
  z.string().refine((v) => v.trim().length > 0 && v.length <= max, `1 to ${max} characters`);

export const reportSchema = z
  .object({
    summary: text(3000),
    health: z.enum(["on_track", "at_risk", "off_track"]),
    risks: z
      .array(z.object({ text: text(300), severity: z.enum(["low", "medium", "high"]) }).strict())
      .max(10),
    nextSteps: z.array(text(300)).max(10),
  })
  .strict();
export type ReportOutput = z.infer<typeof reportSchema>;

const REPORTER_LIMITS = {
  maxModelCalls: 2,
  maxToolCalls: 1,
  maxWebSearches: 0,
  timeoutMs: 90_000,
  maxInputBytes: 80_000,
};
const REPORT_HOUR = 8;

export type ReportRow = Awaited<ReturnType<DbTx["workPmReport"]["findFirstOrThrow"]>>;

export function reportView(row: ReportRow) {
  return {
    id: row.id,
    initiativeId: row.initiativeId,
    kind: row.kind,
    body: row.body,
    data: row.data as ReportOutput,
    stateHash: row.stateHash,
    costMicros: Number(row.costMicros),
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    /** The UI labels the text as AI-generated. */
    generated: true,
  };
}

export function renderReport(r: ReportOutput) {
  const health = { on_track: "On track", at_risk: "At risk", off_track: "Off track" }[r.health];
  return [
    `**${health}**`,
    r.summary,
    r.risks.length ? `## Risks\n${r.risks.map((x) => `- ${x.text} (${x.severity})`).join("\n")}` : "",
    r.nextSteps.length ? `## Next steps\n${r.nextSteps.map((x) => `- ${x}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20000);
}

/** The initiative's current state hash, as the monitor computes it. */
async function currentHash(tx: DbTx, scope: Scope, initiativeId: string, now: Date) {
  const snapshot = await pmSnapshot(tx, scope, initiativeId, now);
  return stateHash(snapshot, evaluateRules(snapshot));
}

async function latestReport(tx: DbTx, scope: Scope, initiativeId: string) {
  return tx.workPmReport.findFirst({
    where: { projectId: scope.projectId, initiativeId, kind: "status_report" },
    orderBy: { createdAt: "desc" },
  });
}

async function liveInitiative(tx: DbTx, scope: Scope, initiativeId: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(initiativeId) },
    select: { id: true, archivedAt: true },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  if (row.archivedAt) throw new DomainError("WORK_INITIATIVE_ARCHIVED", 409);
  return row;
}

/**
 * Asks for a report now. Returns the latest report when nothing changed
 * since it, otherwise queues one report job for this state.
 */
export async function requestReport(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  now = new Date(),
) {
  await requirePm(tx, scope);
  const initiative = await liveInitiative(tx, scope, initiativeId);
  const hash = await currentHash(tx, scope, initiative.id, now);
  const last = await latestReport(tx, scope, initiative.id);
  if (last?.stateHash === hash) return { status: "unchanged" as const, report: reportView(last) };
  await assertPmBudget(tx, scope, 1, now);
  await enqueue(tx, scope, PM_QUEUE, initiative.id, `work_pm:report:${initiative.id}:${hash}`, now, {
    kind: "report",
    requestedBy: scope.userId,
  });
  return { status: "queued" as const, report: null };
}

/** The `report` job: one structured run unless the state is unchanged. */
export async function runReportJob(
  workerScope: Scope,
  initiativeId: string,
  job: { requestedBy?: string },
  now = new Date(),
) {
  const prepared = await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    if (!(await pmActive(tx, workerScope))) return null;
    const initiative = await tx.workInitiative.findFirst({
      where: { projectId: workerScope.projectId, id: initiativeId, archivedAt: null },
      select: { id: true },
    });
    if (!initiative) return null;
    const hash = await currentHash(tx, workerScope, initiativeId, now);
    if ((await latestReport(tx, workerScope, initiativeId))?.stateHash === hash) return null;
    return { hash, context: await initiativeContext(tx, workerScope, initiativeId, now) };
  });
  if (!prepared) return { status: "skipped" };
  const key = `work_pm:report:${initiativeId}:${prepared.hash}`;
  const result = await runStructured(workerScope, {
    agentName: "work.pm_reporter",
    taskClass: "pm_analysis",
    kind: "work_pm",
    subject: { type: "work.initiative", id: initiativeId },
    instructions: REPORTER_INSTRUCTIONS.text,
    input: prepared.context,
    tools: [],
    outputSchema: reportSchema,
    limits: REPORTER_LIMITS,
    budget: {
      category: PM_BUDGET_CATEGORY,
      runKey: key,
      callKey: key,
      check: (tx, s, estimate, at) => assertPmBudget(tx, s, estimate, at),
    },
    guard: (tx, s) => requirePm(tx, s),
  });
  return scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    if (result.status !== "ok") {
      await audit(tx, workerScope, "work.pm.report_failed", initiativeId, { code: result.code });
      return { status: result.status, code: result.code };
    }
    const report = await tx.workPmReport.create({
      data: {
        id: randomUUID(),
        workspaceId: workerScope.workspaceId,
        projectId: workerScope.projectId,
        initiativeId,
        kind: "status_report",
        stateHash: prepared.hash,
        body: renderReport(result.output),
        data: result.output as Prisma.InputJsonValue,
        agentRunId: result.agentRunId,
        costMicros: BigInt(result.costMicros),
        requestedBy: job.requestedBy ?? null,
      },
    });
    await tx.workPmState.updateMany({
      where: { projectId: workerScope.projectId, initiativeId },
      data: { lastReportAt: now, lastReportHash: prepared.hash },
    });
    const initiative = await tx.workInitiative.findFirstOrThrow({
      where: { projectId: workerScope.projectId, id: initiativeId },
      select: { key: true, ownerUserId: true },
    });
    const state = await getPmState(tx, workerScope, initiativeId);
    const allowed = await assignableIds(workerScope);
    const to = [...new Set([initiative.ownerUserId, job.requestedBy, ...state.settings.escalateTo])].filter(
      (u): u is string => !!u && allowed.has(u),
    );
    if (to.length) {
      await notifyMembers(tx, workerScope, {
        kind: "work_pm_report",
        userIds: to,
        title: `${initiative.key}: status report`,
        body: "",
        link: `/p/${workerScope.projectId}/work/initiatives?initiative=${initiativeId}`,
      });
      await tx.workPmReport.update({ where: { id: report.id }, data: { publishedTo: to } });
    }
    await audit(tx, workerScope, "work.pm.report_created", report.id, { initiativeId, notified: to.length });
    await workDomainEvent(tx, workerScope, "work.pm.report.created", { type: "work.initiative", id: initiativeId }, pmActor, {
      reportId: report.id,
    });
    return { status: "created", reportId: report.id };
  });
}

/** The UTC offset of a timezone at an instant, in minutes. */
function offsetMinutes(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant of `hour`:00 on a local date in a timezone. */
export function zonedTime(date: string, hour: number, timezone: string) {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  try {
    return new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60_000);
  } catch {
    return guess;
  }
}

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The next scheduled report time after `now`, or null when reports are off. */
export function nextReportAt(
  schedule: "off" | "weekly" | "daily",
  timezone: string,
  now = new Date(),
) {
  if (schedule === "off") return null;
  let date = projectToday(timezone, now);
  for (let i = 0; i < 8; i++, date = addDays(date, 1)) {
    const at = zonedTime(date, REPORT_HOUR, timezone);
    if (at <= now) continue;
    // Weekly reports on Monday (Q-P2-2).
    if (schedule === "weekly" && new Date(`${date}T12:00:00Z`).getUTCDay() !== 1) continue;
    return { at, date };
  }
  return null;
}

/** Queues the next scheduled report of every watched initiative that has one. */
export async function scheduleReports(tx: DbTx, scope: Scope, now = new Date()) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { timezone: true },
  });
  const states = await tx.workPmState.findMany({
    where: { projectId: scope.projectId, enabled: true },
    select: { initiativeId: true },
  });
  let queued = 0;
  for (const { initiativeId } of states) {
    const state = await getPmState(tx, scope, initiativeId);
    const next = nextReportAt(state.settings.reportSchedule, project.timezone, now);
    if (!next) continue;
    await enqueue(tx, scope, PM_QUEUE, initiativeId, `work_pm:report:${initiativeId}:scheduled:${next.date}`, next.at, {
      kind: "report",
    });
    queued++;
  }
  return queued;
}

export async function listReports(tx: DbTx, scope: Scope, initiativeId?: string) {
  const rows = await tx.workPmReport.findMany({
    where: { projectId: scope.projectId, ...(initiativeId ? { initiativeId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return rows.map(reportView);
}

export async function loadReport(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.workPmReport.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(id) },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return reportView(row);
}

import { randomUUID } from "node:crypto";
import type { AgentTemplate } from "../../platform/agents/definitions/templates.ts";
import { readAgentDefinition } from "../../platform/agents/definitions/store.ts";
import type { EventSubscription } from "../../platform/events/types.ts";
import { notifyMembers } from "../../platform/notifications/members.ts";
import { proactiveEnabled } from "../../platform/proactive/preferences.ts";
import type { SignalDefinition } from "../../platform/signals/types.ts";
import { audit } from "../../shared.ts";
import { initiativePath, taskPath } from "./common.ts";
import { REPORTER_INSTRUCTIONS } from "./pm/instructions.ts";
import { watcherIds } from "./notifications.ts";

// Work's proactive signals (ADR 0023, plan §2.2 and §2.5):
// - `work.task_completed`: the creator of a task hears when it is done.
//   Watchers already get `work_task_watched` for every status change, so
//   they are left out (nothing is notified twice).
// - `work.task_due_soon`: a mapping of the existing daily due-date notice
//   `work_task_due` (due within the project's `dueSoonDays` or overdue);
//   no second detector.
// - The agent template `work.weekly_report` (plan §2.5 "project reports"):
//   a configured agent in a business project with a weekly schedule and
//   Work read tools, using the AI PM reporter's instructions. When one of
//   its work orders finishes, the summary becomes a Work report of the
//   initiative it was run for, and its sponsor and the initiative's owner
//   get a deduplicated `work_pm_report` notice.

export const WEEKLY_REPORT_TEMPLATE = "work.weekly_report";

export const workSignalNotifications = {
  work_task_completed: {
    label: { en: "A task I created was completed", de: "Eine von mir erstellte Aufgabe ist erledigt" },
    emailDefault: false,
    proactive: true,
  },
} as const;

export const taskCompletedSignal: SignalDefinition = {
  key: "work.task_completed",
  kind: "work_task_completed",
  title: { en: "Completed tasks I created", de: "Erledigte Aufgaben, die ich erstellt habe" },
  titles: { completed: { en: "Task #{number} is done", de: "Aufgabe #{number} ist erledigt" } },
  source: { event: ["work.task.status_changed"] },
  async detect(tx, scope, input) {
    if (!("event" in input)) return [];
    const { event } = input;
    if (event.data.toCategory !== "done" || event.data.fromCategory === "done") return [];
    const task = await tx.workTask.findFirst({
      where: { id: event.subject.id, projectId: scope.projectId },
      select: { id: true, number: true, createdBy: true },
    });
    if (!task) return [];
    const watchers = new Set(await watcherIds(tx, scope, task.id));
    const to = [task.createdBy].filter((u) => u && u !== event.actor.id && !watchers.has(u));
    if (!to.length) return [];
    return [
      {
        fingerprint: `task_completed:${task.id}`,
        recipients: { userIds: to },
        severity: "info",
        titleKey: "completed",
        params: { number: task.number },
        link: taskPath(scope.projectId, task.id),
      },
    ];
  },
};

export const taskDueSoonSignal: SignalDefinition = {
  key: "work.task_due_soon",
  kind: "work_task_due",
  title: { en: "My tasks due soon or overdue", de: "Meine bald oder überfälligen Aufgaben" },
  source: { kinds: { work_task_due: "attention" } },
};

export const workSignals: readonly SignalDefinition[] = [taskCompletedSignal, taskDueSoonSignal];

export const weeklyReportTemplate: AgentTemplate = {
  key: WEEKLY_REPORT_TEMPLATE,
  title: { en: "Weekly project report", de: "Wöchentlicher Projektbericht" },
  summary: {
    en: "Writes a short status report every week from the initiatives, milestones and tasks. Reads only; never changes anything.",
    de: "Schreibt jede Woche einen kurzen Statusbericht aus Vorhaben, Meilensteinen und Aufgaben. Liest nur und ändert nichts.",
  },
  defaults: {
    name: "Weekly report",
    description: "A weekly status report of the project's work.",
    instructions: "",
    modules: ["work"],
    tools: ["work_list_initiatives", "work_search_tasks", "work_progress", "work_get_task"],
    knowledge: null,
    mode: "read",
    model: { override: null },
    limits: { maxModelCalls: 4, maxToolCalls: 8, wallSeconds: 120, maxRunsPerDay: 5, maxConcurrent: 1 },
    budget: { monthlyCeilingMicros: 2_000_000, runCeilingMicros: 100_000 },
    triggers: [{ kind: "manual" }, { kind: "schedule", rhythm: "weekly", times: ["08:00"], days: [1] }],
    delegateTo: [],
    outputs: { notify: ["sponsor"], onFailure: "notify" },
  },
  guard: {
    maxMode: "read",
    lockedInstructions: `${REPORTER_INSTRUCTIONS.text} Put the report in the summary field of your answer, with outcome done.`,
  },
};

/**
 * Stores a finished weekly-report work order as a Work report of its
 * initiative and tells its sponsor and the initiative's owner. Only while
 * ORBIT_PROACTIVE is on (no job is queued otherwise).
 */
export const weeklyReportSubscriber: EventSubscription = {
  name: "work.weekly_report_results",
  types: ["platform.agent.work_order.finished"],
  enabled: proactiveEnabled,
  async handler(tx, scope, event) {
    if (!proactiveEnabled()) return;
    const row = await tx.agentWorkOrder.findFirst({
      where: { id: event.subject.id, projectId: scope.projectId },
    });
    if (!row?.agentId || row.status !== "succeeded") return;
    const stored = await readAgentDefinition(tx, scope, row.agentId).catch(() => null);
    if (stored?.definition.active?.templateKey !== WEEKLY_REPORT_TEMPLATE) return;
    const summary = String((row.result as { summary?: unknown } | null)?.summary ?? "").trim();
    if (!summary) return;
    const initiative =
      row.subjectType === "work.initiative" && row.subjectId
        ? await tx.workInitiative.findFirst({
            where: { projectId: scope.projectId, id: row.subjectId },
            select: { id: true, ownerUserId: true },
          })
        : null;
    if (initiative && !(await tx.workPmReport.findFirst({ where: { projectId: scope.projectId, stateHash: `work_order:${row.id}` } })))
      await tx.workPmReport.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          initiativeId: initiative.id,
          // The kinds are fixed by a check constraint; the source says which template wrote it.
          kind: "status_report",
          stateHash: `work_order:${row.id}`,
          body: summary.slice(0, 3000),
          data: { source: WEEKLY_REPORT_TEMPLATE, workOrderId: row.id, agentId: row.agentId },
          costMicros: row.spentMicros,
          requestedBy: row.sponsorUserId,
        },
      });
    await audit(tx, scope, "work.weekly_report.stored", row.id, {
      agentId: row.agentId,
      initiativeId: initiative?.id ?? null,
    });
    const to = [...new Set([row.sponsorUserId, initiative?.ownerUserId])].filter((u): u is string => Boolean(u));
    if (to.length)
      await notifyMembers(tx, scope, {
        kind: "work_pm_report",
        userIds: to,
        title: "Weekly project report ready",
        link: initiative
          ? initiativePath(scope.projectId, initiative.id)
          : `/p/${scope.projectId}/agents/${row.agentId}/executions/${row.id}`,
        dedupeKey: `weekly_report:${row.id}`,
        severity: "info",
      });
  },
};

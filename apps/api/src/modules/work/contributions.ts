import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { workAttention, workDueScan } from "./attention.ts";
import { pmSwitchedOn, workSwitchedOn } from "./gate.ts";
import { pmInstructions, pmTools } from "./pm/tools.ts";
import { pmMcpActionTypes, pmMcpTools } from "./pm/mcp-tools.ts";
import { workLinkTypes } from "./links.ts";
import { workUserNotifications } from "./notifications.ts";
import { workRoutes } from "./routes.ts";
import { workActionTypes, workInstructions, workTools } from "./tools.ts";
import { pmActionTypes } from "./pm/apply.ts";
import { pmJobs } from "./pm/jobs.ts";
import { pmDailyScan, pmMonitorSubscriber } from "./pm/monitor.ts";
import { handoffActionTypes, handoffLinkType, handoffSyncSubscriber } from "./pm/handoffs.ts";
import { pmHandoffTargets } from "./pm/research.ts";
import { taskFromIssue } from "./issue-handoff.ts";
import { CODING_DISPATCH, codingDispatchAction, codingRunLinkType, codingTimeouts } from "./pm/coding.ts";
import { CODING_EVENT, codingResultHandler } from "./pm/coding-dispatch.ts";

/** The domain events the module publishes (ADR 0016): ids and keys only. */
export const WORK_EVENTS = [
  "work.initiative.created",
  "work.initiative.updated",
  "work.initiative.archived",
  "work.initiative.restored",
  "work.initiative.deleted",
  "work.milestone.created",
  "work.milestone.updated",
  "work.milestone.deleted",
  "work.task.created",
  "work.task.updated",
  "work.task.status_changed",
  "work.task.assigned",
  "work.task.archived",
  "work.task.restored",
  "work.task.deleted",
  "work.task.dependency_changed",
  "work.task.commented",
  // AI project manager (ADR 0017).
  "work.pm.plan.applied",
  "work.pm.finding.opened",
  "work.pm.finding.resolved",
  "work.pm.report.created",
  "work.coding_run.dispatched",
  "work.coding_run.started",
  "work.coding_run.succeeded",
  "work.coding_run.failed",
  "work.coding_run.outcome_unknown",
  "work.coding_run.canceled",
] as const;

/** What the project management module plugs into the platform. */
export const workContributions: ModuleContributions = {
  available: workSwitchedOn,
  unavailableCode: "WORK_DISABLED",
  routes: workRoutes,
  linkTypes: { ...workLinkTypes, handoff: handoffLinkType, coding_run: codingRunLinkType },
  // Research and analysis of a task by the AI project manager (ADR 0017),
  // and a task from an issue of the issue center (ADR 0018).
  handoffs: { ...pmHandoffTargets, task_from_issue: taskFromIssue },
  // Results of the coding agent workflow's callbacks (WP2.9).
  automationResults: { [CODING_EVENT]: codingResultHandler },
  // The AI project manager's monitor wakes on task and milestone changes.
  events: { publishes: WORK_EVENTS, subscribes: [pmMonitorSubscriber, handoffSyncSubscriber] },
  userNotifications: workUserNotifications,
  attention: workAttention,
  // Assistant and MCP reads and proposals (plan §6).
  tools: [...workTools, ...pmTools, ...pmMcpTools],
  actionTypes: {
    ...workActionTypes,
    ...pmActionTypes,
    ...handoffActionTypes,
    [CODING_DISPATCH]: codingDispatchAction,
    ...pmMcpActionTypes,
  },
  // The AI project manager's background work (ADR 0017).
  jobs: pmJobs,
  assistant: {
    features: ({ all }) => ["work", ...(all || pmSwitchedOn() ? (["work_pm"] as const) : [])],
    instructions: ({ all }) => [...workInstructions, ...(all || pmSwitchedOn() ? pmInstructions : [])],
  },
  // Due-date notices once a day per project (plan §4.6).
  periodic: [workDueScan, pmDailyScan, codingTimeouts],
};

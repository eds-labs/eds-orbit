import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { workAttention, workDueScan } from "./attention.ts";
import { workSwitchedOn } from "./gate.ts";
import { workLinkTypes } from "./links.ts";
import { workUserNotifications } from "./notifications.ts";
import { workRoutes } from "./routes.ts";
import { workActionTypes, workInstructions, workTools } from "./tools.ts";
import { pmActionTypes } from "./pm/apply.ts";
import { pmJobs } from "./pm/jobs.ts";
import { pmDailyScan, pmMonitorSubscriber } from "./pm/monitor.ts";

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
] as const;

/** What the project management module plugs into the platform. */
export const workContributions: ModuleContributions = {
  available: workSwitchedOn,
  unavailableCode: "WORK_DISABLED",
  routes: workRoutes,
  linkTypes: workLinkTypes,
  // The AI project manager's monitor wakes on task and milestone changes.
  events: { publishes: WORK_EVENTS, subscribes: [pmMonitorSubscriber] },
  userNotifications: workUserNotifications,
  attention: workAttention,
  // Assistant and MCP reads and proposals (plan §6).
  tools: workTools,
  actionTypes: { ...workActionTypes, ...pmActionTypes },
  // The AI project manager's background work (ADR 0017).
  jobs: pmJobs,
  assistant: {
    features: () => ["work"],
    instructions: () => workInstructions,
  },
  // Due-date notices once a day per project (plan §4.6).
  periodic: [workDueScan, pmDailyScan],
};

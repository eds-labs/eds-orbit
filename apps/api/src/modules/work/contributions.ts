import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { workSwitchedOn } from "./gate.ts";
import { workLinkTypes } from "./links.ts";
import { workUserNotifications } from "./notifications.ts";

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
] as const;

/** What the project management module plugs into the platform. */
export const workContributions: ModuleContributions = {
  available: workSwitchedOn,
  unavailableCode: "WORK_DISABLED",
  linkTypes: workLinkTypes,
  events: { publishes: WORK_EVENTS },
  userNotifications: workUserNotifications,
};

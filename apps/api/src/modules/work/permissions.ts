import { permission } from "../../platform/tenancy/permissions.ts";

// Project management permissions (ADR 0016, plan §4.2). Viewers read only
// (Q-P1-3); module roles may narrow them per member.

export const WORK_READ = permission(
  "work.read",
  "Read initiatives, milestones and tasks",
  ["owner", "editor", "viewer"],
);
export const WORK_WRITE = permission(
  "work.write",
  "Create and change initiatives, milestones, tasks and comments",
  ["owner", "editor"],
);
export const WORK_DELETE = permission(
  "work.delete",
  "Delete initiatives, milestones and tasks",
  ["owner"],
);
export const WORK_SETTINGS = permission(
  "work.settings",
  "Manage the workflow, categories and teams",
  ["owner"],
);

export const workPermissions = [
  WORK_READ,
  WORK_WRITE,
  WORK_DELETE,
  WORK_SETTINGS,
];

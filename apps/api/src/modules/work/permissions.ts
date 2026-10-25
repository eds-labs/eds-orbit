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

// AI project manager (ADR 0017, plan §4.2).
export const WORK_PM_USE = permission(
  "work.pm.use",
  "Ask the AI project manager for plans, reports, analyses and handoffs",
  ["owner", "editor"],
);
export const WORK_PM_APPLY = permission(
  "work.pm.apply",
  "Decide the AI project manager's plans and task changes",
  ["owner", "editor"],
);
export const WORK_PM_MANAGE = permission(
  "work.pm.manage",
  "Manage the AI project manager's settings, budgets and repositories",
  ["owner"],
);
// Owner-only: a dispatch sends a brief to an external coding system.
export const WORK_CODING_DISPATCH = {
  ...permission(
    "work.coding.dispatch",
    "Approve dispatching coding work orders to external coding agents",
    ["owner"],
  ),
  sensitive: true,
};

export const workPermissions = [
  WORK_READ,
  WORK_WRITE,
  WORK_DELETE,
  WORK_SETTINGS,
  WORK_PM_USE,
  WORK_PM_APPLY,
  WORK_PM_MANAGE,
  WORK_CODING_DISPATCH,
];

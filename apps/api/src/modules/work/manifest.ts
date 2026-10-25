import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { workPermissions } from "./permissions.ts";

/**
 * The project management module (ADR 0016): initiatives ("Vorhaben"),
 * milestones, tasks, subtasks and checklists. Off for every project until
 * an owner enables it, and unreachable while ORBIT_WORK is off.
 */
export const workModule: ServerModule = {
  id: "work",
  version: "1.0.0",
  displayName: { en: "Project management", de: "Projektmanagement" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "WorkInitiative",
    "WorkMilestone",
    "WorkTaskCounter",
    "WorkTask",
    "WorkChecklistItem",
    "WorkTaskDependency",
    "WorkComment",
    "WorkAttachment",
    "WorkTaskWatcher",
    "WorkEvent",
    "WorkPmState",
    "WorkPlanProposal",
    "WorkPmFinding",
    "WorkPmReport",
    "WorkCodingRun",
    "WorkHandoff",
  ],
  permissions: workPermissions,
};

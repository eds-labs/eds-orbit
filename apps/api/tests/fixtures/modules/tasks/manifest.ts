import type {
  PermissionDef,
  ServerModule,
} from "../../../../../../packages/module-contracts/src/index.ts";

// A third module that exists only in tests (WP4.1): it proves that a module
// plugs in through the contracts alone. Never registered in production.

export const TASKS_READ: PermissionDef = {
  key: "tasks.read",
  description: "Read fixture tasks",
  defaultRoles: ["owner", "editor", "viewer"],
};
export const TASKS_MANAGE: PermissionDef = {
  key: "tasks.manage",
  description: "Propose and decide fixture tasks",
  defaultRoles: ["owner", "editor"],
};

export const tasksModule: ServerModule = {
  id: "tasks",
  version: "1.0.0",
  displayName: { en: "Tasks", de: "Aufgaben" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [
    { kind: "fixture_tasks", description: "Fixture tasks", collection: true },
  ],
  tables: [],
  permissions: [TASKS_READ, TASKS_MANAGE],
};

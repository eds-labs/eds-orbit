import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { issuesPermissions } from "./permissions.ts";

/**
 * The issue center (ADR 0018): product issues that aggregate reports from
 * Support, manual entry and signed webhooks, link implementing tasks and
 * track deliveries up to the production release. Off for every project
 * until an owner enables it, and unreachable while ORBIT_ISSUES is off.
 */
export const issuesModule: ServerModule = {
  id: "issues",
  version: "1.0.0",
  displayName: { en: "Issues", de: "Issues" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [],
  permissions: issuesPermissions,
};

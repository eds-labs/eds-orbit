import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { issuesSwitchedOn } from "./gate.ts";

/** What the issue center plugs into the platform. */
export const issuesContributions: ModuleContributions = {
  available: issuesSwitchedOn,
  unavailableCode: "ISSUES_DISABLED",
};

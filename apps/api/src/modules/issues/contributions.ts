import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { issuesSwitchedOn } from "./gate.ts";
import { issuesLinkTypes } from "./links.ts";

/** The domain events the module publishes (ADR 0018): ids and keys only. */
export const ISSUES_EVENTS = [
  "issues.report.received",
  "issues.issue.created",
  "issues.issue.updated",
  "issues.issue.status_changed",
  "issues.issue.merged",
  "issues.issue.released",
  "issues.issue.closed",
  "issues.delivery.recorded",
] as const;

/** What the issue center plugs into the platform. */
export const issuesContributions: ModuleContributions = {
  available: issuesSwitchedOn,
  unavailableCode: "ISSUES_DISABLED",
  linkTypes: issuesLinkTypes,
  events: { publishes: ISSUES_EVENTS },
};

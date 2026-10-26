import { permission } from "../../platform/tenancy/permissions.ts";

// Issue center permissions (ADR 0018, plan §2.8). Viewers read redacted
// issues only; module roles may narrow them per member, which keeps
// developers out of Support (Q-P3-1).

export const ISSUES_READ = permission(
  "issues.read",
  "Read issues, their redacted reports and the dashboard",
  ["owner", "editor", "viewer"],
);
export const ISSUES_REPORT = permission(
  "issues.report",
  "Report issues and attach reports",
  ["owner", "editor"],
);
export const ISSUES_TRIAGE = permission(
  "issues.triage",
  "Triage issues: fields, status, assignment, duplicates and task links",
  ["owner", "editor"],
);
// Diagnostics carry source details (environment, release, error codes).
export const ISSUES_DIAGNOSTICS_READ = {
  ...permission(
    "issues.diagnostics.read",
    "Read the diagnostics and source details of reports",
    ["owner", "editor"],
  ),
  sensitive: true,
};
// Owner-only: GitHub issues leave Orbit (WP3.10, after the MVP).
export const ISSUES_GITHUB = {
  ...permission(
    "issues.github",
    "Create GitHub issues and configure repositories",
    ["owner"],
  ),
  sensitive: true,
};
export const ISSUES_SETTINGS = permission(
  "issues.settings",
  "Manage components, sources, thresholds and automation",
  ["owner"],
);

export const issuesPermissions = [
  ISSUES_READ,
  ISSUES_REPORT,
  ISSUES_TRIAGE,
  ISSUES_DIAGNOSTICS_READ,
  ISSUES_GITHUB,
  ISSUES_SETTINGS,
];

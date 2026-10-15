import {
  actionPermissions,
  permission,
} from "../../platform/tenancy/permissions.ts";

/** Marketing actions (plans/orbit-modularization 04 §2.4). */
export const marketingActionPermissions = actionPermissions("marketing", {
  owner: [
    "approve",
    "approve-and-schedule",
    "archive-mission",
    "asset-status",
    "brand-approval",
    "calendar-block",
    "calendar-unblock",
    "configure-autopilot",
    "configure-matomo-schedule",
    "correct-metric",
    "import-matomo",
    "memory-lifecycle",
    "postiz-assign-channels",
    "postiz-draft-handoff",
    "postiz-draft-resolve",
    "postiz-test-execute",
    "postiz-test-prepare",
    "postiz-test-reconcile",
    "preference-update",
    "resume-live-draft-batch",
    "resume-paused-publications",
    "slack-configure",
    "slack-digest",
    "start-approved-live-draft-batch",
    "start-approved-live-draft-once",
    "stop-experiment",
  ],
  write: [
    "adapt-content",
    "analyze",
    "community-import",
    "community-link",
    "editorial-propose-brief",
    "evaluate-experiment",
    "import-metrics",
    "publish",
    "reconcile",
    "render",
    "retry",
    "review",
    "run-mission",
  ],
  // archive-old-drafts and restore-draft-cleanup refuse every non-owner as
  // their first statement (OWNER_REQUIRED), so the route only needs membership.
  read: ["archive-old-drafts", "preflight", "restore-draft-cleanup"],
});

/** Owner-only writes of the generic collection route. */
export const marketingCollectionPermissions = {
  policies: permission(
    "marketing.policies.write",
    "Change the publishing policy and AI spend mandate",
    ["owner"],
  ),
  preferences: permission(
    "marketing.preferences.write",
    "Record marketing preferences",
    ["owner"],
  ),
};

export const marketingPermissions = [
  ...Object.values(marketingActionPermissions),
  ...Object.values(marketingCollectionPermissions),
];

import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { marketingPermissions } from "./permissions.ts";

/**
 * Transitional manifest (WP1.3): declares what the marketing module owns.
 * Its code still lives in the flat api modules and modules/agents; routes,
 * actions, jobs, tools and settings join the manifest with WP1.6 and WP2.1.
 */
export const marketingModule: ServerModule = {
  id: "marketing",
  version: "1.0.0",
  displayName: { en: "Marketing", de: "Marketing" },
  // Facts and sources must stay maintainable (AD-08).
  dependsOn: ["knowledge"],
  defaultEnabled: true,
  entityKinds: [
    {
      kind: "marketing_topic_reservations",
      description: "Scoped topic and angle holds; no spend authority",
    },
    {
      kind: "marketing_plans",
      description: "Versioned strategic proposals; no execution authority",
      collection: true,
    },
    { kind: "missions", description: "Campaign missions" },
    { kind: "content", description: "Drafts and reviewed content" },
    { kind: "publications", description: "Scheduled and published posts" },
    { kind: "approvals", description: "Content package approvals" },
    {
      kind: "assignments",
      description: "Standing and one-off agent assignments",
    },
    { kind: "assignment_runs", description: "Runs of an assignment" },
    {
      kind: "agent_tasks",
      description: "Specialist steps of an assignment run",
    },
    {
      kind: "assignment_style_descriptions",
      description: "Visual style descriptions per assignment",
    },
    {
      kind: "content_packages",
      description: "Chat-requested multi-channel packages",
    },
    {
      kind: "channel_posts",
      description: "Posts read back from Postiz channels",
    },
    {
      kind: "channel_post_sync",
      description: "Postiz channel history sync state",
    },
    { kind: "postiz_drafts", description: "Draft handoffs to Postiz" },
    { kind: "postiz_queue_watch", description: "Postiz queue health checks" },
    { kind: "postiz_analytics_cache", description: "Cached Postiz analytics" },
    {
      kind: "postiz_analytics_posts",
      description: "Postiz analytics per post",
    },
    {
      kind: "connector_verifications",
      description: "Postiz write verification runs",
    },
    {
      kind: "policies",
      description:
        "Publishing policy and, for now, the AI spend mandate (AD-10)",
    },
    { kind: "metrics", description: "Imported performance metrics" },
    { kind: "insights", description: "Derived marketing insights" },
    { kind: "experiments", description: "Content experiments" },
    { kind: "preferences", description: "Marketing memory preferences" },
    { kind: "calendar_blocks", description: "Blocked calendar periods" },
    { kind: "work_packages", description: "Planned mission work packages" },
    { kind: "followup_plans", description: "Mission follow-up plans" },
    {
      kind: "community_questions",
      description: "Imported community questions",
    },
    { kind: "community_groups", description: "Linked community groups" },
    { kind: "matomo_schedules", description: "Saved Matomo imports" },
    { kind: "slack_actions", description: "Slack approval actions" },
    { kind: "slack_messages", description: "Sent Slack digests" },
    {
      kind: "slack_inbox",
      description: "Slack messages mapped to Orbit users",
    },
    // Brand library; stays marketing-owned with its storage (Q-06).
    { kind: "assets", description: "Brand and generated assets" },
  ],
  tables: ["ProjectMarketingProfile", "ProjectMarketingProfileVersion"],
  permissions: marketingPermissions,
};

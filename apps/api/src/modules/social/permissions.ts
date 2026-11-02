import { permission } from "../../platform/tenancy/permissions.ts";

// Social module permissions (ADR 0020). Composing and requesting a
// publication are editor work; approving it, managing the connected
// accounts and the settings stay with the owner (S-D9).

export const SOCIAL_READ = permission(
  "social.read",
  "Read social accounts, posts and the calendar",
  ["owner", "editor", "viewer"],
);
export const SOCIAL_COMPOSE = permission(
  "social.compose",
  "Create and edit social posts and media",
  ["owner", "editor"],
);
export const SOCIAL_PUBLISH = permission(
  "social.publish",
  "Request that a post is scheduled or published",
  ["owner", "editor"],
);
export const SOCIAL_APPROVE = permission(
  "social.approve",
  "Approve the publication of a social post",
  ["owner"],
);
// Connecting and disconnecting accounts handles their tokens.
export const SOCIAL_ACCOUNTS_MANAGE = {
  ...permission(
    "social.accounts.manage",
    "Connect, check and disconnect social accounts",
    ["owner"],
  ),
  sensitive: true,
};
export const SOCIAL_ANALYTICS_READ = permission(
  "social.analytics.read",
  "Read the metrics of published posts",
  ["owner", "editor", "viewer"],
);
export const SOCIAL_SETTINGS = permission(
  "social.settings",
  "Manage the social module's settings",
  ["owner"],
);

export const socialPermissions = [
  SOCIAL_READ,
  SOCIAL_COMPOSE,
  SOCIAL_PUBLISH,
  SOCIAL_APPROVE,
  SOCIAL_ACCOUNTS_MANAGE,
  SOCIAL_ANALYTICS_READ,
  SOCIAL_SETTINGS,
];

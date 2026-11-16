import { permission } from "../../platform/tenancy/permissions.ts";

// Content module permissions (ADR 0029). Members read; editors write drafts,
// media and taxonomies and ask for publication. Deciding a publication is
// owner and editor work by permission; the project setting
// `publishApprovers` (default `owner_or_editor`, decision E-4) narrows it to
// the owner. Agents, API keys and MCP clients only ever propose. Sites carry
// delivery keys and notifier secrets, so managing them stays with the owner.

export const CMS_READ = permission(
  "cms.read",
  "Read content entries, revisions, media and sites",
  ["owner", "editor", "viewer"],
);
export const CMS_COMPOSE = permission(
  "cms.compose",
  "Create and edit content drafts, media, categories, tags and authors",
  ["owner", "editor"],
);
export const CMS_PUBLISH_REQUEST = permission(
  "cms.publish.request",
  "Ask for content to be published, scheduled, updated or withdrawn",
  ["owner", "editor"],
);
export const CMS_PUBLISH_DECIDE = permission(
  "cms.publish.decide",
  "Approve or reject the publication of content",
  ["owner", "editor"],
);
export const CMS_SITES_MANAGE = {
  ...permission(
    "cms.sites.manage",
    "Manage websites, their routes, notifiers and delivery access",
    ["owner"],
  ),
  sensitive: true,
};
export const CMS_SETTINGS = permission(
  "cms.settings",
  "Manage the content module's settings",
  ["owner"],
);

export const cmsPermissions = [
  CMS_READ,
  CMS_COMPOSE,
  CMS_PUBLISH_REQUEST,
  CMS_PUBLISH_DECIDE,
  CMS_SITES_MANAGE,
  CMS_SETTINGS,
];

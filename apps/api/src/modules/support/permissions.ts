import { permission } from "../../platform/tenancy/permissions.ts";

/** Support permissions (plans/orbit-modularization 06 §2.1, WP5.1). */
export const SUPPORT_TICKETS_READ = permission(
  "support.tickets.read",
  "Read support tickets and inboxes",
  ["owner", "editor", "viewer"],
);
export const SUPPORT_TICKETS_REPLY = permission(
  "support.tickets.reply",
  "Reply to customers",
  ["owner", "editor"],
);
export const SUPPORT_TICKETS_ASSIGN = permission(
  "support.tickets.assign",
  "Assign tickets and change their status",
  ["owner", "editor"],
);
export const SUPPORT_NOTES_READ = permission(
  "support.notes.read",
  "Read internal notes and private support drafts",
  ["owner", "editor"],
);
export const SUPPORT_NOTES_WRITE = permission(
  "support.notes.write",
  "Write internal notes",
  ["owner", "editor"],
);
export const SUPPORT_CONTACTS_MANAGE = permission(
  "support.contacts.manage",
  "Edit and merge support contacts",
  ["owner", "editor"],
);
export const SUPPORT_STATS_READ = permission(
  "support.stats.read",
  "Read support statistics",
  ["owner", "editor", "viewer"],
);
// Owner-only: inboxes set CORS origins and hold widget signing secrets, so
// no module role can grant it.
export const SUPPORT_SETTINGS_MANAGE = {
  ...permission(
    "support.settings.manage",
    "Manage support inboxes and settings",
    ["owner"],
  ),
  sensitive: true,
};

export const supportPermissions = [
  SUPPORT_TICKETS_READ,
  SUPPORT_TICKETS_REPLY,
  SUPPORT_TICKETS_ASSIGN,
  SUPPORT_NOTES_WRITE,
  SUPPORT_NOTES_READ,
  SUPPORT_CONTACTS_MANAGE,
  SUPPORT_STATS_READ,
  SUPPORT_SETTINGS_MANAGE,
];

import { permission } from "../../platform/tenancy/permissions.ts";

// Webmail permissions (ADR 0026). They open the module and its settings only:
// which mailbox a member may touch is decided by WebmailMailboxGrant alone.

export const WEBMAIL_USE = permission(
  "webmail.use",
  "Open the webmail mailboxes granted to the member",
  ["owner", "editor", "viewer"],
);
export const WEBMAIL_SETTINGS = {
  ...permission("webmail.settings", "Open mailboxes for webmail", ["owner"]),
  sensitive: true,
};

export const webmailPermissions = [WEBMAIL_USE, WEBMAIL_SETTINGS];

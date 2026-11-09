import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { webmailPermissions } from "./permissions.ts";

/**
 * The webmail module (ADR 0026): a separately hosted Roundcube opened from
 * Orbit, on the mailboxes Orbit already reads. Off for every project until an
 * owner enables it, and unreachable while ORBIT_WEBMAIL is off.
 */
export const webmailModule: ServerModule = {
  id: "webmail",
  version: "1.0.0",
  displayName: { en: "Webmail", de: "Webmail" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "WebmailMailbox",
    "WebmailMailboxGrant",
    "WebmailSession",
    "WebmailConversion",
  ],
  permissions: webmailPermissions,
};

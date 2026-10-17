import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { supportPermissions } from "./permissions.ts";

/**
 * The support module (Phase 5, plans/orbit-modularization 06): tickets,
 * contacts and inboxes for customer support. Off for every project until an
 * owner enables it, and unreachable while ORBIT_SUPPORT is off.
 */
export const supportModule: ServerModule = {
  id: "support",
  version: "1.0.0",
  displayName: { en: "Support", de: "Support" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "SupportInbox",
    "SupportContact",
    "SupportContactIdentity",
    "SupportTicket",
    "SupportMessage",
    "SupportAttachment",
    "SupportTicketEvent",
    "SupportTicketCounter",
  ],
  permissions: supportPermissions,
};

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { CONNECTION_KIND } from "../../platform/connections/connections.ts";
import { liveSending } from "../../platform/email/connection.ts";
import { mailboxOwner } from "../../platform/email/ownership.ts";
import { registeredPermission } from "../../platform/modules/contributions.ts";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../platform/tenancy/module-roles.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { data, DomainError } from "../../shared.ts";
import type { WebmailCapability } from "./bridge-contract.ts";

// Who may touch which mailbox (ADR 0026, E5). A WebmailMailboxGrant is the
// only authority: no row means no access, for project owners too, who manage
// through WEBMAIL_SETTINGS and may grant themselves. Send, organize and
// convert count only together with read; manage stands alone, so someone can
// administer a mailbox without reading its mail.

export type GrantFlags = {
  canRead: boolean;
  canSend: boolean;
  canOrganize: boolean;
  canConvert: boolean;
  canManage: boolean;
};

export type Capabilities = Record<WebmailCapability | "manage", boolean>;

export const capabilitiesOf = (grant: GrantFlags): Capabilities => ({
  read: grant.canRead,
  send: grant.canRead && grant.canSend,
  organize: grant.canRead && grant.canOrganize,
  convert: grant.canRead && grant.canConvert,
  manage: grant.canManage,
});

/** What changes mail stops while the project is paused or sending is not live. */
export type OperatingState = { live: boolean; paused: boolean };

export async function operatingState(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
): Promise<OperatingState> {
  const project = await tx.project.findUnique({
    where: { id: scope.projectId },
    select: { paused: true },
  });
  return { live: liveSending(), paused: project?.paused !== false };
}

/** The capabilities a session has right now; reading alone survives a stop. */
export function effectiveCapabilities(
  capabilities: Capabilities,
  state: OperatingState,
): Capabilities {
  if (state.live && !state.paused) return capabilities;
  return { ...capabilities, send: false, organize: false, convert: false };
}

export const sessionCapabilities = (
  capabilities: Capabilities,
): WebmailCapability[] =>
  (["read", "send", "organize", "convert"] as const).filter(
    (capability) => capabilities[capability],
  );

// What another module's mailbox requires of a member, on top of the grant.
const OWNER_PERMISSION: Readonly<Record<string, string>> = {
  finance: "finance.settings",
};

/**
 * Whether the member may touch a mailbox another module owns. `fresh` is the
 * member's project scope, never one derived for webmail: a webmail role says
 * nothing about the owning module. An unknown permission refuses.
 */
export function ownerAdmits(
  fresh: Scope,
  connectionData: Record<string, unknown>,
) {
  const owner = mailboxOwner(connectionData);
  const key = owner ? OWNER_PERMISSION[owner] : undefined;
  if (!owner || !key) return true;
  const required = registeredPermission(key);
  if (!required) return false;
  try {
    return can(moduleScope(fresh, owner), required);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

/** The same check from a route's scope, reading a fresh membership when needed. */
export async function memberAdmitted(
  scope: Scope,
  connectionData: Record<string, unknown>,
) {
  if (!mailboxOwner(connectionData)) return true;
  const fresh = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  return fresh !== null && ownerAdmits(fresh, connectionData);
}

export const mailboxNotFound = () =>
  new DomainError("WEBMAIL_MAILBOX_NOT_FOUND", 404);

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** A mailbox of the project with its connection, or null. */
export async function loadMailbox(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  mailboxId: string,
) {
  if (!UUID.test(mailboxId)) return null;
  const mailbox = await tx.webmailMailbox.findFirst({
    where: { id: mailboxId, projectId: scope.projectId },
  });
  if (!mailbox) return null;
  const connection = await tx.entity.findFirst({
    where: {
      id: mailbox.emailConnectionId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: CONNECTION_KIND,
    },
  });
  if (!connection || data(connection).provider !== "email") return null;
  return { mailbox, connection: data(connection) };
}

export function grantOf(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  mailboxId: string,
  userId: string,
) {
  return tx.webmailMailboxGrant.findUnique({
    where: {
      projectId_mailboxId_userId: {
        projectId: scope.projectId,
        mailboxId,
        userId,
      },
    },
  });
}

/**
 * A mailbox the member holds `capability` on. Everything else answers the
 * same 404, so a member learns nothing about mailboxes they may not use.
 */
export async function requireCapability(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  capability: keyof Capabilities,
) {
  const found = await loadMailbox(tx, scope, mailboxId);
  if (!found) throw mailboxNotFound();
  const grant = await grantOf(tx, scope, mailboxId, scope.userId);
  if (!grant) throw mailboxNotFound();
  const capabilities = capabilitiesOf(grant);
  if (!capabilities[capability]) throw mailboxNotFound();
  if (!(await memberAdmitted(scope, found.connection))) throw mailboxNotFound();
  return { ...found, grant, capabilities };
}
